"""Who is in which space, and the invitations that bring people in.

A manager of a space invites, gives and takes rights there. Naming an account brings it an invitation, never a
membership it did not agree to, and the answer is the same whether the name exists or not.

The operator may reset the rights of any space (a manager left, an account was deleted): it sees names of spaces and
of members, never what is inside, and cannot give itself a right in a space that has members. It can give one to
another account, though, or take the last member out and so make the space its own: that is never hidden, every
member and the account concerned get a notice (``services/notices``).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import Account, DbSession, OperatorAccount, client_ip
from ..errors import detail, error
from ..models import MANAGE, OPERATOR, SPACE_ROLES, Invite, Membership, Space
from ..models import Account as AccountRow
from ..security import MIN_PASSWORD, SESSION_COOKIE, brake, session_account
from ..services import accounts, mailer, notices, rights, settings_service
from ..services.accounts import AccountError
from .auth import check_password, fail, sign_in

logger = logging.getLogger("nexlore.auth")

router = APIRouter(prefix="/api", tags=["members"])

SpaceName = Annotated[str, PathParam(min_length=1, max_length=255)]
AccountName = Annotated[str, PathParam(min_length=1, max_length=64)]
Token = Annotated[str, PathParam(min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


def _space(db: DbSession, account: AccountRow, name: str, *, operator_may: bool = False) -> Space:
    """The space, when the account manages it (or, with ``operator_may``, is the operator). Not readable: 404."""
    space = rights.space_named(db, name)
    if space is None:
        raise error("not_found", "No such space.", 404)
    role = rights.role_in(db, account, space.id)
    if operator_may and rights.operator_powers(account):
        return space
    if not rights.at_least(role, rights.READ):
        raise error("not_found", "No such space.", 404)
    if not rights.at_least(role, MANAGE):
        raise error("forbidden", "Only a manager of this space may do this.", 403)
    return space


def _members(db: DbSession, space_id: int) -> list[Any]:
    return list(
        db.execute(
            select(Membership, AccountRow)
            .join(AccountRow, AccountRow.id == Membership.account_id)
            .where(Membership.space_id == space_id)
            .order_by(AccountRow.name)
        ).all()
    )


def _managers_left(db: DbSession, space_id: int, without: int) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(Membership)
            .where(Membership.space_id == space_id, Membership.role == MANAGE, Membership.account_id != without)
        )
        or 0
    )


def _others(db: DbSession, space_id: int, without: int) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(Membership)
            .where(Membership.space_id == space_id, Membership.account_id != without)
        )
        or 0
    )


def _invite_view(invite: Invite, db: DbSession) -> dict[str, Any]:
    by = db.get(AccountRow, invite.created_by) if invite.created_by else None
    return {
        "id": invite.id,
        "role": invite.space_role,
        "email": invite.email,
        "by": by.name if by else None,
        "created_at": invite.created_at.isoformat(),
        "expires_at": invite.expires_at.isoformat(),
    }


def _link(db: DbSession, request: Request, token: str) -> str:
    base = settings_service.public_url(db) or str(request.base_url).rstrip("/")
    return f"{base}/invite/{token}"


# --- Members of a space ---------------------------------------------------------------------------------------------


class MemberIn(BaseModel):
    role: str = Field(max_length=16)


@router.get("/spaces/{name}/members", summary="Who is in the space, and the open invitations")
def members(name: SpaceName, account: Account, db: DbSession) -> dict[str, Any]:
    space = _space(db, account, name, operator_may=True)
    rows = _members(db, space.id)
    invites = list(db.scalars(select(Invite).where(Invite.space_id == space.id).order_by(Invite.created_at)))
    return {
        "space": space.folder,
        "members": [
            {"name": person.name, "role": membership.role, "you": person.id == account.id}
            for membership, person in rows
        ],
        "invites": [_invite_view(invite, db) for invite in invites if not accounts.expired(invite)],
        "role": rights.role_in(db, account, space.id),
    }


@router.put("/spaces/{name}/members/{person}", summary="Change a member's right, or invite an account by name")
def set_member(
    name: SpaceName, person: AccountName, payload: MemberIn, account: Account, db: DbSession, response: Response
) -> dict:
    if payload.role not in SPACE_ROLES:
        raise error("invalid_role", "Unknown right.", 422)
    space = _space(db, account, name, operator_may=True)
    own = rights.role_in(db, account, space.id)
    # The operator acting where it does not manage: allowed, but every member is told.
    beyond = rights.operator_powers(account) and not rights.at_least(own, MANAGE)
    target = accounts.by_name(db, person)
    membership = db.get(Membership, (space.id, target.id)) if target is not None else None
    if membership is None and not beyond and (target is None or target.id != account.id):
        # A name brings an invitation, answered under "New"; unknown names get the same answer, the same work and
        # the same limit, and nothing happens.
        key = f"invite-by:{account.id}"
        if brake.wait_seconds(key, NAMES_PER_HOUR):
            raise error("too_many_attempts", "Too many invitations. Try again later.", 429)
        brake.failed(key)
        notices.invite(db, space, target, payload.role, account)
        db.commit()
        if target is not None:
            logger.info("Invited space_id=%s name=%s role=%s by=%s", space.id, target.name, payload.role, account.name)
        response.status_code = 202
        return {"name": person, "role": payload.role, "invited": True}
    if target is None:
        raise error("no_such_account", "There is no account of that name.", 404)
    if target.id == account.id and not rights.at_least(own, MANAGE):
        # The operator resets rights, it does not take them.
        raise error("forbidden", "You cannot give yourself a right in this space.", 403)
    if (
        membership is not None
        and membership.role == MANAGE
        and payload.role != MANAGE
        and _managers_left(db, space.id, target.id) == 0
        and _others(db, space.id, target.id) > 0
    ):
        raise error("last_manager", "The space needs another manager first.", 409)
    if membership is None:
        if _others(db, space.id, -1) == 0 and target.id != account.id and account.role == OPERATOR:
            # A space without members is the operator's; giving it to somebody keeps the operator in as manager,
            # unless the operator takes itself out afterwards.
            db.add(Membership(space_id=space.id, account_id=account.id, role=MANAGE))
        db.add(Membership(space_id=space.id, account_id=target.id, role=payload.role))
    else:
        membership.role = payload.role
    if beyond:
        kind = notices.OPERATOR_ADDED if membership is None else notices.OPERATOR_ROLE
        db.flush()
        notices.tell(db, space, kind, account, target.name, payload.role, also=(target.id,))
    db.commit()
    logger.info("Right set space_id=%s name=%s role=%s by=%s", space.id, target.name, payload.role, account.name)
    return {"name": target.name, "role": payload.role}


@router.delete("/spaces/{name}/members/{person}", status_code=204, summary="Take an account out of the space")
def remove_member(name: SpaceName, person: AccountName, account: Account, db: DbSession) -> None:
    target = accounts.by_name(db, person)
    leaving = target is not None and target.id == account.id
    if leaving:
        space = rights.space_named(db, name)
        if space is None or db.get(Membership, (space.id, account.id)) is None:
            raise error("not_found", "No such space.", 404)
    else:
        space = _space(db, account, name, operator_may=True)
    membership = db.get(Membership, (space.id, target.id)) if target is not None else None
    if target is None or membership is None:
        # Unknown and not a member answer alike: a manager learns nothing about names outside the space.
        raise error("not_a_member", "This account is not in the space.", 404)
    if membership.role == MANAGE and _managers_left(db, space.id, target.id) == 0 and _others(db, space.id, target.id):
        raise error("last_manager", "The space needs another manager first.", 409)
    own = rights.role_in(db, account, space.id)
    beyond = not leaving and rights.operator_powers(account) and not rights.at_least(own, MANAGE)
    db.delete(membership)
    if beyond:
        # Taking the last member out makes the space the operator's: the one taken out is told as well.
        db.flush()
        notices.tell(db, space, notices.OPERATOR_REMOVED, account, target.name, also=(target.id,))
    db.commit()
    logger.info("Right taken space_id=%s name=%s by=%s", space.id, target.name, account.name)


class NoticeOut(BaseModel):
    id: int
    kind: str
    space: str
    role: str
    actor: str
    subject: str
    created_at: datetime


@router.get("/notices", response_model=list[NoticeOut], summary="Open invitations and what the operator changed")
def open_notices(account: Account, db: DbSession) -> list[NoticeOut]:
    return [NoticeOut(**vars(item)) for item in notices.open_for(db, account.id)]


@router.post("/notices/{notice_id}/accept", summary="Accept an invitation into a space")
def accept_notice(notice_id: Annotated[int, PathParam(ge=1)], account: Account, db: DbSession) -> dict[str, str]:
    try:
        space = notices.answer(db, account, notice_id, accept=True)
    except notices.NoticeError as exc:
        raise error(exc.code, "No such invitation.", exc.status) from exc
    logger.info("Invitation accepted notice=%s name=%s", notice_id, account.name)
    return {"space": space or ""}


@router.post("/notices/{notice_id}/decline", status_code=204, summary="Decline an invitation, or mark a notice seen")
def decline_notice(notice_id: Annotated[int, PathParam(ge=1)], account: Account, db: DbSession) -> None:
    try:
        notices.answer(db, account, notice_id, accept=False)
    except notices.NoticeError as exc:
        raise error(exc.code, "No such notice.", exc.status) from exc


@router.get("/admin/spaces", summary="Every space with its members, for the operator (no contents)")
def all_spaces(operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    result = []
    for space in db.scalars(select(Space).order_by(Space.folder)):
        rows = _members(db, space.id)
        result.append(
            {
                "name": space.folder,
                "members": len(rows),
                "managers": [person.name for membership, person in rows if membership.role == MANAGE],
                "role": rights.role_in(db, operator, space.id),
            }
        )
    return result


# --- Invitations ----------------------------------------------------------------------------------------------------


class InviteIn(BaseModel):
    role: str = Field(default="", max_length=16)
    days: int = 7
    email: str = Field(default="", max_length=255)
    send: bool = False


class AcceptIn(BaseModel):
    name: str = Field(max_length=64)
    password: str = Field(max_length=200)


#: Invitation mails one account may send in an hour; invitations by name one account may hand out in an hour.
MAILS_PER_HOUR = 20
NAMES_PER_HOUR = 60


def _create(db: DbSession, request: Request, by: AccountRow, space: Space | None, payload: InviteIn) -> dict:
    email = payload.email.strip()
    if email and not accounts.EMAIL_PATTERN.match(email):
        raise error("invalid_email", "This is not a mail address.", 422)
    if payload.send and not email:
        raise error("invalid_email", "Sending needs a mail address.", 422)
    if payload.send:
        # A mail goes out under the operator's mail server: never with a link to an address the request made up
        # (the Host header), and not without end.
        if not settings_service.public_url(db):
            raise error("public_url_missing", "Mail needs the public address of nexlore; the operator sets it.", 409)
        key = f"invite-mail:{by.id}"
        if brake.wait_seconds(key, MAILS_PER_HOUR):
            raise error("too_many_attempts", "Too many invitation mails. Try again later.", 429)
        brake.failed(key)
    try:
        invite, token = accounts.create_invite(
            db, by, space_id=space.id if space else None, space_role=payload.role if space else "",
            days=payload.days, email=email,
        )
    except AccountError as exc:
        raise fail(exc) from exc
    link = _link(db, request, token)
    sent = False
    if payload.send:
        try:
            mailer.send_invite(db, email, link, by=by.name, space=space.folder if space else None)
            sent = True
        except mailer.MailError as exc:
            # The link was to go by mail only: kept, the invitation would stand without anybody holding its link.
            db.delete(invite)
            db.commit()
            raise error(exc.code, str(exc), 502) from exc
    return {**_invite_view(invite, db), "link": link, "sent": sent}


@router.post("/spaces/{name}/invites", status_code=201, summary="Invite into the space; the link is shown once")
def invite_to_space(name: SpaceName, payload: InviteIn, request: Request, account: Account, db: DbSession) -> dict:
    space = _space(db, account, name)
    if payload.role not in SPACE_ROLES:
        raise error("invalid_role", "Unknown right.", 422)
    return _create(db, request, account, space, payload)


@router.get("/invites", summary="Open invitations without a space (operator)")
def list_invites(_operator: OperatorAccount, db: DbSession) -> list[dict[str, Any]]:
    return [_invite_view(invite, db) for invite in accounts.invites_of(db, space_id=None)]


@router.post("/invites", status_code=201, summary="Invite into nexlore without a space (operator)")
def invite(payload: InviteIn, request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    if payload.role:
        raise error("invalid_role", "A right needs a space.", 422)
    return _create(db, request, operator, None, payload)


@router.delete("/invites/{invite_id}", status_code=204, summary="Withdraw an invitation")
def withdraw(invite_id: int, account: Account, db: DbSession) -> None:
    row = db.get(Invite, invite_id)
    allowed = row is not None and (
        rights.operator_powers(account)
        or row.created_by == account.id
        or (row.space_id is not None and rights.at_least(rights.role_in(db, account, row.space_id), MANAGE))
    )
    if row is None or not allowed:
        raise error("not_found", "No such invitation.", 404)
    db.delete(row)
    db.commit()


def _valid(db: DbSession, token: str) -> Invite:
    row = accounts.find_invite(db, token)
    if row is None:
        raise error("invite_invalid", "This invitation is not valid any more.", 404)
    return row


@router.get("/invite/{token}", summary="What an invitation offers (no sign-in needed)")
def invite_state(token: Token, request: Request, db: DbSession) -> dict[str, Any]:
    row = _valid(db, token)
    space = db.get(Space, row.space_id) if row.space_id else None
    signed_in = session_account(db, request.cookies.get(SESSION_COOKIE))
    return {
        "space": space.folder if space else None,
        "role": row.space_role or None,
        "min_password": MIN_PASSWORD,
        "signed_in_as": signed_in.name if signed_in else None,
    }


#: Taken names one sender may try when accepting invitations before it waits.
NAME_TRIES = 8


@router.post("/invite/{token}", summary="Accept an invitation with a new account")
def accept(token: Token, payload: AcceptIn, request: Request, response: Response, db: DbSession) -> dict[str, Any]:
    # A name that is taken must be said, so the person can pick another; the brake keeps it from being a way to try
    # names one after another (one link took 60 tries without a pause).
    key = "invite-name:" + client_ip(request)
    wait = brake.wait_seconds(key, NAME_TRIES)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    check_password(payload.password)
    if not settings_service.get(db, "password_login"):
        raise error("password_login_off", "Sign-in with a password is turned off.", 403)
    try:
        account = accounts.accept_invite(db, token, payload.name, payload.password)
    except AccountError as exc:
        if exc.code == "name_taken":
            brake.failed(key)
        raise fail(exc) from exc
    return sign_in(db, request, response, account)


@router.post("/invite/{token}/join", summary="Accept an invitation with the signed-in account")
def join(token: Token, account: Account, db: DbSession) -> dict[str, Any]:
    row = _valid(db, token)
    if row.space_id is None:
        raise error("already_member", "You have an account already.", 409)
    own = db.get(AccountRow, account.id)
    assert own is not None
    space = db.get(Space, row.space_id)
    try:
        accounts.redeem(db, row, own)
    except AccountError as exc:
        raise fail(exc) from exc
    return {"space": space.folder if space else None}
