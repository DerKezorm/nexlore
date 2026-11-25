"""Setting up the first account, signing in and out, a forgotten password, and the own account.

Setup, sign-in, the profile and a forgotten password run through the shared account module (``vendor/nexkonten``,
store ``services/konten_store.py``), the same in every nex app; the routes and their field names stay as 1.16.0 had
them (``name`` is the username, at sign-in "Username or email"). The operator's list of accounts is in
``routers/accounts.py``; invitations, members and reset links in ``routers/members.py``.
"""

from __future__ import annotations

import logging
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
    behind_unknown_proxy,
    client_ip,
    confirm_fresh_session,
    fresh_from_provider,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
)
from ..errors import detail, error
from ..models import OPERATOR, SESSION_VIA_PASSWORD, SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..security import (
    DEVICE_COOKIE,
    DEVICE_DAYS,
    MIN_PASSWORD,
    SESSION_COOKIE,
    brake,
    device_of,
    end_all_sessions,
    end_session,
    server_key,
    session_account,
    session_cookie_age,
    session_uid,
    session_via,
    start_session,
)
from ..services import (
    accounts,
    ai,
    appearance,
    avatars,
    emailaddr,
    guide,
    kontenpost,
    locales,
    lore,
    settings_service,
    totp,
)
from ..services.accounts import AccountError
from ..services.konten_store import KontenStore, former_names_of
from ..services.oidc_store import SqlStore
from ..vendor import nexkonten
from ..vendor.nexkonten import login as konten_login
from ..vendor.nexkonten import profiles, resets
from ..vendor.nexkonten import sessions as konten_sessions
from ..vendor.nexkonten import setup as konten_setup
from ..vendor.nexkonten.brake import DOOR_FORGOT, door_key
from ..vendor.nexoidc import providers
from . import themes as theme_routes

logger = logging.getLogger("nexlore.auth")

router = APIRouter(prefix="/api", tags=["auth"])

#: The languages inside the frontend; others come as files from the operator.
SHIPPED = ("en", "de")
#: Names a sign-in waiting for its second factor (``services/totp.py``), and nothing else.
PENDING_COOKIE = "nexlore_2fa"


class SetupIn(BaseModel):
    #: The username (the field kept its name); left out, a suggestion from the display name.
    name: str | None = Field(default=None, max_length=64)
    password: str = Field(max_length=200)
    #: The password typed a second time; checked when given (see ``check_confirm``).
    password_confirm: str | None = Field(default=None, max_length=200)
    #: Since the shared account module: the display name (required; a form of 1.16.0 without it takes the username).
    display_name: str | None = Field(default=None, max_length=200)
    email: str = Field(default="", max_length=255)
    language: str = Field(default="", max_length=16)
    #: The setup code from the server's log (or NEXLORE_SETUP_TOKEN).
    code: str = Field(default="", max_length=200)


class LoginIn(BaseModel):
    #: "Username or email" (the field kept its name): an address is looked up by its @.
    name: str = Field(max_length=255)
    password: str = Field(max_length=200)
    #: "Stay signed in" (on from the start): 30 days from the last use; without it the browser's session only.
    remember: bool = True


class ForgotIn(BaseModel):
    #: "Username or email".
    name: str = Field(max_length=255)


class PasswordChangeIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)
    #: The new password typed a second time; checked when given (see ``check_confirm``).
    password_confirm: str | None = Field(default=None, max_length=200)


class LanguageIn(BaseModel):
    language: str = Field(max_length=16)


class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    #: A new username (since the shared account module).
    name: str | None = Field(default=None, max_length=64)
    #: The own password, for a new username or address of an account that has one.
    password: str = Field(default="", max_length=200)


class SwitchIn(BaseModel):
    on: bool


class OperatorConfirmIn(BaseModel):
    #: The operator's own password once more (see ``deps.confirm_operator``); empty for an account from a provider.
    current_password: str = Field(default="", max_length=200)


def secure_cookie(request: Request) -> bool:
    mode = get_settings().cookie_secure.lower()
    if mode == "on":
        return True
    if mode == "off":
        return False
    # The scheme as ``ForwardedSchemeMiddleware`` left it: the connection's own, or the rightmost value of
    # ``X-Forwarded-Proto`` from a proxy in ``NEXLORE_TRUSTED_PROXIES``, never the header of anybody else (the shared
    # sign-in module README, "Hinter einem Proxy"). Behind a proxy nexlore was not told about: ``on``.
    return request.url.scheme == "https"


