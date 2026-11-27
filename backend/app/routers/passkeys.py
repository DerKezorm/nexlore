"""Passkeys (WebAuthn): sign in without a password or a code, add and remove them under Security, and use one in place
of the code of the second factor. The work is the shared account module's (``nexkonten.passkeys``: challenge,
check, counter); here are nexlore's ways to it. Passkeys need the public address over https (or localhost), and the
operator's switch "Passkeys allowed" (on from the start).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from ..deps import Account, DbSession, client_ip
from ..errors import error
from ..models import SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..services import settings_service, totp
from ..services.konten_store import KontenStore
from ..vendor import nexkonten
from ..vendor.nexkonten import passkeys
from .auth import PENDING_COOKIE, _confirmed_without_password, account_view, fail, sign_in

logger = logging.getLogger("nexlore.auth")

router = APIRouter(prefix="/api", tags=["passkeys"])


class BeginAddIn(BaseModel):
    #: The own password (an account without one: a fresh sign-in at its provider).
    password: str = Field(default="", max_length=200)


class FinishIn(BaseModel):
    token: str = Field(max_length=200)
    credential: dict[str, Any]
    name: str = Field(default="", max_length=100)


class RemoveIn(BaseModel):
    password: str = Field(default="", max_length=200)


def can_add(request: Request, db: DbSession) -> bool:
    """Since konten E49: whether the box "Passkeys" offers "Add a passkey": the public address set counts alone and
    only with https; without one, the page on localhost (konten ``c0b07ab``)."""
    return passkeys.can_add(settings_service.public_url(db) or "", origin=request.headers.get("origin", ""),
                            request_url=str(request.url))


def _party(request: Request, db: DbSession) -> passkeys.Party:
    base = settings_service.public_url(db) or str(request.base_url).rstrip("/")
    try:
        # A page on localhost gets exactly its host and port; a GET without ``Origin`` counts by its own address.
        return passkeys.party(base, origin=request.headers.get("origin", ""), request_url=str(request.url))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc


@router.get("/auth/passkeys", summary="The own passkeys")
def my_passkeys(account: Account, db: DbSession) -> list[dict[str, Any]]:
    return [passkeys.view(key) for key in KontenStore(db).passkeys_of(account.id)]


@router.post("/auth/passkeys/begin", summary="Start adding a passkey; needs the password")
def begin_add(payload: BeginAddIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    fresh = _confirmed_without_password(request, db, row) if row.sign_in != SIGN_IN_PASSWORD else False
    try:
        token, options = passkeys.begin_register(KontenStore(db), row.id, _party(request, db), app_name="nexlore",
                                                 password=payload.password, actor_confirmed=fresh)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {"token": token, "options": passkeys.options_json(options)}


@router.post("/auth/passkeys/finish", summary="Finish adding a passkey with the browser's answer")
def finish_add(payload: FinishIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    try:
        made = passkeys.finish_register(KontenStore(db), account.id, payload.token, payload.credential,
                                        _party(request, db), name=payload.name)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    logger.info("Passkey added name=%s", account.name)
    return passkeys.view(made)


@router.delete("/auth/passkeys/{uid}", summary="Remove a passkey; needs the password")
def remove(uid: str, payload: RemoveIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    fresh = _confirmed_without_password(request, db, row) if row.sign_in != SIGN_IN_PASSWORD else False
    try:
        gone = passkeys.remove(KontenStore(db), row.id, uid[:40], password=payload.password, actor_confirmed=fresh)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    if not gone:
        raise error("not_found", "Not found.", 404)
    db.refresh(row)
    return account_view(row, db)


@router.post("/auth/passkey/begin", summary="Sign in with a passkey: the challenge (no sign-in needed)")
def begin_sign_in(request: Request, db: DbSession) -> dict[str, Any]:
    try:
        token, options = passkeys.begin_sign_in(KontenStore(db), _party(request, db), sender=client_ip(request))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {"token": token, "options": passkeys.options_json(options)}


@router.post("/auth/passkey/finish", summary="Sign in with a passkey: the browser's answer")
def finish_sign_in(payload: FinishIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    """A passkey is both factors. Answering a sign-in that waits for its code (the cookie of the password step), it
    must be a passkey of that very account."""
    store = KontenStore(db)
    try:
        konto = passkeys.finish_sign_in(store, payload.token, payload.credential, _party(request, db))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    remember = True
    pending_token = request.cookies.get(PENDING_COOKIE)
    pending = totp.get_pending(pending_token) if pending_token else None
    if pending is not None:
        if pending.account_id != int(konto.id):
            raise fail(passkeys.refused())
        remember = pending.remember
        totp.finish_pending(pending_token or "")
        response.delete_cookie(PENDING_COOKIE, path="/api/auth")
    account = db.get(AccountRow, int(konto.id))
    assert account is not None
    if not settings_service.get(db, "password_login") and account.role != "operator" and \
            account.sign_in == SIGN_IN_PASSWORD and pending is not None:
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    nexkonten.login.succeeded(store, account.id)
    logger.info("Signed in with a passkey name=%s", account.name)
    return sign_in(db, request, response, account, remember=remember, tell=True)
