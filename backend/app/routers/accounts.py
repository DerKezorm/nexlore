"""The operator's list of accounts: roles, names, addresses, blocking, deleting (30 days to bring back), storage limit
and the right to AI per account, reset links. The functions of the shared account module (``nexkonten.manage``, konten
1.1.0): several operators, never on one's own account, never the last operator who can sign in.

The operator sees name, address, way of signing in, role, spaces, uploaded storage and last use; never a title or a
word of somebody else's notes, and never sets somebody else's password (a reset link lets the person set their own)
or address (it can only take one away). Every act that a stolen session must not be enough for asks for the
operator's own password once more (``confirm_operator``); an operator through a provider only, for a sign-in there
from the last minutes.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import DbSession, OperatorAccount, confirm_operator
from ..errors import error
from ..models import OPERATOR, ROLES, File, Membership, OidcLink, OidcProvider, Space
from ..models import Account as AccountRow
from ..security import end_all_sessions
from ..services import accounts, kontenpost, settings_service
from ..services.konten_store import KontenStore
from ..vendor import nexkonten
from ..vendor.nexkonten import invites, manage, profiles, resets
from ..vendor.nexkonten import login as konten_login
from .auth import OperatorConfirmIn, account_view, fail

logger = logging.getLogger("nexlore.auth")

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class RoleIn(BaseModel):
    role: str = Field(max_length=16)
    #: The operator's own password once more; empty for an operator from a provider.
    current_password: str = Field(default="", max_length=200)


class ResetLinkIn(BaseModel):
    #: How long the link is valid: 1, 7 or 30 days (the shared module's ``OPERATOR_DAYS``, one from the start).
    days: int = 1
    current_password: str = Field(default="", max_length=200)


class NameIn(BaseModel):
    name: str = Field(max_length=64)
    current_password: str = Field(default="", max_length=200)


class DisplayNameIn(BaseModel):
    display_name: str = Field(max_length=200)
    current_password: str = Field(default="", max_length=200)


#: The largest storage limit the page offers: 1 PB (the field takes GB).
LIMIT_MAX = 1024**5


class LimitIn(BaseModel):
    #: Bytes; None removes the limit.
    limit: int | None = Field(default=None, ge=1, le=LIMIT_MAX)
    current_password: str = Field(default="", max_length=200)


class RightIn(BaseModel):
    #: A right of nexlore per account (konten 1.1.0): ``ai``.
    right: str = Field(max_length=16)
    allowed: bool


class AccountEmailIn(BaseModel):
    address: str = Field(default="", max_length=400)
    current_password: str = Field(default="", max_length=200)


def _row(db: DbSession, account_id: int) -> AccountRow:
    row = db.get(AccountRow, account_id)
    if row is None:
        raise error("not_found", "No such account.", 404)
    return row


def linked_providers(db: DbSession) -> dict[int, list[dict[str, Any]]]:
    linked: dict[int, list[dict[str, Any]]] = {}
    for link, entry in db.execute(
        select(OidcLink, OidcProvider).join(OidcProvider, OidcProvider.id == OidcLink.provider_id)
        .order_by(OidcProvider.position, OidcProvider.id)
    ):
        linked.setdefault(link.account_id, []).append({"id": entry.id, "slug": entry.slug, "label": entry.label})
    return linked


def _storage(db: DbSession) -> dict[str, int]:
    """Bytes uploaded per username (``files.owner``, what the quota counts), files in the trash included."""
    return {
        owner: int(size or 0)
        for owner, size in db.execute(select(File.owner, func.sum(File.size)).where(File.owner != "")
                                      .group_by(File.owner))
    }


def _listed(db: DbSession, row: AccountRow, linked: dict[int, list[dict[str, Any]]], spaces: dict[int, int],
            storage: dict[str, int]) -> dict[str, Any]:
    view = account_view(row, db)
    for private in ("two_factor_recovery_left", "new_password_origin", "new_sign_in_mail", "former_name",
                    "password_reset_notice", "second_factor_off", "appearance"):
        view.pop(private, None)
    store = KontenStore(db)
    konto = store.get_account(row.id)
    return {
        **view,
        "spaces": spaces.get(row.id, 0),
        # The address is held by another account too (left by 1.16.0): it signs nobody in, the list says so.
        "email_duplicate": bool(konto and konten_login.duplicate_email(store, konto)),
        # A passkey is a second factor too: the operator can reset an account that has only passkeys.
        "passkeys": len(store.passkeys_of(row.id)),
        "locked": accounts.is_locked(row),
        "blocked": row.blocked_at is not None,
        "blocked_at": row.blocked_at.isoformat() if row.blocked_at else None,
        "deleted": row.deleted_at is not None,
        "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None,
        "purge_at": manage.purge_at(row.deleted_at).isoformat() if row.deleted_at else None,
        "storage_limit": row.storage_limit,
        "ai_allowed": bool(row.ai_allowed),
        "has_password": bool(row.password_hash),
        "providers": linked.get(row.id, []),
        "storage_used": storage.get(row.name, 0),
    }


def _one(db: DbSession, row: AccountRow) -> dict[str, Any]:
    spaces = {row.id: int(db.scalar(select(func.count()).select_from(Membership)
                                    .where(Membership.account_id == row.id)) or 0)}
    return _listed(db, row, linked_providers(db), spaces, _storage(db))


@router.get("", summary="All accounts, with spaces, storage and last use (no contents)")
def list_accounts(_operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    spaces: dict[int, int] = {}
    for account_id in db.scalars(select(Membership.account_id)):
        spaces[account_id] = spaces.get(account_id, 0) + 1
    linked = linked_providers(db)
    storage = _storage(db)
    return [_listed(db, row, linked, spaces, storage)
            for row in db.scalars(select(AccountRow).order_by(AccountRow.created_at))]


def _alone_in(db: DbSession, account_id: int) -> list[str]:
    """The spaces the account is the only member of: after it goes, they have no members and are the operator's."""
    names: list[str] = []
    for space_id in db.scalars(select(Membership.space_id).where(Membership.account_id == account_id)):
        others = db.scalar(select(func.count()).select_from(Membership)
                           .where(Membership.space_id == space_id, Membership.account_id != account_id))
        if not others:
            space = db.get(Space, space_id)
            if space is not None:
                names.append(space.folder)
    return sorted(names)