def _set_cookie(response: Response, request: Request, token: str, remember: bool = True) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=session_cookie_age(remember),
        httponly=True,
        samesite="lax",
        secure=secure_cookie(request),
        path="/",
    )


def fail(exc: AccountError | nexkonten.AccountError) -> HTTPException:
    """A refusal of nexlore's own account code or of the shared module, in nexlore's form: the module's codes answer
    under the names 1.16.0 used where it had others (``public_code``, with the module's own as ``account_code``); a
    brake answers 429 with ``Retry-After``."""
    code = getattr(exc, "public_code", exc.code)
    values = dict(getattr(exc, "extra", {}) or {})
    if code != exc.code:
        values["account_code"] = exc.code
    if exc.code == "too_many_attempts":
        wait = int(values.get("retry_after") or 1)
        return HTTPException(status_code=429, detail=detail(code, exc.message, **values),
                             headers={"Retry-After": str(wait)})
    return error(code, exc.message, exc.status, **values)


def too_many(wait: float) -> HTTPException:
    seconds = max(1, int(wait + 0.999))
    return HTTPException(
        status_code=429,
        detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=seconds),
        headers={"Retry-After": str(seconds)},
    )


def check_password(password: str) -> None:
    try:
        nexkonten.names.check_password_rule(password)
    except nexkonten.AccountError as exc:
        raise error("password_too_short", f"Use at least {MIN_PASSWORD} characters.", 422,
                    minimum=MIN_PASSWORD) from exc


def check_confirm(password: str, confirm: str | None) -> None:
    """A new password typed twice must be the same twice. The web pages always send the second one; a client that
    leaves it out (a script, a form of 1.16.0) is not checked, since only a person typing can mistype."""
    if confirm is not None and confirm != password:
        raise error("password_mismatch", "The passwords do not match.", 422, field="password_confirm")


def check_language(language: str) -> str:
    """Empty (the browser decides) or a language nexlore has."""
    if language and language not in SHIPPED and language not in {item.code for item in locales.available()}:
        raise error("unknown_language", "nexlore does not have this language.", 422)
    return language


def account_view(account: AccountRow, db: Session | None = None) -> dict[str, Any]:
    store = KontenStore(db) if db is not None else None
    waiting = KontenStore._waiting(account)
    formers = former_names_of(db, account.id) if db is not None else []
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
        # Where it came from, as 1.16.0 named it: own, operator, invite, provider.
        "email_source": emailaddr.source_of(account),
        # The address counts (signing in, a forgotten password) and was proven by a link (the shared module).
        "email_confirmed": bool(account.email_confirmed) if account.email else True,
        "email_proven": bool(account.email_proven),
        # The address that waits for its link; ``email_pending`` is the name of 1.16.0.
        "pending_email": waiting,
        "email_pending": waiting,
        # The username before the last change ("formerly …" under the field).
        "former_name": formers[0] if formers else "",
        # The address a sign-in provider knows the account by, offered on the account page, and whose it is.
        "provider_email": KontenStore._offered(account) if account.sign_in == SIGN_IN_PASSWORD else "",
        "provider_email_from": account.provider_email_from or "",
        "new_sign_in_mail": bool(account.new_sign_in_mail),
        # A password set through a link: the account page lists the ways in that stayed, until put away.
        "new_password_origin": account.new_password_origin or "",
        # The password was set through the operator's link (or the emergency command); said once.
        "password_reset_notice": bool(account.password_reset_notice),
        "language": account.language,
        "two_factor": bool(account.totp_secret_enc),
        # "On" or "Off" beside the heading of the second factor (``SECOND_FACTOR_STATE``).
        "factor_state": nexkonten.factor.state(store, account.id) if store is not None else (
            nexkonten.SECOND_FACTOR_ACTIVE if account.totp_secret_enc else nexkonten.SECOND_FACTOR_NONE),
        # NEXLORE_SECOND_FACTOR_OFF: the emergency hammer holds, no second factor is asked of anybody.
        "second_factor_off": nexkonten.factor.switched_off(),
        "two_factor_recovery_left": len(totp.load_recovery(account.totp_recovery)) if account.totp_secret_enc else 0,
        "password_changed_at": account.password_changed_at.isoformat() if account.password_changed_at else None,
        "created_at": account.created_at.isoformat(),
        "last_seen_at": account.last_seen_at.isoformat() if account.last_seen_at else None,
        "avatar": account.avatar_at.isoformat() if account.avatar_at else None,
    }


