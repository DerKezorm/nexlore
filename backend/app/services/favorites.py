"""Favorites: what an account wants at hand, at the top of its sidebar. Per account and on the server, so they are the
same on every device. They follow a note or folder that moves and go with one that is trashed; one in a space the
account may no longer read is simply not listed (and comes back if the right does).

Besides notes and folders: a heading of a note, kept as ``Space/Note.md#Heading``, and a search, kept as ``?words``
(a vault path never starts with ``?``, a name nexlore makes has no ``#``). Each may sit in a group (``section``)."""

from __future__ import annotations

import re

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..models import Favorite

#: More would not be "at hand" any more.
MAX = 100
#: A search is kept with this in front of its words.
SEARCH = "?"
MAX_QUERY = 500
MAX_HEADING = 200
MAX_SECTION = 80

_HEADING = re.compile(r"^(.+?\.md)#(.+)$", re.IGNORECASE | re.DOTALL)


class FavoriteError(ValueError):
    pass


def heading_of(path: str) -> tuple[str, str] | None:
    """``Space/Note.md#Heading`` as the note and the heading; None for anything else."""
    match = _HEADING.match(path)
    return (match.group(1), match.group(2)) if match else None


def of(db: Session, account_id: int) -> list[tuple[str, str]]:
    """The account's favorites and their groups, in the order they were added."""
    mine = select(Favorite.path, Favorite.section).where(Favorite.account_id == account_id)
    rows = db.execute(mine.order_by(Favorite.id))
    return [(path, section or "") for path, section in rows]


def put(db: Session, account_id: int, path: str, on: bool, section: str | None = None) -> None:
    """Adds or removes a favorite; ``section`` (when given) puts it into that group, empty takes it out of one."""
    row = db.scalar(select(Favorite).where(Favorite.account_id == account_id, Favorite.path == path))
    if not on:
        if row is not None:
            db.delete(row)
        return
    if row is not None:
        if section is not None:
            row.section = section
        return
    count = db.scalar(select(func.count()).select_from(Favorite).where(Favorite.account_id == account_id)) or 0
    if count >= MAX:
        raise FavoriteError("too many favorites")
    db.add(Favorite(account_id=account_id, path=path, section=section or ""))


def _within(path: str):
    """The favorite of ``path``, of what lies in it, and of its headings."""
    return or_(
        Favorite.path == path,
        Favorite.path.startswith(path + "/", autoescape=True),
        Favorite.path.startswith(path + "#", autoescape=True),
    )


def moved(db: Session, source: str, destination: str) -> None:
    """A note or folder moved or was renamed (vault paths): favorites of it, and of what lies in it, follow."""
    for row in db.scalars(select(Favorite).where(_within(source))):
        row.path = destination + row.path[len(source) :]


def gone(db: Session, path: str) -> None:
    """A note, folder or space went into the trash: its favorites, and those of what lies in it, go."""
    db.execute(delete(Favorite).where(_within(path)))
