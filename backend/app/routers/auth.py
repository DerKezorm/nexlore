"""Setting up the first account, signing in and out, the own account, and the operator's list of accounts.

Invitations are in ``routers/members.py``, next to the rights they hand out.
"""

from __future__ import annotations

import logging
import unicodedata
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..deps import (
    Account,
    DbSession,
    OperatorAccount,
    behind_unknown_proxy,
    client_ip,
    confirm_operator,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
)
from ..errors import detail, error
from ..models import OPERATOR, ROLES, SIGN_IN_PASSWORD, Membership, OidcLink, OidcProvider
from ..models import Account as AccountRow
from ..security import (
    DEVICE_COOKIE,
    DEVICE_DAYS,
    MIN_PASSWORD,
    SESSION_COOKIE,
    Brake,
    brake,
    device_of,
    device_token,
    end_all_sessions,
    end_session,
    session_account,
    start_session,
)
from ..services import (
    accounts,
    ai,
    appearance,
    avatars,
    emailaddr,
    guide,
    locales,
    lore,
    mailer,
    settings_service,
    totp,
)
from ..services.accounts import AccountError
from ..services.oidc_store import SqlStore
from ..vendor.nexoidc import providers
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
    #: The setup code from the server's log (or NEXLORE_SETUP_TOKEN).
    code: str = Field(default="", max_length=200)


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
    """Spaces gathered, no control or format characters, at most DISPLAY_NAME_MAX characters; empty shows the name.

    Format characters (Unicode Cf: the right-to-left override, zero-width spaces) let a name read other than it is.
    """
    if any(ord(char) < 32 or ord(char) == 127 or unicodedata.category(char) == "Cf" for char in value):
        raise error("display_name_invalid", "A display name cannot hold control or invisible characters.", 422)
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


def account_view(account: AccountRow, db: Session | None = None) -> dict[str, Any]:
    return {
        "id": account.id,
        "name": account.name,
        "display_name": account.display_name,
        # "What's new" (block X3): the running version and the one the account has read.
        "version": __version__,
        "whats_new_seen": account.whats_new_seen,
        "role": account.role,
        "sign_in": account.sign_in,
        **emailaddr.view(account, db),
        "language": account.language,
        "two_factor": bool(account.totp_secret_enc),
        "two_factor_recovery_left": len(totp.load_recovery(account.totp_recovery)) if account.totp_secret_enc else 0,
        "created_at": account.created_at.isoformat(),
        "last_seen_at": account.last_seen_at.isoformat() if account.last_seen_at else None,
        "avatar": account.avatar_at.isoformat() if account.avatar_at else None,
    }


def sign_in(db: DbSession, request: Request, response: Response, account: AccountRow) -> dict[str, Any]:
    token = start_session(db, account, client_ip(request), request.headers.get("user-agent", ""))
    _set_cookie(response, request, token)
    # This browser is known from now on: a lock that strangers cause by guessing does not keep it out.
    if device_of(request.cookies.get(DEVICE_COOKIE)) != account.id:
        response.set_cookie(DEVICE_COOKIE, device_token(account.id), max_age=DEVICE_DAYS * 86400, httponly=True,
                            samesite="lax", secure=secure_cookie(request), path="/api/auth")
    logger.info("Signed in name=%s", account.name)
    return account_view(account)


@router.get("/setup", summary="Does nexlore still need its first account, and is this browser signed in?")
def setup_state(request: Request, db: DbSession) -> dict[str, Any]:
    # ``signed_in`` lets the page ask for the account only when there is one: a 401 would show as an error in the
    # browser's console on every visit of the sign-in page.
    return {
        "needs_setup": accounts.count(db) == 0,
        # The first account needs the setup code from the server's log.
        "code_required": True,
        "signed_in": session_account(db, request.cookies.get(SESSION_COOKIE)) is not None,
        "version": __version__,
        "min_password": MIN_PASSWORD,
    }