def known_device(db: DbSession, request: Request, response: Response, account: AccountRow) -> None:
    """Marks this browser as one the account signed in with (the cookie of known browsers, the shared module's
    marks: random per account, signed, no account id in it; up to five accounts per browser)."""
    store = KontenStore(db)
    mark = konten_sessions.mark(server_key(), store.device_key(account.id))
    db.commit()
    value = konten_sessions.add_mark(request.cookies.get(DEVICE_COOKIE, ""), mark)
    response.set_cookie(DEVICE_COOKIE, value, max_age=DEVICE_DAYS * 86400, httponly=True,
                        samesite="lax", secure=secure_cookie(request), path="/api/auth")


def browser_mark(db: Session, request: Request, account_id: int) -> str:
    """The mark of a browser that signed in as this account before, "" for none: a mark of the shared module, or a
    cookie of 1.16.0 (``<id>.<nonce>.<mark>``, read for one version so that owners stay known)."""
    cookie = request.cookies.get(DEVICE_COOKIE, "")
    if not cookie:
        return ""
    store = KontenStore(db)
    try:
        key = store.device_key(account_id)
    except LookupError:
        return ""
    return konten_sessions.known_mark(cookie, server_key(), key, older=lambda entry: device_of(entry) == account_id)


def sign_in(db: DbSession, request: Request, response: Response, account: AccountRow,
            via: str = SESSION_VIA_PASSWORD, *, remember: bool = True, tell: bool = False) -> dict[str, Any]:
    """The session starts. ``tell``: a sign-in by its owner (password, provider, passkey), not right after a setup
    or an invitation; from a browser that never signed in as the account, a confirmed address hears of it ("A new
    sign-in", unless the person turned that off)."""
    kontenpost.note_browser_language(account, request.headers.get("accept-language", ""))
    known = bool(browser_mark(db, request, account.id))
    token = start_session(db, account, client_ip(request), request.headers.get("user-agent", ""), via,
                          remember=remember)
    _set_cookie(response, request, token, remember)
    # This browser is known from now on: a lock that strangers cause by guessing does not keep it out, and the brake
    # per sender lets it pass.
    if not known:
        known_device(db, request, response, account)
        if tell:
            store = KontenStore(db)
            konto = store.get_account(account.id)
            mail = konten_sessions.new_sign_in(konto, known=False, wanted=bool(account.new_sign_in_mail)) \
                if konto else None
            if kontenpost.queue(db, mail, where=request.headers.get("user-agent", "")):
                logger.info("Mail about a new sign-in queued name=%s", account.name)
    logger.info("Signed in name=%s", account.name)
    return account_view(account, db)


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
        raise too_many(wait)
    language = check_language(payload.language)
    check_confirm(payload.password, payload.password_confirm)
    store = KontenStore(db)
    # A form of 1.16.0 sends the username alone: it stands in for the display name.
    shown = payload.display_name if payload.display_name is not None else (payload.name or "")
    username = payload.name if payload.name is not None else nexkonten.names.suggest_username(shown)
    try:
        done = konten_setup.setup(
            store, code=payload.code, display_name=shown, username=username, email=payload.email,
            password=payload.password, language=language,
        )
    except nexkonten.AccountError as exc:
        if exc.code == "setup_code_wrong":
            brake.failed(key)
            logger.warning("Setup refused: wrong setup code")
        raise fail(exc) from exc
    account = db.get(AccountRow, int(done.account.id))
    assert account is not None
    # A first start with an empty vault: the guide, in the language chosen here.
    guide.on_first_start(account.id, language)
    return sign_in(db, request, response, account)


