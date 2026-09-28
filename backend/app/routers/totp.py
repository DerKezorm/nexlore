"""The second factor: enrol, confirm, turn off, new recovery codes, the code step of a sign-in, the operator's reset.

The password step of a sign-in lives in ``routers/auth.py``; when the account has a second factor it answers
``{"second_factor": true}`` and leaves a short-lived cookie. The code step here turns that into the session.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Request, Response
from pydantic import BaseModel, Field

from ..deps import Account, DbSession, OperatorAccount, client_ip, reauth_failed, reauth_guard, reauth_succeeded
from ..errors import detail, error
from ..models import SIGN_IN_PASSWORD
from ..models import Account as AccountRow
from ..security import brake, end_all_sessions
from ..services import accounts, totp
from .auth import PENDING_COOKIE, account_view, sign_in

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


@router.post("/auth/totp/begin", summary="Start enrolling an authenticator app; the seed is shown once")
def begin(account: Account) -> dict[str, Any]:
    if account.sign_in != SIGN_IN_PASSWORD:
        raise error("oidc_account", "This account signs in through OIDC.", 409)
    if account.totp_secret_enc:
        raise error("totp_enabled", "The second factor is on already. Turn it off first.", 409)
    seed = totp.begin_enrolment(account.id)
    uri = totp.provisioning_uri(seed, account.name)
    return {"secret": seed, "uri": uri, "qr_svg": totp.qr_svg(uri)}


@router.post("/auth/totp/confirm", summary="Finish enrolling: a code from the app and the password")
def confirm(payload: ConfirmIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    if row.totp_secret_enc:
        raise error("totp_enabled", "The second factor is on already. Turn it off first.", 409)
    seed = totp.pending_seed(row.id)
    if seed is None:
        raise error("totp_enrolment_expired", "The enrolment timed out. Start again.", 410)
    _check_password(request, db, row, payload.password)
    step = totp.verify_code(seed, payload.code)
    if step is None:
        raise error("totp_code_wrong", "The code is not right. Check the time on your phone and try again.", 422)
    codes = totp.generate_recovery_codes()
    row.totp_secret_enc = totp.seal_seed(seed)
    row.totp_recovery = totp.recovery_hashes(codes)
    row.totp_last_step = step
    db.commit()
    totp.drop_enrolment(row.id)
    logger.info("Second factor turned on name=%s", row.name)
    return {"recovery_codes": codes, "account": account_view(row)}


@router.post("/auth/totp/disable", summary="Turn the second factor off; needs the password")
def disable(payload: PasswordIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    if not row.totp_secret_enc:
        raise error("totp_not_enabled", "The second factor is not on.", 409)
    _check_password(request, db, row, payload.password)
    _reset(db, row)
    logger.info("Second factor turned off name=%s", row.name)
    return account_view(row)


@router.post("/auth/totp/recovery", summary="New recovery codes; the old ones stop working")
def new_recovery_codes(payload: PasswordIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    if not row.totp_secret_enc:
        raise error("totp_not_enabled", "The second factor is not on.", 409)
    _check_password(request, db, row, payload.password)
    codes = totp.generate_recovery_codes()
    row.totp_recovery = totp.recovery_hashes(codes)
    db.commit()
    logger.info("Recovery codes renewed name=%s", row.name)
    return {"recovery_codes": codes, "account": account_view(row)}


def _reset(db: DbSession, row: AccountRow) -> None:
    row.totp_secret_enc = ""
    row.totp_recovery = ""
    row.totp_last_step = 0
    db.commit()
    totp.forget_account(row.id)


@router.post("/accounts/{account_id}/totp/reset", summary="Operator: take the second factor of a locked-out account")
def operator_reset(account_id: Annotated[int, Path(ge=1)], operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    if account_id == operator.id:
        raise error("use_disable", "Turn your own second factor off on your account page, with your password.", 409)
    row = db.get(AccountRow, account_id)
    if row is None:
        raise error("not_found", "No such account.", 404)
    if not row.totp_secret_enc:
        raise error("totp_not_enabled", "The second factor is not on.", 409)
    _reset(db, row)
    # A reset is what happens after a lost phone or a suspected intruder: whoever holds a session of that account
    # is thrown out, and signs in afresh with the password alone.
    end_all_sessions(db, row.id)
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
    key = "totp:" + client_ip(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    row = db.get(AccountRow, pending.account_id)
    if row is None or not row.totp_secret_enc:
        totp.finish_pending(token)
        _clear_pending_cookie(response)
        raise error("second_factor_expired", "Start again with your password.", 401)
    if accounts.is_locked(row):
        # Wrong codes count against the account like wrong passwords, whatever address they come from.
        totp.finish_pending(token)
        _clear_pending_cookie(response)
        raise error("account_locked", "Too many failed sign-ins. Try again later.", 429)

    typed = totp.normalize_code(payload.code)
    used_recovery = False
    if len(typed) == totp.DIGITS and typed.isdigit():
        try:
            seed = totp.open_seed(row.totp_secret_enc)
        except totp.SeedUnreadable:
            # A different secret.key than the one that sealed the seed. Failing closed is the only safe answer; the
            # operator resets the second factor and the person enrols again.
            logger.error("Second factor seed unreadable name=%s (secret.key changed?)", row.name)
            totp.finish_pending(token)
            _clear_pending_cookie(response)
            raise error(
                "second_factor_unavailable",
                "The second factor cannot be checked on this installation. Ask the operator to reset it.",
                401,
            ) from None
        step = totp.verify_code(seed, typed, after_step=row.totp_last_step)
        accepted = step is not None
        if step is not None:
            row.totp_last_step = step
    else:
        remaining = totp.use_recovery(row.totp_recovery, typed)
        accepted = remaining is not None
        if remaining is not None:
            row.totp_recovery = remaining
            used_recovery = True
    if not accepted:
        brake.failed(key)
        accounts.note_failure(db, row)
        still_pending = totp.fail_pending(token) and not accounts.is_locked(row)
        logger.warning("Second factor failed name=%s", row.name)
        if not still_pending:
            totp.finish_pending(token)
            _clear_pending_cookie(response)
            raise error("second_factor_expired", "Too many wrong codes. Start again with your password.", 401)
        raise error("totp_code_wrong", "The code is not right.", 401)

    brake.succeeded(key)
    db.commit()
    accounts.note_success(db, row)
    totp.finish_pending(token)
    _clear_pending_cookie(response)
    if used_recovery:
        logger.warning("Recovery code used name=%s left=%s", row.name, len(totp.load_recovery(row.totp_recovery)))
    else:
        logger.info("Second factor passed name=%s", row.name)
    return sign_in(db, request, response, row)


@router.post("/auth/login/totp/cancel", status_code=204, summary="Give up the second step and start over")
def cancel_code(request: Request, response: Response) -> None:
    token = request.cookies.get(PENDING_COOKIE)
    if token:
        totp.finish_pending(token)
    _clear_pending_cookie(response)
