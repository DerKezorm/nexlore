"""Favorites: notes and folders an account wants at hand, at the top of its sidebar. Per account and on the server,
so they are the same on every device. They follow a note or folder that moves and go with one that is trashed; one in a
space the account may no longer read is simply not listed (and comes back if the right does)."""

from __future__ import annotations

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..models import Favorite

#: More would not be "at hand" any more.
MAX = 100


class FavoriteError(ValueError):
    pass


def of(db: Session, account_id: int) -> list[str]:
    """The account's favorites in the order they were added."""
    return list(db.scalars(select(Favorite.path).where(Favorite.account_id == account_id).order_by(Favorite.id)))


def put(db: Session, account_id: int, path: str, on: bool) -> None:
    row = db.scalar(select(Favorite).where(Favorite.account_id == account_id, Favorite.path == path))
    if not on:
        if row is not None:
            db.delete(row)
        return
    if row is not None:
        return
    count = db.scalar(select(func.count()).select_from(Favorite).where(Favorite.account_id == account_id)) or 0
    if count >= MAX:
        raise FavoriteError("too many favorites")
    db.add(Favorite(account_id=account_id, path=path))


def _within(path: str):
    return or_(Favorite.path == path, Favorite.path.startswith(path + "/", autoescape=True))


def moved(db: Session, source: str, destination: str) -> None:
    """A note or folder moved or was renamed (vault paths): favorites of it, and of what lies in it, follow."""
    for row in db.scalars(select(Favorite).where(_within(source))):
        row.path = destination + row.path[len(source) :]


def gone(db: Session, path: str) -> None:
    """A note, folder or space went into the trash: its favorites, and those of what lies in it, go."""
    db.execute(delete(Favorite).where(_within(path)))