@router.get("/auth/methods", summary="How one can sign in here (no sign-in needed)")
def methods(db: DbSession) -> dict[str, Any]:
    # The buttons of the sign-in page: slug and label of each active provider, nothing else (vendor/nexoidc).
    password = bool(settings_service.get(db, "password_login"))
    return {
        "password": password,
        "providers": providers.public_list(SqlStore(db)),
        # "Sign in with a passkey" (the operator's switch, on from the start).
        "passkeys": bool(settings_service.get(db, "passkeys_allowed")),
        # "Forgot your password?" by mail: a mail server, the public address and signing in by password.
        "forgot_mail": password and kontenpost.can_mail(db),
    }


@router.post("/auth/login", summary="Sign in with username or email and password")
def login(payload: LoginIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    """The shared account module checks behind its brake (``login.sign_in``): one answer for everything wrong, as
    long for an unknown name as for a wrong password, failures counted at the account and its lock after ten (a
    browser that signed in as the account before passes the lock). While only the count of the account (or of what
    was typed) waits, the answer is the one of a wrong password (401); 429 only when the sender's own count is full.
    A known browser counts in a pot of its own."""
    ip = client_ip(request)
    behind_unknown_proxy(request)
    store = KontenStore(db)
    meant = konten_login.resolve_login(store, payload.name)
    mark = browser_mark(db, request, int(meant.id)) if meant is not None else ""
    known = meant.id if mark and meant is not None else None
    try:
        konto = konten_login.sign_in(store, payload.name, payload.password, sender=ip, browser=mark,
                                     known_browser=known)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    account = db.get(AccountRow, int(konto.id))
    assert account is not None
    if not settings_service.get(db, "password_login") and account.role != OPERATOR:
        # The operator keeps the password as the way in when the provider is down.
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    step = nexkonten.common.next_step(store, konto)
    if step in (nexkonten.NEXT_SECOND_FACTOR, nexkonten.NEXT_PASSKEY):
        # Nothing opens yet: the browser gets a short-lived cookie that names the waiting sign-in and nothing else.
        response.set_cookie(
            PENDING_COOKIE,
            totp.start_pending(account.id, remember=payload.remember),
            max_age=totp.PENDING_SECONDS,
            httponly=True,
            samesite="lax",
            secure=secure_cookie(request),
            path="/api/auth",
        )
        logger.info("Password accepted, second factor waiting name=%s", account.name)
        # The answer of 1.16.0 stays as it was; ``code: false`` is the module's ``next`` = ``passkey``.
        answer: dict[str, Any] = {"second_factor": True}
        if store.passkeys_of(account.id):
            answer["passkey"] = True
        if step == nexkonten.NEXT_PASSKEY:
            answer["code"] = False
        return answer
    konten_login.succeeded(store, account.id)
    return sign_in(db, request, response, account, remember=payload.remember, tell=True)


#: Answered at once, the same whatever was typed: the search, the link and the mail run after the answer.
@router.post("/auth/forgot", status_code=202, summary="Forgot your password? A link by mail (with a mail server)")
def forgot(payload: ForgotIn, request: Request, db: DbSession) -> dict[str, Any]:
    # The requests of one sender count at the module's brake (``forgot:<sender>``, ten free), the same for every input
    # and also without a mail server; the account counts in the worker (``mail:<id>``).
    sender = client_ip(request)

    def send(mail: nexkonten.Mail) -> None:
        # At once, never through the outbox: a mail that fails takes its link with it.
        from ..db import SessionLocal

        with SessionLocal() as own:
            kontenpost.deliver_now(own, mail)

    try:
        if settings_service.get(db, "password_login") and kontenpost.can_mail(db):
            resets.forgot_in_background(payload.name, open_store=_own_store, send=send, later=_later, sender=sender)
        else:
            nexkonten.common.counted((door_key(DOOR_FORGOT, sender),))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {"sent": True}


def _own_store():
    from ..services.konten_store import own_store

    return own_store()


#: Tests run the work of "Forgot your password?" before the answer, to see its mail.
FORGOT_AT_ONCE = False


def _later(job) -> None:
    """The rest of "Forgot your password?" after the answer, in a thread of its own (the time of the answer must
    tell nobody whether there was an account). Tests run it at once (``FORGOT_AT_ONCE``)."""
    if FORGOT_AT_ONCE:
        job()
        return
    import threading

    threading.Thread(target=job, name="nexlore-forgot", daemon=True).start()


@router.post("/auth/logout", status_code=204, summary="Sign out in this browser")
def logout(request: Request, response: Response, db: DbSession) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    account = session_account(db, token)
    end_session(db, token)
    if account is not None:
        logger.info("Signed out name=%s", account.name)
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.post("/auth/logout-all", status_code=204, summary="Sign out every other browser of the own account")
def logout_everywhere(request: Request, response: Response, account: Account, db: DbSession) -> None:
    end_all_sessions(db, account.id, except_token=request.cookies.get(SESSION_COOKIE))
    # The other browsers are not known any more; this one stays known.
    row = db.get(AccountRow, account.id)
    if row is not None:
        db.refresh(row)
        known_device(db, request, response, row)
    logger.info("All other sessions ended by their owner name=%s", account.name)


@router.get("/auth/me", summary="The signed-in account, and what this server offers it")
def me(account: Account, db: DbSession, request: Request) -> dict[str, Any]:
    return {
        **account_view(account, db),
        "shares_allowed": bool(settings_service.get(db, "shares_allowed")),
        "mail": kontenpost.configured(db),
        # Why the profile cannot send a confirmation now (empty: it can): no mail server, or no public address.
        "email_confirm": emailaddr.cannot_mail(db),
        "min_password": MIN_PASSWORD,
        "second_factor_setup_required": totp.setup_required(
            db, account, session_via(db, request.cookies.get(SESSION_COOKIE))
        ),
        # API tokens, MCP and OAuth keys and the calendar address have no session: they ask the account, so they stay
        # dead for a password account without a second factor even where this session is spared the duty (it came
        # in through a provider that checks the factor). The page says so beside them.
        "keys_need_second_factor": totp.setup_required(db, account),
        # The editor offers AI only when the operator allows it and the account switched its own service on.
        "ai_ready": ai.ready(db, account),
        # Frag Lore shows in the header whenever the operator allows AI; without a service it says what is missing.
        "ai_allowed": ai.allowed_for(db, account),
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
def change_password(payload: PasswordChangeIn, request: Request, response: Response, account: Account,
                    db: DbSession) -> None:
    row = db.get(AccountRow, account.id)
    assert row is not None
    if row.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    check_password(payload.new)
    check_confirm(payload.new, payload.password_confirm)
    reauth_guard(request, row)
    try:
        accounts.change_password(db, row, payload.current, payload.new)
    except AccountError as exc:
        if exc.code == "wrong_password":
            reauth_failed(request, db, row)
        raise fail(exc) from exc
    reauth_succeeded(request, db, row)
    # Other browsers must sign in again and are not known any more; this one stays, and stays known.
    end_all_sessions(db, row.id, except_token=request.cookies.get(SESSION_COOKIE))
    db.refresh(row)
    known_device(db, request, response, row)


def confirmed_without_password(request: Request, db: Session, row: AccountRow) -> bool:
    """An account without a password of its own here proves it is still them by a fresh sign-in at its provider
    (``deps.fresh_from_provider``, the same as for an operator act); then the module asks for nothing more."""
    if row.sign_in == SIGN_IN_PASSWORD and row.password_hash:
        return False
    fresh_from_provider(request, db, row)
    return True


#: The name of nexnotes' helper, which the shared passkey routes of the template use.
_confirmed_without_password = confirmed_without_password


def _device_bearer(request: Request) -> bool:
    return request.headers.get("authorization", "")[:7].lower() == "bearer "


@router.put("/me/profile", summary="The own display name, username and address; empty display name shows the name")
def set_profile(payload: ProfileIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    """Field by field through the shared module: the display name without a password (it may be empty: then the
    username shows), a new username and a new address with the own password (an account without one: a fresh
    sign-in at its provider). With a mail server a new address waits for the link sent there; without one it counts
    at once. A new username carries the account's history along (``konten_store.set_username``)."""
    row = db.get(AccountRow, account.id)
    assert row is not None
    changes_email = payload.email is not None and payload.email.strip().lower() != (row.email or "").lower()
    changes_name = payload.name is not None and payload.name.strip().lower() != row.name.lower()
    if _device_bearer(request) and (changes_email or changes_name):
        raise error("browser_only", "Change this in the browser.", 403)
    store = KontenStore(db)
    try:
        if payload.display_name is not None and payload.display_name != row.display_name:
            profiles.change_display_name(store, row.id, payload.display_name, actor_id=row.id)
        fresh = confirmed_without_password(request, db, row) if (changes_email or changes_name) else False
        if changes_name:
            notice = profiles.change_username(store, row.id, payload.name or "", actor_id=row.id,
                                              password=payload.password, actor_confirmed=fresh)
            kontenpost.queue(db, notice)
            logger.info("Username changed by its owner account_id=%s", row.id)
        if changes_email:
            changed = profiles.change_email(store, row.id, payload.email or "", password=payload.password,
                                            actor_confirmed=fresh, mail=kontenpost.can_mail(db))
            kontenpost.queue(db, changed.mail)
            kontenpost.queue(db, changed.notice)
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    db.refresh(row)
    return account_view(row, db)


class EmailIn(BaseModel):
    address: str = Field(default="", max_length=400)
    password: str = Field(default="", max_length=200)


def _change_email(request: Request, db: Session, row: AccountRow, address: str, password: str) -> dict[str, Any]:
    if _device_bearer(request):
        raise error("browser_only", "Change this in the browser.", 403)
    store = KontenStore(db)
    try:
        fresh = confirmed_without_password(request, db, row)
        changed = profiles.change_email(store, row.id, address, password=password, actor_confirmed=fresh,
                                        mail=kontenpost.can_mail(db))
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    kontenpost.queue(db, changed.mail)
    kontenpost.queue(db, changed.notice)
    db.refresh(row)
    return {**account_view(row, db), "sent": changed.mail is not None}


@router.put("/me/email", summary="Enter the own mail address (with the password); with a mail server it waits for "
                                 "its link")
def set_own_email(payload: EmailIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    return _change_email(request, db, row, payload.address, payload.password)


class PasswordOnlyIn(BaseModel):
    password: str = Field(default="", max_length=200)


@router.delete("/me/email", summary="Remove the own mail address (with the password)")
def remove_own_email(request: Request, account: Account, db: DbSession,
                     payload: PasswordOnlyIn | None = None) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    return _change_email(request, db, row, "", payload.password if payload else "")


@router.post("/me/email/resend", summary="Mail the link for the waiting address once more")
def resend_own_email(account: Account, db: DbSession) -> dict[str, Any]:
    try:
        mail = profiles.resend_email_link(KontenStore(db), account.id)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    kontenpost.queue(db, mail)
    row = db.get(AccountRow, account.id)
    assert row is not None
    return account_view(row, db)


@router.post("/me/email/prove", summary="Mail a link to the own address, to show it is the account's (konten 1.1.0)")
def prove_own_email(account: Account, db: DbSession) -> dict[str, Any]:
    """The box "Address not confirmed yet" of the profile: an address entered from now on without a link counts, but
    is not proven until its owner opens one."""
    if not kontenpost.can_mail(db):
        raise error("mail_off", "No mail server is set up.", 409)
    try:
        mail = profiles.prove_email(KontenStore(db), account.id)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    if not kontenpost.queue(db, mail):
        raise error("mail_failed", "The mail server did not take the mail.", 502)
    row = db.get(AccountRow, account.id)
    assert row is not None
    return account_view(row, db)


@router.delete("/me/email/pending", summary="Forget the address that waits for its confirmation")
def cancel_own_email(account: Account, db: DbSession) -> dict[str, Any]:
    profiles.withdraw_email_change(KontenStore(db), account.id)
    row = db.get(AccountRow, account.id)
    assert row is not None
    db.refresh(row)
    return account_view(row, db)


@router.post("/me/email/provider", summary="Take the address the sign-in provider reports (with the password)")
def take_provider_email(request: Request, account: Account, db: DbSession,
                        payload: PasswordOnlyIn | None = None) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    if not KontenStore._offered(row):
        raise error("email_no_offer", "The provider reports no other address.", 404)
    store = KontenStore(db)
    try:
        fresh = confirmed_without_password(request, db, row)
        changed = profiles.take_offered_email(store, row.id, password=payload.password if payload else "",
                                              actor_confirmed=fresh, mail=kontenpost.can_mail(db))
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    kontenpost.queue(db, changed.mail)
    kontenpost.queue(db, changed.notice)
    db.refresh(row)
    return account_view(row, db)


@router.delete("/me/email/provider", summary="Keep the own address and stop offering the provider's one")
def decline_provider_email(account: Account, db: DbSession) -> dict[str, Any]:
    profiles.dismiss_offered_email(KontenStore(db), account.id)
    row = db.get(AccountRow, account.id)
    assert row is not None
    db.refresh(row)
    return account_view(row, db)


class EmailConfirmIn(BaseModel):
    token: str = Field(min_length=1, max_length=200)


def _confirm_email(token: str, request: Request, db: Session) -> dict[str, Any]:
    key = "email-link:" + client_ip(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise too_many(wait)
    try:
        changed = profiles.confirm_email(KontenStore(db), token[:200])
    except nexkonten.AccountError as exc:
        if exc.code in ("email_link_invalid", "email_link_expired"):
            brake.failed(key)
        raise fail(exc) from exc
    kontenpost.queue(db, changed.notice)
    return {"email": changed.account.email, "name": changed.account.username}


@router.post("/email/confirm", summary="The link from a mail of 1.16.0: the waiting address counts (no sign-in needed)")
def confirm_email(payload: EmailConfirmIn, request: Request, db: DbSession) -> dict[str, Any]:
    return _confirm_email(payload.token, request, db)


@router.get("/email/{token}", summary="Which address a confirmation link confirms (no sign-in needed)")
def email_link_state(token: str, db: DbSession) -> dict[str, Any]:
    try:
        change = profiles.email_change_state(KontenStore(db), token[:200])
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {"email": change.address}


@router.post("/email/{token}", summary="Confirm a new address with the link sent there (no sign-in needed)")
def confirm_email_link(token: str, request: Request, db: DbSession) -> dict[str, Any]:
    return _confirm_email(token, request, db)


@router.put("/me/new-sign-in-mail", summary="A mail when a browser signs in for the first time: on or off")
def set_new_sign_in_mail(payload: SwitchIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.new_sign_in_mail = payload.on
    db.commit()
    return account_view(row, db)


# --- Where am I signed in, and what still has access ---------------------------------------------------------------


@router.get("/auth/sessions", summary="Where the own account is signed in: browsers and paired devices")
def my_sessions(request: Request, account: Account, db: DbSession) -> list[dict[str, Any]]:
    current = session_uid(db, request.cookies.get(SESSION_COOKIE))
    language = (account.language or account.browser_language or "en")[:2].lower()
    return konten_sessions.listing(KontenStore(db), account.id, current, language=language)


@router.delete("/auth/sessions/{uid}", status_code=204, summary="Sign one browser or device of the own account out")
def end_one_session(uid: str, request: Request, account: Account, db: DbSession) -> None:
    if uid == session_uid(db, request.cookies.get(SESSION_COOKIE)):
        raise error("use_logout", "Sign out of this browser with Sign out.", 409)
    if not konten_sessions.sign_out(KontenStore(db), account.id, uid[:40]):
        raise error("not_found", "Not found.", 404)
    db.commit()
    logger.info("Session ended by its owner name=%s", account.name)


@router.get("/auth/access", summary="What still has access after a password set through a link")
def remaining_access(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    return {
        "origin": row.new_password_origin or "",
        "access": [
            {"id": str(item.id), "kind": item.kind, "label": item.label,
             "last_used_at": item.last_used_at.isoformat() if item.last_used_at else None}
            for item in KontenStore(db).list_access(account.id)
        ],
    }


@router.post("/auth/access/disconnect", summary="Disconnect all: every device, key, calendar address and passkey")
def disconnect_all(request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    confirm_fresh_session(request, db, account)
    count = resets.disconnect_all(KontenStore(db), account.id)
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.new_password_origin = ""
    db.commit()
    return {"disconnected": count}


@router.post("/auth/access/seen", summary="The list of what still has access is put away")
def remaining_access_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.new_password_origin = ""
    db.commit()
    return account_view(row, db)


@router.post("/me/password-reset-notice/seen",
             summary="The notice that the password was set through somebody else's link is read")
def password_reset_notice_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.password_reset_notice = False
    db.commit()
    return account_view(row, db)


@router.post("/me/whats-new/seen", summary="\"What's new\" of the running version is read or put away")
def whats_new_seen(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    row.whats_new_seen = __version__
    db.commit()
    return account_view(row, db)


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
    return account_view(row, db)


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