@router.post("/setup", summary="Create the operator account")
def setup(payload: SetupIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    key = "setup:" + client_ip(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    check_password(payload.password)
    language = check_language(payload.language)
    try:
        account = accounts.create_operator(db, payload.name, payload.password, payload.code)
    except AccountError as exc:
        if exc.code == "setup_code_wrong":
            brake.failed(key)
            logger.warning("Setup refused: wrong setup code")
        raise fail(exc) from exc
    account.language = language
    db.commit()
    # A first start with an empty vault: the guide, in the language chosen here.
    guide.on_first_start(account.id, language)
    return sign_in(db, request, response, account)


@router.get("/auth/methods", summary="How one can sign in here (no sign-in needed)")
def methods(db: DbSession) -> dict[str, Any]:
    # The buttons of the sign-in page: slug and label of each active provider, nothing else (vendor/nexoidc).
    return {
        "password": bool(settings_service.get(db, "password_login")),
        "providers": providers.public_list(SqlStore(db)),
    }


#: Wrong passwords one sender may give across all names before it waits: room for a household behind one address.
LOGIN_FREE_PER_SENDER = 30


@router.post("/auth/login", summary="Sign in with name and password")
def login(payload: LoginIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    # The brake first, then the password, then the rules: an unknown name costs the time of a wrong password, so
    # neither the answer nor its timing tells which names exist.
    #
    # Two counts: per sender and name, and per sender alone with more room. The second is not reset by a sign-in that
    # works (whoever has an account would otherwise reset it between guesses at other names), and it is left out
    # when every sender looks like one proxy: then it would keep everybody out after a stranger's guesses.
    ip = client_ip(request)
    keys = [("login:" + ip + "|" + payload.name.strip().lower()[:64], Brake.FREE)]
    if not behind_unknown_proxy(request):
        keys.append(("login-ip:" + ip, LOGIN_FREE_PER_SENDER))
    wait = max(brake.wait_seconds(key, free) for key, free in keys)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    try:
        account = accounts.authenticate(db, payload.name, payload.password,
                                        device_of(request.cookies.get(DEVICE_COOKIE)))
    except AccountError as exc:
        for key, _free in keys:
            brake.failed(key)
        raise fail(exc) from exc
    brake.succeeded(keys[0][0])
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
        **account_view(account, db),
        "shares_allowed": bool(settings_service.get(db, "shares_allowed")),
        "mail": mailer.configured(db),
        # Why the profile cannot send a confirmation now (empty: it can): no mail server, or no public address.
        "email_confirm": emailaddr.cannot_mail(db),
        "second_factor_setup_required": totp.setup_required(db, account),
        # The editor offers AI only when the operator allows it and the account switched its own service on.
        "ai_ready": ai.ready(db, account),
        # Frag Lore shows in the header whenever the operator allows AI; without a service it says what is missing.
        "ai_allowed": ai.allowed(db),
        # Frag Lore shows only where the operator switched it on and an AI service is ready for this account.
        "lore_allowed": lore.allowed(db),
        "lore": lore.ready(db, account),
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
    shown = check_display_name(payload.display_name)
    if shown and _taken_by_another(db, row.id, shown):
        # Nobody shows up as somebody else: not under another account's name, nor its display name.
        raise error("display_name_taken", "Another account goes by this name.", 409)
    row.display_name = shown
    db.commit()
    return account_view(row)


class EmailIn(BaseModel):
    address: str = Field(default="", max_length=400)


def _address_error(exc: emailaddr.AddressError) -> HTTPException:
    return error(exc.code, exc.message, exc.status)


@router.put("/me/email", summary="Enter the own mail address; it counts once the link mailed to it is opened")
def set_own_email(payload: EmailIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    try:
        sent = emailaddr.request(db, row, payload.address)
    except emailaddr.AddressError as exc:
        raise _address_error(exc) from exc
    return {**account_view(row), "sent": sent}


@router.post("/me/email/resend", summary="Mail the link for the waiting address once more")
def resend_own_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    try:
        emailaddr.resend(db, row)
    except emailaddr.AddressError as exc:
        raise _address_error(exc) from exc
    return account_view(row)


@router.delete("/me/email/pending", summary="Forget the address that waits for its confirmation")
def cancel_own_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    emailaddr.cancel(db, row)
    return account_view(row)


@router.delete("/me/email", summary="Remove the own mail address")
def remove_own_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    try:
        emailaddr.remove(db, row)
    except emailaddr.AddressError as exc:
        raise _address_error(exc) from exc
    return account_view(row)


@router.post("/me/email/provider", summary="Take the address the sign-in provider reports instead of the own one")
def take_provider_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    try:
        emailaddr.take_offer(db, row)
    except emailaddr.AddressError as exc:
        raise _address_error(exc) from exc
    return account_view(row)


@router.delete("/me/email/provider", summary="Keep the own address and stop offering the provider's one")
def decline_provider_email(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    emailaddr.decline_offer(db, row)
    return account_view(row)


class EmailConfirmIn(BaseModel):
    token: str = Field(min_length=1, max_length=200)


@router.post("/email/confirm", summary="The link from the mail: the waiting address counts (no sign-in needed)")
def confirm_email(payload: EmailConfirmIn, db: DbSession) -> dict[str, str]:
    try:
        row = emailaddr.confirm(db, payload.token)
    except emailaddr.AddressError as exc:
        raise _address_error(exc) from exc
    return {"email": row.email, "name": row.name}


def _taken_by_another(db: DbSession, own_id: int, shown: str) -> bool:
    folded = unicodedata.normalize("NFKC", shown).casefold()
    for other_id, name, display in db.execute(select(AccountRow.id, AccountRow.name, AccountRow.display_name)):
        if other_id == own_id:
            continue
        for taken in (name, display):
            if taken and unicodedata.normalize("NFKC", taken).casefold() == folded:
                return True
    return False


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
    # The providers each account is linked to, as marks in the operator's list (the shared sign-in blueprint 04).
    linked: dict[int, list[dict[str, Any]]] = {}
    for link, entry in db.execute(
        select(OidcLink, OidcProvider).join(OidcProvider, OidcProvider.id == OidcLink.provider_id)
        .order_by(OidcProvider.position, OidcProvider.id)
    ):
        linked.setdefault(link.account_id, []).append({"id": entry.id, "slug": entry.slug, "label": entry.label})
    return [
        {**account_view(row), "spaces": spaces.get(row.id, 0), "locked": accounts.is_locked(row),
         "providers": linked.get(row.id, [])}
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


class AccountEmailIn(BaseModel):
    address: str = Field(default="", max_length=400)
    current_password: str = Field(default="", max_length=200)


@router.put("/accounts/{account_id}/email", summary="Give an account a mail address (counts at once); empty removes it")
def set_account_email(
    account_id: int, payload: AccountEmailIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    me_row = db.get(AccountRow, operator.id)
    assert me_row is not None
    try:
        emailaddr.set_by_operator(db, row, payload.address, me_row)
    except emailaddr.AddressError as exc:
        raise _address_error(exc) from exc
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
