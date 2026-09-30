"""Invitations by name and what the operator did in spaces it does not manage (``SpaceNotice``).

A manager who names an account does not make it a member: the account gets an invitation under "New" and answers it.
Unknown names are answered exactly like known ones, so the members dialog tells nobody which accounts exist.

The operator may still set rights in any space (a manager left, an account was deleted). It never happens unseen:
every member of the space, and the account concerned, gets a notice.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import MANAGE, OPERATOR, Account, Membership, Space, SpaceNotice

INVITE = "invite"
OPERATOR_ADDED = "operator_added"
OPERATOR_ROLE = "operator_role"
OPERATOR_REMOVED = "operator_removed"
#: An invitation nobody answered goes after this long.
INVITE_DAYS = 30


class NoticeError(Exception):
    def __init__(self, code: str, status: int = 404) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass
class NoticeView:
    id: int
    kind: str
    space: str
    role: str
    actor: str
    subject: str
    created_at: datetime


def invite(db: Session, space: Space, target: Account, role: str, by: Account) -> None:
    """An invitation for ``target``; one more for the same space replaces the open one (with the newer right)."""
    open_ = db.scalar(
        select(SpaceNotice).where(
            SpaceNotice.account_id == target.id, SpaceNotice.space_id == space.id,
            SpaceNotice.kind == INVITE, SpaceNotice.done_at.is_(None),
        )
    )
    if open_ is None:
        open_ = SpaceNotice(account_id=target.id, space_id=space.id, kind=INVITE)
        db.add(open_)
    open_.space_name = space.folder
    open_.role = role
    open_.actor = by.name
    open_.actor_id = by.id
    open_.created_at = datetime.now(UTC)


def tell(db: Session, space: Space, kind: str, actor: Account, subject: str, role: str = "",
         also: tuple[int, ...] = ()) -> None:
    """A notice about what the operator did, for every member of the space and for ``also`` (the account concerned)."""
    members = set(db.scalars(select(Membership.account_id).where(Membership.space_id == space.id)))
    for account_id in (members | set(also)) - {actor.id}:
        db.add(SpaceNotice(account_id=account_id, space_id=space.id, space_name=space.folder, kind=kind, role=role,
                           actor=actor.name, actor_id=actor.id, subject=subject))


def open_for(db: Session, account_id: int) -> list[NoticeView]:
    since = datetime.now(UTC) - timedelta(days=INVITE_DAYS)
    rows = db.scalars(
        select(SpaceNotice)
        .where(SpaceNotice.account_id == account_id, SpaceNotice.done_at.is_(None), SpaceNotice.created_at > since)
        .order_by(SpaceNotice.created_at.desc(), SpaceNotice.id.desc())
    )
    return [
        NoticeView(id=row.id, kind=row.kind, space=row.space_name, role=row.role, actor=row.actor,
                   subject=row.subject, created_at=row.created_at)
        for row in rows
    ]


def _own(db: Session, account: Account, notice_id: int) -> SpaceNotice:
    row = db.get(SpaceNotice, notice_id)
    if row is None or row.account_id != account.id or row.done_at is not None:
        raise NoticeError("not_found")
    return row


def answer(db: Session, account: Account, notice_id: int, *, accept: bool) -> str | None:
    """Accept or decline an invitation; the space's name when accepted. Anything else: seen."""
    row = _own(db, account, notice_id)
    row.done_at = datetime.now(UTC)
    if row.kind != INVITE or not accept:
        db.commit()
        return None
    space = db.get(Space, row.space_id) if row.space_id is not None else None
    if space is None:
        db.commit()
        raise NoticeError("not_found")
    if db.get(Membership, (space.id, account.id)) is None:
        members = db.scalar(select(func.count()).select_from(Membership).where(Membership.space_id == space.id)) or 0
        inviter = db.get(Account, row.actor_id) if row.actor_id is not None else None
        if members == 0 and inviter is not None and inviter.role == OPERATOR:
            # A space without members is the operator's; the operator who invited stays in it as manager.
            db.add(Membership(space_id=space.id, account_id=inviter.id, role=MANAGE))
        db.add(Membership(space_id=space.id, account_id=account.id, role=row.role))
    db.commit()
    return space.folder
