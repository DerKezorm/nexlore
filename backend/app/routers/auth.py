"""Setting up the first account, signing in and out, the own account, and the operator's list of accounts.

Invitations are in ``routers/members.py``, next to the rights they hand out.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import __version__
from ..config import get_settings
from ..deps import (
    Account,
    DbSession,
    OperatorAccount,
    client_ip,
    confirm_operator,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
)
from ..errors import detail, error
from ..models import OPERATOR, ROLES, SIGN_IN_PASSWORD, Membership
from ..models import Account as AccountRow
from ..security import (
    MIN_PASSWORD,
    SESSION_COOKIE,
    brake,
    end_all_sessions,
    end_session,
    session_account,
    start_session,
)
from ..services import accounts, ai, appearance, avatars, guide, locales, mailer, settings_service, totp
from ..services.accounts import AccountError
from . import themes as theme_routes

logger = logging.getLogger("nexlore.auth")

router = APIRouter(prefix="/api", tags=["auth"])

#: The languages inside the frontend; others come as files from the operator.
SHIPPED = ("en", "de")
#: Names a sign-in waiting for its second factor (``services/totp.py``), and nothing else.
PENDING_COOKIE = "nexlore_2fa"


class SetupIn(BaseModel):
    name: str = Field(max_length=64)
    password: str = Field(max_length=200)
    language: str = Field(default="", max_length=16)


class LoginIn(BaseModel):
    name: str = Field(max_length=64)
    password: str = Field(max_length=200)


class PasswordChangeIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


class LanguageIn(BaseModel):
    language: str = Field(max_length=16)


class ProfileIn(BaseModel):
    display_name: str = Field(max_length=200)


#: Longest display name, in characters.
DISPLAY_NAME_MAX = 80


def check_display_name(value: str) -> str:
    """Spaces gathered, no control characters, at most DISPLAY_NAME_MAX characters; empty shows the name."""
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise error("display_name_invalid", "A display name cannot hold control characters.", 422)
    clean = " ".join(value.split())
    if len(clean) > DISPLAY_NAME_MAX:
        raise error(
            "display_name_too_long", f"Use at most {DISPLAY_NAME_MAX} characters.", 422, maximum=DISPLAY_NAME_MAX
        )
    return clean


def secure_cookie(request: Request) -> bool:
    mode = get_settings().cookie_secure.lower()
    if mode == "on":
        return True
    if mode == "off":
        return False
    forwarded = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded.split(",")[0].strip() == "https"


def _set_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=get_settings().session_days * 86400,
        httponly=True,
        samesite="lax",
        secure=secure_cookie(request),
        path="/",
    )


def fail(exc: AccountError) -> HTTPException:
    return error(exc.code, exc.message, exc.status)


def check_password(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise error("password_too_short", f"Use at least {MIN_PASSWORD} characters.", 422, minimum=MIN_PASSWORD)


def check_language(language: str) -> str:
    """Empty (the browser decides) or a language nexlore has."""
    if language and language not in SHIPPED and language not in {item.code for item in locales.available()}:
        raise error("unknown_language", "nexlore does not have this language.", 422)
    return language


def account_view(account: AccountRow) -> dict[str, Any]:
    return {
        "id": account.id,
        "name": account.name,
        "display_name": account.display_name,
        # "What's new" (block X3): the running version and the one the account has read.
        "version": __version__,
        "whats_new_seen": account.whats_new_seen,
        "role": account.role,
        "sign_in": account.sign_in,
        "email": account.email,
        "language": account.language,
        "oidc_linked": bool(account.oidc_subject),
        "two_factor": bool(account.totp_secret_enc),
        "two_factor_recovery_left": len(totp.load_recovery(account.totp_recovery)) if account.totp_secret_enc else 0,
        "created_at": account.created_at.isoformat(),
        "last_seen_at": account.last_seen_at.isoformat() if account.last_seen_at else None,
        "avatar": account.avatar_at.isoformat() if account.avatar_at else None,
    }


def sign_in(db: DbSession, request: Request, response: Response, account: AccountRow) -> dict[str, Any]:
    token = start_session(db, account, client_ip(request), request.headers.get("user-agent", ""))
    _set_cookie(response, request, token)
    logger.info("Signed in name=%s", account.name)
    return account_view(account)


@router.get("/setup", summary="Does nexlore still need its first account, and is this browser signed in?")
def setup_state(request: Request, db: DbSession) -> dict[str, Any]:
    # ``signed_in`` lets the page ask for the account only when there is one: a 401 would show as an error in the
    # browser's console on every visit of the sign-in page.
    return {
        "needs_setup": accounts.count(db) == 0,
        "signed_in": session_account(db, request.cookies.get(SESSION_COOKIE)) is not None,
        "version": __version__,
        "min_password": MIN_PASSWORD,
    }


@router.post("/setup", summary="Create the operator account")
def setup(payload: SetupIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    check_password(payload.password)
    language = check_language(payload.language)
    try:
        account = accounts.create_operator(db, payload.name, payload.password)
    except AccountError as exc:
        raise fail(exc) from exc
    account.language = language
    db.commit()
    # A first start with an empty vault: the guide, in the language chosen here.
    guide.on_first_start(account.id, language)
    return sign_in(db, request, response, account)


@router.get("/auth/methods", summary="How one can sign in here (no sign-in needed)")
def methods(db: DbSession) -> dict[str, Any]:
    values = settings_service.get_all(db)
    oidc = bool(values["oidc_issuer"] and values["oidc_client_id"])
    return {
        "password": bool(values["password_login"]),
        "oidc": oidc,
        "oidc_name": values["oidc_provider_name"] if oidc else "",
    }


@router.post("/auth/login", summary="Sign in with name and password")
def login(payload: LoginIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    # The brake first, then the password, then the rules: an unknown name costs the time of a wrong password, so
    # neither the answer nor its timing tells which names exist.
    key = "login:" + client_ip(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    try:
        account = accounts.authenticate(db, payload.name, payload.password)
    except AccountError as exc:
        brake.failed(key)
        raise fail(exc) from exc
    brake.succeeded(key)
    if not settings_service.get(db, "password_login") and account.role != OPERATOR:
        # The operator keeps the password as the way in when the provider is down.
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    if account.totp_secret_enc:
        # Nothing opens yet: the browser gets a short-lived cookie that names the waiting sign-in and nothing else.
        response.set_cookie(
            PENDING_COOKIE,
            totp.start_pending(account.id),
            max_age=totp.PENDING_SECONDS,
            httponly=True,
            samesite="lax",
            secure=secure_cookie(request),
            path="/api/auth",
        )
        logger.info("Password accepted, second factor waiting name=%s", account.name)
        return {"second_factor": True}
    return sign_in(db, request, response, account)


@router.post("/auth/logout", status_code=204, summary="Sign out in this browser")
def logout(request: Request, response: Response, db: DbSession) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    account = session_account(db, token)
    end_session(db, token)
    if account is not None:
        logger.info("Signed out name=%s", account.name)
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.post("/auth/logout-all", status_code=204, summary="Sign out every other browser of the own account")
def logout_everywhere(request: Request, account: Account, db: DbSession) -> None:
    end_all_sessions(db, account.id, except_token=request.cookies.get(SESSION_COOKIE))
    logger.info("All other sessions ended by their owner name=%s", account.name)


@router.get("/auth/me", summary="The signed-in account, and what this server offers it")
def me(account: Account, db: DbSession) -> dict[str, Any]:
    return {
        **account_view(account),
        "shares_allowed": bool(settings_service.get(db, "shares_allowed")),
        "mail": mailer.configured(db),
        "second_factor_setup_required": totp.setup_required(db, account),
        # The editor offers AI only when the operator allows it and the account switched its own service on.
        "ai_ready": ai.ready(db, account),
        # Pasted links get the page's title when the operator allows asking the pages (services/linktitle).
        "link_titles": bool(settings_service.get(db, "link_titles_allowed")),
        "appearance": appearance.of(account.appearance),
        # The colours of the chosen theme (None: nexlore's own, or one no longer there) and the own CSS in force.
        "theme_colours": theme_routes.colours_of(db, account, appearance.of(account.appearance)["theme"]),
        "own_css": theme_routes.own_css(db, account.id),
    }


@router.put("/auth/password", status_code=204, summary="Change the own password")
def change_password(payload: PasswordChangeIn, request: Request, account: Account, db: DbSession) -> None:
    row = db.get(AccountRow, account.id)
    assert row is not None
    if row.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    check_password(payload.new)
    reauth_guard(request, row)
    try:
        accounts.change_password(db, row, payload.current, payload.new)
    except AccountError as exc:
        if exc.code == "wrong_password":
            reauth_failed(request, db, row)
        raise fail(exc) from exc
    reauth_succeeded(request, db, row)
    # Other browsers must sign in again; this one stays.
    end_all_sessions(db, row.id, except_token=request.cookies.get(SESSION_COOKIE))


@router.put("/me/profile", summary="The own display name; empty shows the name")
def set_profile(payload: ProfileIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.display_name = check_display_name(payload.display_name)
    db.commit()
    return account_view(row)


@router.post("/me/whats-new/seen", summary="\"What's new\" of the running version is read or put away")
def whats_new_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.whats_new_seen = __version__
    db.commit()
    return account_view(row)


@router.get("/people", summary="Display names for account names: of the own account and of those sharing a space")
def people(
    account: Account, db: DbSession, name: Annotated[list[str] | None, Query(max_length=64)] = None
) -> dict[str, str]:
    """Only names with a display name come back; one the caller may not see is left out like an unknown one, so
    nothing tells which names exist."""
    wanted = sorted({item.strip().lower() for item in (name or []) if item.strip()})[:200]
    if not wanted:
        return {}
    out: dict[str, str] = {}
    for row in db.scalars(select(AccountRow).where(AccountRow.name.in_(wanted), AccountRow.display_name != "")):
        if avatars.may_see(db, account, row.id):
            out[row.name] = row.display_name
    return out


@router.put("/me/language", summary="The language of the own account; empty follows the browser")
def set_language(payload: LanguageIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.language = check_language(payload.language)
    db.commit()
    return account_view(row)


@router.put("/me/appearance", summary="How nexlore looks for the own account; only the values sent change")
def set_appearance(payload: dict[str, Any], account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    try:
        row.appearance = appearance.change(row.appearance, payload)
    except appearance.AppearanceError as exc:
        raise error("bad_appearance", "This value is not one nexlore offers.", 422, field=exc.field) from exc
    db.commit()
    return appearance.of(row.appearance)


# --- Accounts (operator) --------------------------------------------------------------------------------------------


class RoleIn(BaseModel):
    role: str = Field(max_length=16)
    #: The operator's own password once more (see ``confirm_operator``); empty for an account from a provider.
    current_password: str = Field(default="", max_length=200)


class PasswordSetIn(BaseModel):
    password: str = Field(max_length=200)
    current_password: str = Field(default="", max_length=200)


class OperatorConfirmIn(BaseModel):
    current_password: str = Field(default="", max_length=200)


def _row(db: DbSession, account_id: int) -> AccountRow:
    row = db.get(AccountRow, account_id)
    if row is None:
        raise error("not_found", "No such account.", 404)
    return row


@router.get("/accounts", summary="All accounts")
def list_accounts(_operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    spaces: dict[int, int] = {}
    for account_id in db.scalars(select(Membership.account_id)):
        spaces[account_id] = spaces.get(account_id, 0) + 1
    return [
        {**account_view(row), "spaces": spaces.get(row.id, 0), "locked": accounts.is_locked(row)}
        for row in db.scalars(select(AccountRow).order_by(AccountRow.created_at))
    ]


@router.delete("/accounts/{account_id}", status_code=204, summary="Delete an account")
def delete_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    """Its rights go with it; its notes stay where they are. A space it was the only member of has no members any
    more and so belongs to the operator (who runs the disk it lies on anyway)."""
    confirm_operator(request, db, operator, payload.current_password)
    if account_id == operator.id:
        raise error("cannot_delete_self", "You cannot delete your own account.", 409)
    row = _row(db, account_id)
    name = row.name
    db.delete(row)
    db.commit()
    totp.forget_account(account_id)
    logger.warning("Account deleted name=%s by=%s", name, operator.name)


@router.post("/accounts/{account_id}/sign-out", status_code=204, summary="End every session of an account")
def sign_out_account(account_id: int, operator: OperatorAccount, db: DbSession) -> None:
    row = _row(db, account_id)
    end_all_sessions(db, row.id)
    logger.warning("All sessions ended name=%s by=%s", row.name, operator.name)


@router.put("/accounts/{account_id}/role", summary="Make an account operator or member")
def set_role(
    account_id: int, payload: RoleIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    if payload.role not in ROLES:
        raise error("invalid_role", "Unknown role.", 422)
    row = _row(db, account_id)
    if row.id == operator.id and payload.role != OPERATOR:
        raise error("cannot_demote_self", "You cannot take the operator role from yourself.", 409)
    row.role = payload.role
    db.commit()
    logger.warning("Role changed name=%s role=%s by=%s", row.name, payload.role, operator.name)
    return account_view(row)


@router.put("/accounts/{account_id}/password", status_code=204, summary="Give an account a new password")
def set_password(
    account_id: int, payload: PasswordSetIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    confirm_operator(request, db, operator, payload.current_password)
    check_password(payload.password)
    row = _row(db, account_id)
    accounts.set_password(db, row, payload.password)
    end_all_sessions(db, row.id)
    logger.warning("Password set name=%s by=%s", row.name, operator.name)
