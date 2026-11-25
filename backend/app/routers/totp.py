"""The second factor: enrol, confirm, turn off, new recovery codes, the code step of a sign-in, the operator's reset.

The password step of a sign-in lives in ``routers/auth.py``; when the account has a second factor it answers
``{"second_factor": true}`` and leaves a short-lived cookie. The code step here turns that into the session.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Path, Request, Response
from pydantic import BaseModel, Field

from ..deps import (
    Account,
    DbSession,
    OperatorAccount,
    confirm_operator,
    reauth_failed,
    reauth_guard,
    reauth_succeeded,
)
from ..errors import error
from ..models import SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..security import account_out
from ..services import accounts, kontenpost, totp
from ..services.konten_store import KontenStore
from ..vendor import nexkonten
from ..vendor.nexkonten import factor
from .auth import PENDING_COOKIE, OperatorConfirmIn, account_view, fail, sign_in

logger = logging.getLogger("nexlore.auth")

router = APIRouter(prefix="/api", tags=["second factor"])


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)


class ConfirmIn(BaseModel):
    code: str = Field(max_length=32)
    password: str = Field(max_length=200)


class CodeIn(BaseModel):
    code: str = Field(max_length=32)


def _row(db: DbSession, account: AccountRow) -> AccountRow:
    row = db.get(AccountRow, account.id)
    if row is None:
        raise error("sign_in_required", "Sign in first.", 401)
    return row


def _check_password(request: Request, db: DbSession, row: AccountRow, password: str) -> None:
    """The password once more, counted like a sign-in: a stolen cookie must not be a place to guess it."""
    if row.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    reauth_guard(request, row)
    if not accounts.check_password(row, password):
        reauth_failed(request, db, row)
        raise error("wrong_password", "The current password is wrong.", 401)
    reauth_succeeded(request, db, row)


def _clear_pending_cookie(response: Response) -> None:
    response.delete_cookie(PENDING_COOKIE, path="/api/auth")


# --- Enrolment --------------------------------------------------------------------------------------------------------


def _enrolment(enrolment: factor.Enrolment, name: str) -> dict[str, Any]:
    uri = totp.provisioning_uri(enrolment.seed, name)
    expires = enrolment.expires_at.isoformat() if enrolment.expires_at is not None else None
    return {"secret": enrolment.seed, "uri": uri, "qr_svg": totp.qr_svg(uri), "expires_at": expires}


@router.post("/auth/totp/begin", summary="Start enrolling an authenticator app; the seed is shown once")
def begin(account: Account, db: DbSession) -> dict[str, Any]:
    if account.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    if account.totp_secret_enc:
        raise error("totp_enabled", "The second factor is on already. Turn it off first.", 409)
    # The shared module keeps the waiting seed sealed in the database (since 0.3.3): a restart between the QR code
    # and the first code loses nothing.
    return _enrolment(factor.begin_totp(KontenStore(db), account.id, issuer="nexlore"), account.name)


@router.get("/auth/totp/setup", summary="The authenticator that waits for its first code, once more")
def waiting_setup(account: Account, db: DbSession) -> dict[str, Any]:
    """``factor.pending_setup`` (konten 0.3.4): the same QR code and secret as ``begin`` gave while the setup waits
    (the page was reloaded, another tab), ``{"waiting": false}`` when nothing waits. Reading it changes nothing."""
    held = factor.pending_setup(KontenStore(db), account.id, issuer="nexlore")
    if held is None or account.totp_secret_enc:
        return {"waiting": False}
    return {"waiting": True, **_enrolment(held, account.name)}


@router.post("/auth/totp/confirm", summary="Finish enrolling: a code from the app and the password")
def confirm(payload: ConfirmIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    if row.totp_secret_enc:
        raise error("totp_enabled", "The second factor is on already. Turn it off first.", 409)
    store = KontenStore(db)
    held = store.pending_totp(row.id)
    if held is None or held[1] <= nexkonten.common.utcnow():
        raise error("totp_enrolment_expired", "The enrolment timed out. Start again.", 410)
    _check_password(request, db, row, payload.password)
    if row.totp_recovery:
        # New codes with every new authenticator, as in 1.16.0 (the module keeps codes an account has).
        store.set_recovery(row.id, [])
    try:
        done = factor.confirm_totp(store, row.id, payload.code, actor_confirmed=True)
    except nexkonten.AccountError as exc:
        db.rollback()
        if exc.code == "enrolment_expired":
            raise error("totp_enrolment_expired", "The enrolment timed out. Start again.", 410) from exc
        if exc.code == "code_wrong":
            raise error("totp_code_wrong", "The code is not right. Check the time on your phone and try again.",
                        422) from exc
        raise fail(exc) from exc
    db.refresh(row)
    logger.info("Second factor turned on name=%s", row.name)
    # ``next``: show the codes once (``show_codes``), then on.
    return {"recovery_codes": done.codes, "next": done.next, "account": account_view(row)}


@router.post("/auth/totp/disable", summary="Turn the second factor off; needs the password")
def disable(payload: PasswordIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    """Through the shared module only (``factor.disable_totp``, konten 0.3.5): the password counts at its brake, a
    required factor stays (``factor_required``), a setup that waits ends too."""
    row = _row(db, account)
    if not row.totp_secret_enc:
        raise error("totp_not_enabled", "The second factor is not on.", 409)
    if row.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    try:
        factor.disable_totp(KontenStore(db), row.id, password=payload.password)
    except nexkonten.AccountError as exc:
        db.rollback()
        raise fail(exc) from exc
    row.totp_last_step = 0
    db.commit()
    totp.forget_account(row.id)
    db.refresh(row)
    logger.info("Second factor turned off name=%s", row.name)
    return account_view(row)


@router.post("/auth/totp/recovery", summary="New recovery codes; the old ones stop working")
def new_recovery_codes(payload: PasswordIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    if not row.totp_secret_enc:
        raise error("totp_not_enabled", "The second factor is not on.", 409)
    _check_password(request, db, row, payload.password)
    try:
        codes = factor.new_codes(KontenStore(db), row.id, actor_confirmed=True)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    db.refresh(row)
    return {"recovery_codes": codes, "account": account_view(row)}


class FactorResetIn(OperatorConfirmIn):
    #: The paired devices go too (the lost phone may be one of them): on from the start, the page asks.
    disconnect_devices: bool = True
    #: The passkeys go too (a lost phone may carry one): on from the start, the page asks (since konten 0.3.3).
    remove_passkeys: bool = True


@router.get("/accounts/{account_id}/totp/reset", summary="Operator: what a reset of the second factor takes away")
def operator_reset_overview(
    account_id: Annotated[int, Path(ge=1)], operator: OperatorAccount, db: DbSession
) -> dict[str, Any]:
    """``factor.reset_overview``: the authenticator, the recovery codes left, the passkeys by name and the paired
    devices, for the dialog before the reset."""
    try:
        seen = factor.reset_overview(KontenStore(db), account_id, actor_id=operator.id)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    return {
        "authenticator": seen.authenticator,
        "recovery_codes": seen.recovery_codes,
        "passkeys": [{"uid": key.uid, "name": key.name} for key in seen.passkeys],
        "devices": [{"uid": entry.uid, "label": entry.label} for entry in seen.devices],
    }


@router.post("/accounts/{account_id}/totp/reset", summary="Operator: take the second factor of a locked-out account")
def operator_reset(
    account_id: Annotated[int, Path(ge=1)],
    payload: FactorResetIn,
    request: Request,
    operator: OperatorAccount,
    db: DbSession,
) -> dict[str, Any]:
    """Through the shared account module (``factor.operator_reset``): the time-based code, the recovery codes and,
    with ``remove_passkeys``, the passkeys go, every browser session and waiting sign-in ends, with
    ``disconnect_devices`` the paired devices too, and a confirmed address hears of it."""
    confirm_operator(request, db, operator, payload.current_password)
    if account_id == operator.id:
        raise error("use_disable", "Turn your own second factor off on your account page, with your password.", 409)
    row = db.get(AccountRow, account_id)
    if row is None:
        raise error("not_found", "No such account.", 404)
    store = KontenStore(db)
    if not row.totp_secret_enc and not store.passkeys_of(row.id):
        raise error("totp_not_enabled", "The second factor is not on.", 409)
    try:
        mail = factor.operator_reset(store, row.id, actor_id=operator.id, actor_confirmed=True,
                                     disconnect_devices=payload.disconnect_devices,
                                     remove_passkeys=payload.remove_passkeys)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    totp.forget_account(row.id)
    kontenpost.queue(db, mail)
    db.refresh(row)
    logger.warning("Second factor reset by the operator name=%s by=%s, all sessions ended", row.name, operator.name)
    return account_view(row)


# --- The code step of a sign-in ---------------------------------------------------------------------------------------


@router.post("/auth/login/totp", summary="Second step of the sign-in: the code from the app or a recovery code")
def login_code(payload: CodeIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    token = request.cookies.get(PENDING_COOKIE)
    pending = totp.get_pending(token)
    if token is None or pending is None:
        _clear_pending_cookie(response)
        raise error("second_factor_expired", "Start again with your password.", 401)
    row = db.get(AccountRow, pending.account_id)
    if row is None or not (row.totp_secret_enc or totp.load_recovery(row.totp_recovery)):
        # Nothing a code could answer (an account with passkeys only answers with one, ``routers/passkeys``).
        totp.finish_pending(token)
        _clear_pending_cookie(response)
        raise error("second_factor_expired", "Start again with your password.", 401)
    if account_out(row):
        # Blocked between the password and the code: no session.
        totp.finish_pending(token)
        _clear_pending_cookie(response)
        logger.warning("Sign-in refused at the code, account blocked name=%s", row.name)
        raise error("account_blocked", "This account is blocked. Ask the operator to unblock it.", 403)
    if accounts.is_locked(row):
        # Wrong codes count against the account like wrong passwords, whatever address they come from.
        totp.finish_pending(token)
        _clear_pending_cookie(response)
        raise error("account_locked", "Too many failed sign-ins. Try again later.", 429)

    # The code through the shared account module: a time-based code or a recovery code (also those of 1.16.0), each
    # counted once, also for two requests at the same moment.
    store = KontenStore(db)
    try:
        if row.totp_secret_enc and store.totp_seed(row.id) is None:
            raise totp.SeedUnreadable()
        method = factor.check_code(store, row.id, payload.code)
        accepted = True
    except totp.SeedUnreadable:
        # A different secret.key than the one that sealed the seed. Failing closed is the only safe answer; the
        # operator resets the second factor and the person enrols again.
        totp.finish_pending(token)
        _clear_pending_cookie(response)
        raise error(
            "second_factor_unavailable",
            "The second factor cannot be checked on this installation. Ask the operator to reset it.",
            401,
        ) from None
    except nexkonten.AccountError as exc:
        if exc.code == "too_many_attempts":
            # The module counts every code of the account (``code:<id>``, konten 0.3.4), across waiting sign-ins.
            raise fail(exc) from exc
        accepted = False
        method = ""
    db.refresh(row)
    used_recovery = method == "recovery"
    if not accepted:
        accounts.note_failure(db, row)
        still_pending = totp.fail_pending(token) and not accounts.is_locked(row)
        logger.warning("Second factor failed name=%s", row.name)
        if not still_pending:
            totp.finish_pending(token)
            _clear_pending_cookie(response)
            raise error("second_factor_expired", "Too many wrong codes. Start again with your password.", 401)
        raise error("totp_code_wrong", "The code is not right.", 401)

    db.commit()
    accounts.note_success(db, row)
    totp.finish_pending(token)
    _clear_pending_cookie(response)
    if used_recovery:
        logger.warning("Recovery code used name=%s left=%s", row.name, len(totp.load_recovery(row.totp_recovery)))
    else:
        logger.info("Second factor passed name=%s", row.name)
    return sign_in(db, request, response, row, remember=pending.remember, tell=True)


@router.post("/auth/login/totp/cancel", status_code=204, summary="Give up the second step and start over")
def cancel_code(request: Request, response: Response) -> None:
    token = request.cookies.get(PENDING_COOKIE)
    if token:
        totp.finish_pending(token)
    _clear_pending_cookie(response)
