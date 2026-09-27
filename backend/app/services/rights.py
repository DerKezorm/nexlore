"""Who may do what in which space.

Three rights, each including the ones before it: **read**, **write** (notes, files, the trash), **manage**
(inviting, giving rights, renaming or deleting the space). They live in ``memberships``.

A space **without any member** belongs to the operator: it came from the disk (a vault opened in Obsidian, a folder
Syncthing brought), and whoever runs the server owns the disk anyway. As soon as a space has members, the operator
is one of them or sees nothing of it: the operator can hand a space to somebody (``give``), but never reads a
foreign private space.

**Nothing leaks.** A space somebody may not read is treated as if it did not exist: the same 404 as for a space
that really does not exist, no name in any list, no title in search, graph or backlinks. A link into another space
(``[[Space/Note]]``) leads nowhere for whoever may not read that space: every route that hands out a link's target
checks it.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import MANAGE, OPERATOR, READ, SPACE_ROLES, WRITE, Account, File, Invite, Membership, Share, Space
from . import paths

__all__ = ["MANAGE", "READ", "WRITE", "RightsError", "at_least", "readable_ids", "role_in", "space_named"]


class RightsError(Exception):
    """``not_found`` when the space may not even be seen, ``forbidden`` when it may be seen but not changed."""

    def __init__(self, code: str, text: str, status: int) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


def at_least(role: str | None, need: str) -> bool:
    return role is not None and SPACE_ROLES.index(role) >= SPACE_ROLES.index(need)


def _members(db: Session, space_id: int) -> int:
    return int(db.scalar(select(func.count()).select_from(Membership).where(Membership.space_id == space_id)) or 0)


def role_in(db: Session, account: Account, space_id: int | None) -> str | None:
    """The account's right in the space, or None. ``space_id`` None: a folder on disk the index has not met yet,
    which like any space without members is the operator's."""
    if space_id is not None:
        membership = db.get(Membership, (space_id, account.id))
        if membership is not None:
            return membership.role
    if account.role == OPERATOR and (space_id is None or _members(db, space_id) == 0):
        return MANAGE
    return None


def readable_ids(db: Session, account: Account) -> set[int]:
    """Every space the account may read."""
    own = set(db.scalars(select(Membership.space_id).where(Membership.account_id == account.id)))
    if account.role == OPERATOR:
        with_members = set(db.scalars(select(Membership.space_id).distinct()))
        own |= set(db.scalars(select(Space.id))) - with_members
    return own


def space_named(db: Session, name: str) -> Space | None:
    return db.scalar(select(Space).where(Space.folder == name))


def check(db: Session, account: Account, rel: str, need: str) -> Space | None:
    """The right ``need`` in the space of a vault path (or the name of a space), or ``RightsError``."""
    name = paths.space_of(rel)
    space = space_named(db, name)
    if space is None and any(paths.fold(folder) == paths.fold(name) for folder in db.scalars(select(Space.folder))):
        # The name of a known space in other letters: on Windows and macOS it reaches that space's folder, and as
        # "a folder the index has not met" it would be the operator's. It is neither.
        raise RightsError("not_found", "No such file.", 404)
    role = role_in(db, account, space.id if space is not None else None)
    if not at_least(role, READ):
        raise RightsError("not_found", "No such file.", 404)
    if not at_least(role, need):
        raise RightsError("forbidden", "Your right in this space does not allow this.", 403)
    return space


def free_name(db: Session, name: str) -> None:
    """Before a new space takes a name: a deleted space of that name keeps its row, its members and its trash, so
    the name is free only when its trash is empty, and then the old members go (they must not see the new one)."""
    if not name or "/" in name or (paths.vault_root() / name).exists():
        # A space that is there: creating it again fails on its own, and its members stay untouched.
        return
    space = space_named(db, name)
    if space is None:
        return
    in_trash = db.scalar(select(func.count()).select_from(File).where(File.space_id == space.id)) or 0
    if in_trash:
        raise RightsError("exists", "A space of that name is still in the trash.", 409)
    for model in (Membership, Invite, Share):
        db.query(model).filter(model.space_id == space.id).delete()
    db.commit()
