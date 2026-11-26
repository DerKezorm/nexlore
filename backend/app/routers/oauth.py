"""Signing in for MCP with OAuth (block Y): since the shared module mcp 1.1.0 the module's (``routers/mcp.py``
``module_router``): the metadata (RFC 9728, 8414), the registration of programs (RFC 7591), the token endpoint with
PKCE and changing refresh tokens, and revoking (RFC 7009), all under ``/api/oauth`` as before, so that a connected
program refreshes at the address it knows.

Three ways stay nexlore's hulls over the module, for what they checked and answered before (E55; TODO mcp 1.1.0:
the module's router takes neither the app's schema names nor its stricter return addresses): ``POST
/api/oauth/register`` (403 ``access_denied`` while connectors are off, return addresses only with a host of plain
letters, digits, dots and dashes, as before: no ``*.example.com``, no look-alike letters), ``POST /api/oauth/token``
(a form, or JSON as before). And the consent of before, ``GET``/``POST /api/oauth/authorize``, as a thin hull over
the module (``nexmcp.oauth.consent_info``/``consent``): its names in the API's description (``ConsentInfo``,
``ConsentIn``; E53), its checks of the query and body and its refusals (E55: ``mcp_off`` 403 while connectors are
off, ``oauth_client``, ``oauth_redirect``, ``oauth_pkce``, ``oauth_response_type`` 400, ``level_not_allowed`` 403,
``invalid_input`` 422). The answer of ``GET`` carries the fields of before and the module's; ``POST`` takes the fields
of before (``approve``, ``spaces``) and the module's (``allow``, ``areas``, ``options``, ``resource``).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, DbSession, client_ip
from ..errors import error
from ..services import mcp, settings_service
from ..services.mcp_store import McpStore
from ..vendor import nexmcp
from ..vendor.nexmcp import api as nexmcp_api

logger = logging.getLogger("nexlore.oauth")

router = APIRouter(tags=["oauth"])


def base_url(request: Request, db: Any) -> str:
    return settings_service.public_url(db) or str(request.base_url).rstrip("/")


LOOPBACK = ("localhost", "127.0.0.1", "[::1]")
#: The largest body a program sends to register or for tokens (the module's limit of a form).
MAX_FORM = 16 * 1024
#: Ways of the module this file answers itself.
OWN_PATHS = ("/api/oauth/authorize", "/api/oauth/register", "/api/oauth/token")



def valid_redirect(uri: Any) -> bool:
    """HTTPS anywhere, or plain HTTP to the own machine; never a fragment, never a user in the address."""
    if not isinstance(uri, str) or len(uri) > 2048 or any(ord(char) < 33 for char in uri):
        return False
    try:
        # urlsplit throws on a broken bracket ("http://[::1/cb"), .port on a port that is not a number: both gave 500.
        parts = urlsplit(uri)
        hostname, _port = parts.hostname, parts.port
    except ValueError:
        return False
    if parts.fragment or parts.username or parts.password or not hostname:
        return False
    # A name of letters, digits, dots and hyphens, or an address in brackets: no "*.example.com" or the like.
    if not re.fullmatch(r"[a-z0-9.-]+|[0-9a-f:.]+", hostname):
        return False
    if parts.scheme == "https":
        return True
    host = parts.netloc.rsplit("@", 1)[-1].lower()
    host = host if host.startswith("[") else host.split(":")[0]
    if host.startswith("[::1]"):
        host = "[::1]"
    return parts.scheme == "http" and host in LOOPBACK


def _oauth_answer(body: dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


async def _body(request: Request) -> bytes | None:
    taken = b""
    async for chunk in request.stream():
        taken += chunk
        if len(taken) > MAX_FORM:
            return None
    return taken


@router.post("/api/oauth/register", include_in_schema=False)
async def register(request: Request) -> JSONResponse:
    from .mcp import CONFIG

    raw = await _body(request)
    with SessionLocal() as db:
        store = McpStore(db, request)
        if not nexmcp.oauth.programs_open(CONFIG, store):
            return _oauth_answer({"error": "access_denied", "error_description": "Connectors are switched off here."},
                                 403)
        try:
            body = json.loads(raw or b"null") if raw is not None else None
        except ValueError:
            return _oauth_answer({"error": "invalid_client_metadata", "error_description": "The body must be JSON."},
                                 400)
        uris = body.get("redirect_uris") if isinstance(body, dict) else None
        if isinstance(uris, list) and not all(valid_redirect(uri) for uri in uris):
            return _oauth_answer({"error": "invalid_redirect_uri",
                                  "error_description": "Give 1 to 10 redirect addresses: https, or http to localhost."},
                                 400)
        try:
            made = nexmcp.oauth.register(store, CONFIG, body, client_ip(request), nexmcp_api._now())
        except nexmcp.OAuthError as refusal:
            return _oauth_answer(refusal.as_dict(), refusal.status)
    return _oauth_answer(made, 201)


@router.post("/api/oauth/token", include_in_schema=False)
async def token(request: Request) -> JSONResponse:
    """The module's token endpoint; a program that sends JSON (taken before) is understood as well."""
    from .mcp import CONFIG

    raw = await _body(request)
    if raw is None:
        return _oauth_answer({"error": "invalid_request", "error_description": "The request is too large."}, 413)
    try:
        if request.headers.get("content-type", "").startswith("application/json"):
            found = json.loads(raw or b"{}")
            form = {key: str(value) for key, value in found.items()} if isinstance(found, dict) else {}
        else:
            form = dict(parse_qsl(raw.decode("utf-8"), keep_blank_values=True))
    except (UnicodeDecodeError, ValueError):
        return _oauth_answer({"error": "invalid_request", "error_description": "The body must be a form."}, 400)
    with SessionLocal() as db:
        store = McpStore(db, request)
        try:
            return _oauth_answer(nexmcp.oauth.token(store, CONFIG, form, base_url(request, db), nexmcp_api._now()))
        except nexmcp.OAuthError as refusal:
            return _oauth_answer(refusal.as_dict(), refusal.status)