@router.get("/{account_id}/impact", summary="What deleting the account takes away: names of spaces, numbers only")
def delete_impact(account_id: int, _operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    row = _row(db, account_id)
    spaces = int(db.scalar(select(func.count()).select_from(Membership).where(Membership.account_id == row.id)) or 0)
    return {"spaces": spaces, "alone": _alone_in(db, row.id)}


def _manage(work: Any) -> None:
    try:
        work()
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc


@router.delete("/{account_id}", status_code=204, summary="Delete an account (30 days to bring it back)")
def delete_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    """Gone for everybody at once and shut out (the shared account module 1.1.0); for 30 days the operator brings it
    back with everything. Then it goes for good (``manage.purge_due`` in the housekeeping): its rights go with it, its
    notes stay where they are, a space it was the only member of belongs to the operator, and its name stays reserved
    for ever."""
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    _manage(lambda: manage.remove(KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True))
    logger.warning("Account deleted name=%s by=%s", row.name, operator.name)


@router.post("/{account_id}/restore", summary="Bring a deleted account back while its 30 days run")
def restore_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    _manage(lambda: manage.restore(KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True))
    db.refresh(row)
    logger.warning("Account restored name=%s by=%s", row.name, operator.name)
    return _one(db, row)


@router.post("/{account_id}/sign-out", status_code=204, summary="End every session of an account")
def sign_out_account(account_id: int, operator: OperatorAccount, db: DbSession) -> None:
    row = _row(db, account_id)
    end_all_sessions(db, row.id)
    logger.warning("All sessions ended name=%s by=%s", row.name, operator.name)


@router.post("/{account_id}/block", status_code=204, summary="Block an account (out on every way in at once)")
def block_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    """Sessions, paired devices, API tokens, MCP keys and the calendar address count for nothing while it is blocked
    (``security.account_out`` and the checks of each way in); its rights and notes stay."""
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    _manage(lambda: manage.block(KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True))
    logger.warning("Account blocked name=%s by=%s", row.name, operator.name)


@router.post("/{account_id}/unblock", status_code=204, summary="Let a blocked account in again")
def unblock_account(
    account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> None:
    """The sessions from before the block do not come back to life."""
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    _manage(lambda: manage.unblock(KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True))
    logger.warning("Account unblocked name=%s by=%s", row.name, operator.name)


@router.put("/{account_id}/role", summary="Make an account operator or member (several operators may be)")
def set_role(
    account_id: int, payload: RoleIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    if payload.role not in ROLES:
        raise error("invalid_role", "Unknown role.", 422)
    row = _row(db, account_id)
    if row.id == operator.id and payload.role == OPERATOR:
        return _one(db, row)
    _manage(lambda: manage.set_role(KontenStore(db), row.id, payload.role == OPERATOR, actor_id=operator.id,
                                    actor_confirmed=True))
    db.refresh(row)
    logger.warning("Role changed name=%s role=%s by=%s", row.name, payload.role, operator.name)
    return _one(db, row)


@router.put("/{account_id}/storage-limit", summary="How much the account may upload (None: no limit)")
def set_storage_limit(account_id: int, payload: LimitIn, request: Request, operator: OperatorAccount,
                      db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    _manage(lambda: manage.set_storage_limit(KontenStore(db), row.id, payload.limit, actor_id=operator.id,
                                             actor_confirmed=True))
    db.refresh(row)
    logger.info("Storage limit set name=%s limit=%s by=%s", row.name, payload.limit or "none", operator.name)
    return _one(db, row)


@router.put("/{account_id}/right", summary="A right of nexlore for the account (AI in its notes)")
def set_right(account_id: int, payload: RightIn, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    """A tick in "Manage", saved at once without the password (the module's rule for rights)."""
    row = _row(db, account_id)
    _manage(lambda: manage.set_right(KontenStore(db), row.id, payload.right, payload.allowed, actor_id=operator.id))
    db.refresh(row)
    logger.info("Right changed name=%s right=%s allowed=%s by=%s", row.name, payload.right, payload.allowed,
                operator.name)
    return _one(db, row)


@router.post("/{account_id}/reset-link", status_code=201,
             summary="A link with which the person sets a new password themselves (mailed, or shown once)")
def reset_link(
    account_id: int, payload: ResetLinkIn, request: Request, operator: OperatorAccount, db: DbSession,
) -> dict[str, Any]:
    """Through the shared account module (``resets.reset_link``), after the operator's own confirmation: with a mail
    server and an address that counts it goes there (``sent``), otherwise the page shows it once. Also for a blocked
    account (the block stays), never for the operator's own; an account through a provider only gets its first
    password this way, while signing in by password is on. Replaces "Set a password" of 1.16.0."""
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        made = resets.reset_link(
            KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True, mail=kontenpost.can_mail(db),
            password_login=bool(settings_service.get(db, "password_login")), days=payload.days,
        )
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    logger.warning("Password reset link made name=%s by=%s", row.name, operator.name)
    if made.mail is not None:
        sent = kontenpost.queue(db, made.mail, days=payload.days)
        if not sent:
            resets.reset_mail_failed(KontenStore(db), row.id)
            raise error("mail_failed", "The mail server did not take the mail.", 502)
        return {"link": None, "sent": True, "expires_at": made.expires_at.isoformat()}
    link = invites.invite_link(settings_service.public_url(db), "/reset/", made.token,
                               request_base=str(request.base_url))
    return {"link": link, "sent": False, "expires_at": made.expires_at.isoformat()}


@router.put("/{account_id}/password", status_code=410, summary="Gone: the operator makes a reset link instead")
def set_password(account_id: int, _operator: OperatorAccount) -> None:
    """1.16.0 let the operator set another account's password. Since the shared account module the person sets it
    with a link (``POST /api/accounts/{id}/reset-link``); this answers 410 for one version, so that scripts learn
    why."""
    del account_id
    raise error("use_reset_link", "The operator no longer sets passwords. Make a reset link: "
                "POST /api/accounts/{id}/reset-link.", 410)


@router.put("/{account_id}/name", summary="Give an account another username (its history goes along)")
def set_name(account_id: int, payload: NameIn, request: Request, operator: OperatorAccount,
             db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        notice = profiles.change_username(KontenStore(db), row.id, payload.name, actor_id=operator.id,
                                          actor_confirmed=True)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    kontenpost.queue(db, notice)
    db.refresh(row)
    logger.warning("Username changed account_id=%s by=%s", row.id, operator.name)
    return _one(db, row)


@router.put("/{account_id}/display-name", summary="Give an account another display name")
def set_display_name(account_id: int, payload: DisplayNameIn, request: Request, operator: OperatorAccount,
                     db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    try:
        profiles.change_display_name(KontenStore(db), row.id, payload.display_name, actor_id=operator.id,
                                     actor_confirmed=True)
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    db.refresh(row)
    return _one(db, row)


def _remove_email(db: DbSession, row: AccountRow, operator: AccountRow) -> dict[str, Any]:
    try:
        changed = profiles.remove_email(KontenStore(db), row.id, actor_id=operator.id, actor_confirmed=True,
                                        mail=kontenpost.can_mail(db))
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc
    kontenpost.queue(db, changed.notice)
    db.refresh(row)
    logger.warning("Address removed account_id=%s by=%s", row.id, operator.name)
    return _one(db, row)


@router.delete("/{account_id}/email", summary="Take an account's address away (never set one)")
def remove_email(account_id: int, payload: OperatorConfirmIn, request: Request, operator: OperatorAccount,
                 db: DbSession) -> dict[str, Any]:
    confirm_operator(request, db, operator, payload.current_password)
    return _remove_email(db, _row(db, account_id), operator)


@router.put("/{account_id}/email", summary="1.16.0's way: only an empty address (taking it away) is still allowed")
def set_account_email(account_id: int, payload: AccountEmailIn, request: Request, operator: OperatorAccount,
                      db: DbSession) -> dict[str, Any]:
    """The operator no longer sets another account's address (a reset link would go wherever it chose); empty still
    takes it away, as in 1.16.0."""
    confirm_operator(request, db, operator, payload.current_password)
    row = _row(db, account_id)
    if payload.address.strip():
        raise error("not_allowed", "The operator can only take an address away. The person enters their own.", 409)
    return _remove_email(db, row, operator)
