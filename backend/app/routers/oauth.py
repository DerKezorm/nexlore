"""Signing in for MCP with OAuth (block Y), so that AI programs add nexlore as a connector.

A connector finds its way from the 401 of ``/api/mcp``: the protected resource metadata (RFC 9728) names nexlore as
its own authorization server (RFC 8414), the connector registers itself (RFC 7591) and sends its user to nexlore's
consent page with PKCE (S256). The account signs in as always, chooses the level and the spaces, and the code it gets
is traded for tokens once.

What comes out is an MCP key like one made in the interface (``McpKey`` with ``kind="oauth"``): it acts as its
account, has rights per tool, shows in the account's list and is revoked there. Its access token runs out after an
hour and is refreshed with a refresh token that changes every time (an old one is refused). Nothing secret is stored:
only SHA-256 of codes and tokens.

Only public clients with PKCE; redirect addresses only over HTTPS or to the own machine (loopback). Everything here is
off while MCP is off, and the operator can switch connectors off on their own (``mcp_oauth_allowed``).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import threading
import time
from collections import deque
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..errors import error
from ..models import McpKey, OAuthClient, OAuthCode, Space, utcnow
from ..services import mcp, rights, settings_service

logger = logging.getLogger("nexlore.oauth")

router = APIRouter(tags=["oauth"])

CODE_MINUTES = 10
ACCESS_HOURS = 1
REFRESH_PREFIX = "nxr_"
#: Registered clients kept at most; the ones used longest ago go first.
MAX_CLIENTS = 500
#: Registrations per minute, for the whole server: registering needs no account.
REGISTER_PER_MINUTE = 30
LOOPBACK = ("localhost", "127.0.0.1", "[::1]")


def _open(db: Any) -> bool:
    return mcp.allowed(db) and bool(settings_service.get(db, "mcp_oauth_allowed"))


def base_url(request: Request, db: Any) -> str:
    return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _oauth_error(code: str, text: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": code, "error_description": text}, status_code=status,
                        headers={"Cache-Control": "no-store"})


# --- Discovery --------------------------------------------------------------------------------------------------------


def _resource_metadata(request: Request) -> JSONResponse:
    with SessionLocal() as db:
        if not _open(db):
            return JSONResponse({"detail": {"code": "not_found", "message": "Not found."}}, status_code=404)
        base = base_url(request, db)
    return JSONResponse({
        "resource": f"{base}/api/mcp",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["mcp"],
        "resource_name": "nexlore",
    })


@router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
def resource_metadata(request: Request) -> JSONResponse:
    return _resource_metadata(request)


@router.get("/.well-known/oauth-protected-resource/api/mcp", include_in_schema=False)
def resource_metadata_for_mcp(request: Request) -> JSONResponse:
    return _resource_metadata(request)


@router.get("/.well-known/oauth-authorization-server", include_in_schema=False)
def server_metadata(request: Request) -> JSONResponse:
    with SessionLocal() as db:
        if not _open(db):
            return JSONResponse({"detail": {"code": "not_found", "message": "Not found."}}, status_code=404)
        base = base_url(request, db)
    return JSONResponse({
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/api/oauth/token",
        "registration_endpoint": f"{base}/api/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["mcp"],
        "authorization_response_iss_parameter_supported": True,
    })


def challenge_header(request: Request) -> str:
    """What the 401 of /api/mcp says, so that a connector finds where to sign in."""
    with SessionLocal() as db:
        if not _open(db):
            return "Bearer"
        base = base_url(request, db)
    return f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource"'


# --- Registration -----------------------------------------------------------------------------------------------------

_registered: deque[float] = deque()
_registered_lock = threading.Lock()


def _may_register(now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    with _registered_lock:
        while _registered and now - _registered[0] > 60:
            _registered.popleft()
        if len(_registered) >= REGISTER_PER_MINUTE:
            return False
        _registered.append(now)
        return True


def forget() -> None:
    with _registered_lock:
        _registered.clear()


def valid_redirect(uri: Any) -> bool:
    """HTTPS anywhere, or plain HTTP to the own machine; never a fragment, never a user in the address."""
    if not isinstance(uri, str) or len(uri) > 2048 or any(ord(char) < 33 for char in uri):
        return False
    parts = urlsplit(uri)
    if parts.fragment or parts.username or parts.password or not parts.hostname:
        return False
    if parts.scheme == "https":
        return True
    host = parts.netloc.rsplit("@", 1)[-1].lower()
    host = host if host.startswith("[") else host.split(":")[0]
    if host.startswith("[::1]"):
        host = "[::1]"
    return parts.scheme == "http" and host in LOOPBACK


@router.post("/api/oauth/register", include_in_schema=False)
async def register(request: Request) -> JSONResponse:
    with SessionLocal() as db:
        if not _open(db):
            return _oauth_error("access_denied", "Connectors are switched off here.", 403)
    try:
        body = await request.json()
    except ValueError:
        return _oauth_error("invalid_client_metadata", "The body must be JSON.")
    if not isinstance(body, dict):
        return _oauth_error("invalid_client_metadata", "The body must be a JSON object.")
    uris = body.get("redirect_uris")
    if not isinstance(uris, list) or not 1 <= len(uris) <= 10 or not all(valid_redirect(uri) for uri in uris):
        return _oauth_error("invalid_redirect_uri", "Give 1 to 10 redirect addresses: https, or http to localhost.")
    method = body.get("token_endpoint_auth_method", "none")
    if method != "none":
        return _oauth_error("invalid_client_metadata", "Only public clients with PKCE sign in here.")
    if not _may_register():
        return _oauth_error("temporarily_unavailable", "Too many registrations. Try again in a minute.", 429)
    name = body.get("client_name") if isinstance(body.get("client_name"), str) else ""
    name = " ".join(name.split())[:100] or "MCP client"
    client = OAuthClient(
        id="nxo_" + secrets.token_urlsafe(24), name=name, redirect_uris=list(uris), created_at=utcnow()
    )
    with SessionLocal() as db:
        db.add(client)
        db.commit()
        count = db.scalar(select(func.count()).select_from(OAuthClient)) or 0
        if count > MAX_CLIENTS:
            # The ones used longest ago (never used first) make room; their keys stay until revoked.
            oldest = db.scalars(
                select(OAuthClient.id).order_by(OAuthClient.last_used_at.is_not(None), OAuthClient.last_used_at,
                                               OAuthClient.created_at).limit(count - MAX_CLIENTS)
            ).all()
            db.execute(delete(OAuthClient).where(OAuthClient.id.in_(oldest)))
            db.commit()
    logger.info("OAuth client registered redirects=%s", len(uris))
    return JSONResponse({
        "client_id": client.id,
        "client_name": name,
        "redirect_uris": list(uris),
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_id_issued_at": int(time.time()),
    }, status_code=201)


# --- Consent (the page /oauth/authorize asks these) -------------------------------------------------------------------


def _client(db: Any, client_id: str, redirect_uri: str) -> OAuthClient:
    client = db.get(OAuthClient, client_id)
    if client is None:
        raise error("oauth_client", "This program is not registered here.", 400)
    if redirect_uri not in (client.redirect_uris or []):
        # Never send anybody to an address the program did not register: that is how codes are stolen.
        raise error("oauth_redirect", "This return address is not registered for the program.", 400)
    return client


def _check_challenge(challenge: str, method: str) -> None:
    if method != "S256" or not 43 <= len(challenge) <= 128 or not all(
        char.isalnum() or char in "-._~" for char in challenge
    ):
        raise error("oauth_pkce", "The program must use PKCE with S256.", 400)


class ConsentInfo(BaseModel):
    client_name: str
    redirect_host: str
    max_level: str
    spaces: list[dict[str, Any]]


@router.get("/api/oauth/authorize", response_model=ConsentInfo, summary="What a program asks to sign in for")
def consent_info(
    account: Account,
    db: DbSession,
    client_id: str = Query(max_length=64),
    redirect_uri: str = Query(max_length=2048),
    code_challenge: str = Query(max_length=128),
    code_challenge_method: str = Query("plain", max_length=8),
    response_type: str = Query("code", max_length=16),
) -> ConsentInfo:
    if not _open(db):
        raise error("mcp_off", "The operator has not switched connectors on.", 403)
    if response_type != "code":
        raise error("oauth_response_type", "Only response_type=code is spoken here.", 400)
    client = _client(db, client_id, redirect_uri)
    _check_challenge(code_challenge, code_challenge_method)
    readable = rights.readable_ids(db, account)
    spaces = db.execute(select(Space.id, Space.folder).where(Space.id.in_(readable)).order_by(Space.folder)).all()
    return ConsentInfo(client_name=client.name, redirect_host=urlsplit(redirect_uri).netloc,
                       max_level=mcp.max_level(db), spaces=[{"id": sid, "name": name} for sid, name in spaces])


class ConsentIn(BaseModel):
    client_id: str = Field(max_length=64)
    redirect_uri: str = Field(max_length=2048)
    code_challenge: str = Field(max_length=128)
    code_challenge_method: str = Field(max_length=8)
    state: str = Field(default="", max_length=1024)
    approve: bool
    level: str = Field(default="read", pattern="^(read|draft|write)$")
    #: Ids of spaces; left out: every space the account may read, now and later.
    spaces: list[int] | None = Field(default=None, max_length=1000)


def _back(redirect_uri: str, values: dict[str, str]) -> str:
    joiner = "&" if "?" in redirect_uri else "?"
    return redirect_uri + joiner + urlencode({key: value for key, value in values.items() if value})


@router.post("/api/oauth/authorize", summary="Agree to a program's sign-in, or turn it down")
def consent(body: ConsentIn, request: Request, account: Account, db: DbSession) -> dict[str, str]:
    if not _open(db):
        raise error("mcp_off", "The operator has not switched connectors on.", 403)
    _client(db, body.client_id, body.redirect_uri)
    _check_challenge(body.code_challenge, body.code_challenge_method)
    issuer = base_url(request, db)
    if not body.approve:
        logger.info("OAuth sign-in declined")
        return {"redirect": _back(body.redirect_uri, {"error": "access_denied", "state": body.state, "iss": issuer})}
    if not mcp.at_least(mcp.max_level(db), body.level):
        raise error("level_not_allowed", "The operator does not allow this level.", 403)
    spaces = None
    if body.spaces is not None:
        if not body.spaces or not set(body.spaces) <= rights.readable_ids(db, account):
            raise error("invalid_input", "Choose spaces you may read.", 422)
        spaces = sorted(set(body.spaces))
    code = secrets.token_urlsafe(32)
    db.add(OAuthCode(code_hash=mcp.digest(code), client_id=body.client_id, account_id=account.id,
                     redirect_uri=body.redirect_uri, challenge=body.code_challenge, level=body.level, spaces=spaces,
                     expires_at=utcnow() + timedelta(minutes=CODE_MINUTES)))
    db.execute(delete(OAuthCode).where(OAuthCode.expires_at <= utcnow()))
    db.commit()
    logger.info("OAuth sign-in agreed level=%s spaces=%s", body.level, "all" if spaces is None else len(spaces))
    return {"redirect": _back(body.redirect_uri, {"code": code, "state": body.state, "iss": issuer})}


# --- Tokens -----------------------------------------------------------------------------------------------------------


def _verifier_fits(verifier: str, challenge: str) -> bool:
    if not 43 <= len(verifier) <= 128:
        return False
    made = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii", "replace")).digest()).rstrip(b"=")
    return secrets.compare_digest(made.decode(), challenge)


def _issue(db: Any, key: McpKey) -> dict[str, Any]:
    access = mcp.TOKEN_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    key.token_hash = mcp.digest(access)
    key.prefix = access[: len(mcp.TOKEN_PREFIX) + 4]
    key.refresh_hash = mcp.digest(refresh)
    key.expires_at = utcnow() + timedelta(hours=ACCESS_HOURS)
    db.commit()
    return {"access_token": access, "token_type": "Bearer", "expires_in": ACCESS_HOURS * 3600,
            "refresh_token": refresh, "scope": "mcp"}


async def _form(request: Request) -> dict[str, str]:
    raw = (await request.body()).decode("utf-8", "replace")
    if request.headers.get("content-type", "").startswith("application/json"):
        import json

        try:
            found = json.loads(raw)
        except ValueError:
            return {}
        return {key: str(value) for key, value in found.items()} if isinstance(found, dict) else {}
    return {key: values[0] for key, values in parse_qs(raw, keep_blank_values=True).items()}


@router.post("/api/oauth/token", include_in_schema=False)
async def token(request: Request) -> JSONResponse:
    form = await _form(request)
    grant = form.get("grant_type", "")
    client_id = form.get("client_id", "")
    with SessionLocal() as db:
        if not _open(db):
            return _oauth_error("access_denied", "Connectors are switched off here.", 403)
        client = db.get(OAuthClient, client_id)
        if client is None:
            return _oauth_error("invalid_client", "Unknown client.", 401)
        if grant == "authorization_code":
            code_hash = mcp.digest(form.get("code", ""))
            row = db.get(OAuthCode, code_hash)
            # Taken away first: a code is traded once, even when two requests bring it at the same moment.
            gone = db.execute(delete(OAuthCode).where(OAuthCode.code_hash == code_hash)).rowcount
            db.commit()
            if (
                row is None or gone != 1 or row.expires_at <= utcnow() or row.client_id != client.id
                or row.redirect_uri != form.get("redirect_uri", "")
                or not _verifier_fits(form.get("code_verifier", ""), row.challenge)
            ):
                return _oauth_error("invalid_grant", "The code is not valid (any more).")
            key = db.scalar(select(McpKey).where(McpKey.account_id == row.account_id, McpKey.kind == "oauth",
                                                 McpKey.client_id == client.id))
            if key is None:
                count = db.scalar(select(func.count()).select_from(McpKey).where(McpKey.account_id == row.account_id))
                if (count or 0) >= mcp.MAX_KEYS:
                    return _oauth_error("invalid_grant", "The account holds 20 keys already. Revoke one first.")
                key = McpKey(account_id=row.account_id, name=client.name, kind="oauth", client_id=client.id,
                             level=row.level, spaces=row.spaces, token_hash="", prefix="", created_at=utcnow())
                db.add(key)
            else:
                # Signing in again keeps the rights per tool that were set for this connector.
                key.level, key.spaces = row.level, row.spaces
            client.last_used_at = utcnow()
            answer = _issue(db, key)
            logger.info("OAuth tokens issued key_id=%s", key.id)
            return JSONResponse(answer, headers={"Cache-Control": "no-store"})
        if grant == "refresh_token":
            key = db.scalar(select(McpKey).where(McpKey.refresh_hash == mcp.digest(form.get("refresh_token", "")),
                                                 McpKey.client_id == client.id))
            if key is None:
                return _oauth_error("invalid_grant", "The refresh token is not valid (any more).")
            client.last_used_at = utcnow()
            answer = _issue(db, key)
            logger.info("OAuth tokens refreshed key_id=%s", key.id)
            return JSONResponse(answer, headers={"Cache-Control": "no-store"})
    return _oauth_error("unsupported_grant_type", "Only authorization_code and refresh_token.")