def forget() -> None:
    """For the tests: the module's brakes (registrations, wrong keys, rates) start again."""
    nexmcp.brake.BRAKE.forget()


#: The module's refusals of the consent as the way of before gave them: code -> (code, text, status).
_BEFORE = {
    "programs_off": ("mcp_off", "The operator has not switched connectors on.", 403),
    "client_unknown": ("oauth_client", "This program is not registered here.", 400),
    "redirect_invalid": ("oauth_redirect", "This return address is not registered for the program.", 400),
    "pkce_required": ("oauth_pkce", "The program must use PKCE with S256.", 400),
    "response_type": ("oauth_response_type", "Only response_type=code is spoken here.", 400),
    "level_invalid": ("level_not_allowed", "The operator does not allow this level.", 403),
    "areas_invalid": ("invalid_input", "Choose spaces you may read.", 422),
}


def _refused(refusal: nexmcp.McpRefused) -> Exception:
    code, text, status = _BEFORE.get(refusal.code, (refusal.code, refusal.message, refusal.status))
    return error(code, text, status)


class ConsentInfo(BaseModel):
    # The fields of before.
    client_name: str
    redirect_host: str
    max_level: str
    spaces: list[dict[str, Any]]
    # The module's (mcp 1.1.0), for its consent page.
    app: str = "nexlore"
    client: dict[str, Any] = {}
    redirect_uri: str = ""
    levels: list[str] = []
    level: str = "read"
    areas: list[dict[str, Any]] = []
    extras: list[str] = []
    ai_allowed: bool = True


@router.get("/api/oauth/authorize", response_model=ConsentInfo, summary="What a program asks to sign in for")
def consent_info(
    request: Request,
    account: Account,
    db: DbSession,
    client_id: str = Query(max_length=64),
    redirect_uri: str = Query(max_length=2048),
    code_challenge: str = Query(max_length=128),
    code_challenge_method: str = Query("plain", max_length=8),
    response_type: str = Query("code", max_length=16),
    state: str = Query("", max_length=1024),
    resource: str = Query("", max_length=2048),
) -> ConsentInfo:
    from .mcp import CONFIG

    store = McpStore(db, request)
    if not store.mcp_on():
        raise error("mcp_off", "The operator has not switched connectors on.", 403)
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": response_type,
              "code_challenge": code_challenge, "code_challenge_method": code_challenge_method, "state": state,
              "resource": resource}
    try:
        shown = nexmcp.oauth.consent_info(store, CONFIG, account.id, params, base_url(request, db))
    except nexmcp.McpRefused as refusal:
        raise _refused(refusal) from None
    return ConsentInfo(client_name=shown["client"]["name"], max_level=mcp.max_level(db), spaces=shown["areas"],
                       **shown)


class ConsentIn(BaseModel):
    client_id: str = Field(max_length=64)
    redirect_uri: str = Field(max_length=2048)
    code_challenge: str = Field(max_length=128)
    code_challenge_method: str = Field(max_length=8)
    state: str = Field(default="", max_length=1024)
    #: Before: yes or no. The module's page sends ``allow``; one of the two is needed.
    approve: bool | None = None
    level: str = Field(default="read", pattern="^(read|draft|write)$")
    #: Ids of spaces; left out: every space the account may read, now and later.
    spaces: list[int] | None = Field(default=None, max_length=1000)
    # The module's (mcp 1.1.0).
    allow: bool | None = None
    areas: list[int] | None = Field(default=None, max_length=1000)
    options: dict[str, bool] | None = None
    resource: str = Field(default="", max_length=2048)


@router.post("/api/oauth/authorize", summary="Agree to a program's sign-in, or turn it down")
def consent(body: ConsentIn, request: Request, account: Account, db: DbSession) -> dict[str, str]:
    from .mcp import CONFIG

    store = McpStore(db, request)
    if not store.mcp_on():
        raise error("mcp_off", "The operator has not switched connectors on.", 403)
    allow = body.allow if body.allow is not None else body.approve
    if allow is None:
        raise error("invalid_input", "Say yes or no.", 422)
    answer = {
        "client_id": body.client_id, "redirect_uri": body.redirect_uri, "response_type": "code",
        "code_challenge": body.code_challenge, "code_challenge_method": body.code_challenge_method,
        "state": body.state, "resource": body.resource, "allow": allow, "level": body.level,
        "areas": body.areas if body.areas is not None else body.spaces, "options": body.options or {},
    }
    try:
        redirect = nexmcp.oauth.consent(store, CONFIG, account.id, answer, base_url(request, db),
                                       nexmcp_api._now())  # the module's clock, as on its own routes
    except nexmcp.McpRefused as refusal:
        db.rollback()
        raise _refused(refusal) from None
    return {"redirect": redirect}
