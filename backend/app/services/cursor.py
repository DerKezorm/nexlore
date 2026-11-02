"""The vault's change counter: what the iPhone app syncs by (``/api/app/1/changes``).

Every row of ``files`` carries a ``cursor``. Whenever a row's path, space, content or trash state changes, it gets
the next number, from wherever the change came: a save in the browser, MCP, the API, the app, a move rewriting links,
the trash, and the watcher or a scan finding a change made outside. The hook sits in the database session
(``before_flush``), so no way of writing a file can forget it; the two places that write rows past the session (a
scan's bulk insert, ``index.bulk_add``) number theirs with ``stamp_rows``.

The number is handed out in the same transaction as the change it belongs to. SQLite has one writer at a time, so
transactions commit in the order of their numbers: whoever reads ``last`` sees every row up to it.

**What may not be told any more.** A row that goes for good (the trash emptied after its time) can no longer report
that it went. ``oldest`` rises to its number then, and an app that asks from before it starts over (410). A live row
that goes without the trash (a scan folding a moved file into its old row) leaves a ``GoneFile`` behind that reports it
as deleted, until the trash's time is over.

**Ids are never handed out twice.** SQLite gives a new row the highest id plus one, and so would give a new file the
id of the newest file gone for good; the app would take it for that file. New rows get their id from ``top_id``.
"""

from __future__ import annotations

import threading
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import Connection, delete, event, func, insert, inspect, select, text, update
from sqlalchemy.orm import Session

from ..models import File, GoneFile, VaultCursor, utcnow

#: What the app sees of a row: a change to any of these is a change it must hear of. The time alone is not (a sync
#: program touching a file leaves its content as it was).
TRACKED = ("path", "space_id", "hash", "size", "deleted_at", "is_note")
ROW = 1

#: Grows with every commit that handed out a number: ``/wait`` looks at it instead of at the database.
moved = 0
_moved_lock = threading.Lock()


def _ensure(connection: Connection) -> None:
    if connection.execute(select(VaultCursor.id).where(VaultCursor.id == ROW)).first() is not None:
        return
    last = max(
        connection.execute(select(func.coalesce(func.max(File.cursor), 0))).scalar_one(),
        connection.execute(select(func.coalesce(func.max(GoneFile.cursor), 0))).scalar_one(),
    )
    top = connection.execute(select(func.coalesce(func.max(File.id), 0))).scalar_one()
    connection.execute(insert(VaultCursor).values(id=ROW, last=last, oldest=0, top_id=top))


def take(connection: Connection, count: int) -> int:
    """``count`` new numbers; returns the first."""
    _ensure(connection)
    last = connection.execute(
        update(VaultCursor).where(VaultCursor.id == ROW).values(last=VaultCursor.last + count)
        .returning(VaultCursor.last)
    ).scalar_one()
    return int(last) - count + 1


def new_ids(connection: Connection, count: int) -> int:
    """``count`` file ids no row ever had; returns the first."""
    _ensure(connection)
    highest = select(func.coalesce(func.max(File.id), 0)).scalar_subquery()
    top = connection.execute(
        update(VaultCursor).where(VaultCursor.id == ROW)
        .values(top_id=func.max(VaultCursor.top_id, highest) + count).returning(VaultCursor.top_id)
    ).scalar_one()
    return int(top) - count + 1


def raise_oldest(connection: Connection, number: int) -> None:
    _ensure(connection)
    connection.execute(
        update(VaultCursor).where(VaultCursor.id == ROW, VaultCursor.oldest < number).values(oldest=number)
    )


def stamp_rows(connection: Connection, rows: list[dict[str, Any]]) -> None:
    """Rows for a bulk insert into ``files``: each gets its id and its number."""
    if not rows:
        return
    first_id = new_ids(connection, len(rows))
    first = take(connection, len(rows))
    for offset, row in enumerate(rows):
        row["id"] = first_id + offset
        row["cursor"] = first + offset


def state(connection: Connection) -> tuple[int, int]:
    """(last, oldest), as committed."""
    row = connection.execute(select(VaultCursor.last, VaultCursor.oldest).where(VaultCursor.id == ROW)).first()
    if row is not None:
        return int(row.last), int(row.oldest)
    last = max(
        connection.execute(select(func.coalesce(func.max(File.cursor), 0))).scalar_one(),
        connection.execute(select(func.coalesce(func.max(GoneFile.cursor), 0))).scalar_one(),
    )
    return int(last), 0


def _differs(file: File) -> bool:
    state_ = inspect(file)
    for name in TRACKED:
        history = state_.attrs[name].history
        if not history.added:
            continue
        if not history.deleted or history.added[0] != history.deleted[0]:
            return True
    return False


@event.listens_for(Session, "before_flush")
def _stamp(session: Session, _context: object, _instances: Iterable[object] | None) -> None:
    new = [item for item in session.new if isinstance(item, File)]
    changed = [item for item in session.dirty if isinstance(item, File) and _differs(item)]
    gone = [item for item in session.deleted if isinstance(item, File)]
    if not (new or changed or gone):
        return
    connection = session.connection()
    without_id = [item for item in new if item.id is None]
    if without_id:
        first_id = new_ids(connection, len(without_id))
        for offset, item in enumerate(without_id):
            item.id = first_id + offset
    live_gone = [item for item in gone if item.deleted_at is None]
    stamped = new + changed
    count = len(stamped) + len(live_gone)
    if count:
        first = take(connection, count)
        for offset, item in enumerate(stamped):
            item.cursor = first + offset
        now = utcnow()
        for offset, item in enumerate(live_gone, start=len(stamped)):
            connection.execute(insert(GoneFile).values(
                file_id=item.id, space_id=item.space_id, path=item.path, cursor=first + offset, gone_at=now,
            ))
        session.info["cursor_moved"] = True
    for item in gone:
        if item.deleted_at is not None:
            # It was in the trash with this number: whoever asks from before it would never hear that it went.
            raise_oldest(connection, int(item.cursor or 0))


@event.listens_for(Session, "after_commit")
def _committed(session: Session) -> None:
    global moved
    if session.info.pop("cursor_moved", False):
        with _moved_lock:
            moved += 1


@event.listens_for(Session, "after_rollback")
def _rolled_back(session: Session) -> None:
    session.info.pop("cursor_moved", None)


def number_existing(connection: Connection) -> int:
    """Rows from before the counter (and any written past it) get a number once, at start. Returns how many."""
    _ensure(connection)
    count = connection.execute(select(func.count()).select_from(File).where(File.cursor == 0)).scalar_one()
    if not count:
        return 0
    base = connection.execute(select(VaultCursor.last).where(VaultCursor.id == ROW)).scalar_one()
    connection.execute(text("UPDATE files SET cursor = :base + id WHERE cursor = 0"), {"base": base})
    top = connection.execute(select(func.coalesce(func.max(File.cursor), 0))).scalar_one()
    connection.execute(update(VaultCursor).where(VaultCursor.id == ROW).values(last=func.max(VaultCursor.last, top)))
    return int(count)


def purge_gone(db: Session, now: datetime | None = None, days: int = 30) -> int:
    """Rows that went without the trash are told for the trash's time; then they go, and ``oldest`` rises past them."""
    limit = (now or utcnow()) - timedelta(days=days)
    highest = db.scalar(select(func.max(GoneFile.cursor)).where(GoneFile.gone_at < limit))
    if highest is None:
        return 0
    removed = db.execute(delete(GoneFile).where(GoneFile.gone_at < limit)).rowcount or 0
    raise_oldest(db.connection(), int(highest))
    db.commit()
    return int(removed)
