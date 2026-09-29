"""New since the last visit: notes others changed after the account last opened them (or, never opened, after it first
asked). Changes by the account itself never count, nor links rewritten after a rename, nor the first reading of a
file. Readable spaces only; opening a note marks it as seen (``routers/recent``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..deps import Account, readable_spaces
from ..models import Account as AccountRow
from ..models import File, NoteSeen, Version
from ..services import comments, index

router = APIRouter(prefix="/api", tags=["news"])

#: What counts as a change somebody made; a rename's rewritten link, a first reading or an import do not.
COUNTING = (index.APP, index.EXTERNAL, index.RESTORE, index.MCP, index.PLUGIN, "proposal", "ai")


class NewNote(BaseModel):
    path: str
    title: str
    changed_at: datetime
    #: Who changed it last; empty for a change from outside (Obsidian, a sync, an editor).
    author: str


class Mention(BaseModel):
    thread: int
    path: str
    title: str
    author: str
    at: datetime
    excerpt: str


class News(BaseModel):
    count: int
    notes: list[NewNote]
    #: Open threads where somebody named the account with ``@name`` since it last opened the note.
    mentions: list[Mention] = []


def _since(db: Session, account: Any) -> datetime:
    row = db.get(AccountRow, account.id)
    assert row is not None
    if row.news_since is None:
        # The first question: from now on (nothing before counts as new).
        row.news_since = datetime.now(UTC)
        db.commit()
    return row.news_since


def _others(account: Any, since: datetime) -> Any:
    return and_(
        Version.updated_at > since,
        Version.source.in_(COUNTING),
        or_(Version.author.is_(None), Version.author != account.name),
    )


def _new_query(db: Session, account: Any) -> Any:
    since = _since(db, account)
    last = (
        select(Version.file_id, func.max(Version.updated_at).label("changed"))
        .where(_others(account, since))
        .group_by(Version.file_id)
        .subquery()
    )
    return (
        select(File.id, File.path, File.title, last.c.changed)
        .join(last, last.c.file_id == File.id)
        .outerjoin(NoteSeen, and_(NoteSeen.file_id == File.id, NoteSeen.account_id == account.id))
        .where(
            File.is_note.is_(True),
            File.deleted_at.is_(None),
            File.space_id.in_(readable_spaces(account)),
            or_(NoteSeen.seen_at.is_(None), last.c.changed > NoteSeen.seen_at),
        )
    )


def _author(db: Session, account: Any, file_id: int, since: datetime) -> str:
    author = db.scalar(
        select(Version.author)
        .where(Version.file_id == file_id, _others(account, since))
        .order_by(Version.updated_at.desc(), Version.id.desc())
        .limit(1)
    )
    return author or ""


@router.get("/news", response_model=News, summary="Notes others changed since the account last opened them")
def news(account: Account, limit: Annotated[int, Query(ge=1, le=100)] = 30) -> News:
    with SessionLocal() as db:
        query = _new_query(db, account)
        count = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = db.execute(query.order_by(query.selected_columns.changed.desc()).limit(limit)).all()
        since = _since(db, account)
        notes = [
            NewNote(path=row.path, title=row.title, changed_at=row.changed, author=_author(db, account, row.id, since))
            for row in rows
        ]
        seen_rows = db.execute(select(NoteSeen.file_id, NoteSeen.seen_at).where(NoteSeen.account_id == account.id))
        found = comments.mentions_of(db, account, readable_spaces(account), dict(seen_rows.all()), since)
        mentions = [Mention(**item) for item in found]
    return News(count=count, notes=notes, mentions=mentions)


@router.post("/news/seen", status_code=204, summary="Mark everything new as seen")
def seen_all(account: Account) -> None:
    with SessionLocal() as db:
        row = db.get(AccountRow, account.id)
        assert row is not None
        row.news_since = datetime.now(UTC)
        db.execute(delete(NoteSeen).where(NoteSeen.account_id == account.id))
        db.commit()


def opened(db: Session, account: Any, file: File) -> dict[str, Any] | None:
    """The account opens a note: what others changed since it last did (for the banner), and it is seen from now."""
    since = _since(db, account)
    seen = db.scalar(select(NoteSeen).where(NoteSeen.account_id == account.id, NoteSeen.file_id == file.id))
    after = max(since, seen.seen_at) if seen is not None else since
    change = db.execute(
        select(Version.author, Version.updated_at)
        .where(Version.file_id == file.id, _others(account, after))
        .order_by(Version.updated_at.desc(), Version.id.desc())
        .limit(1)
    ).first()
    news_of: dict[str, Any] | None = None
    if change is not None:
        # The version the account saw last: the text to compare the note with now.
        before = db.scalar(
            select(Version.id)
            .where(Version.file_id == file.id, Version.updated_at <= after)
            .order_by(Version.updated_at.desc(), Version.id.desc())
            .limit(1)
        )
        news_of = {"author": change.author or "", "changed_at": change.updated_at.isoformat(), "since_version": before}
    now = datetime.now(UTC)
    if seen is None:
        db.add(NoteSeen(account_id=account.id, file_id=file.id, seen_at=now))
    else:
        seen.seen_at = now
    return news_of
