"""The notes an account opened last: for the empty note page and the quick switcher with nothing typed. Per account
on the server, so they are the same on every device; listed only where the account may still read."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import File, RecentNote
from ..services import paths
from . import news

router = APIRouter(prefix="/api", tags=["recent"])

#: Kept per account; more than a list of "the last ones" needs.
KEEP = 30


class RecentIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)


class RecentOut(BaseModel):
    path: str
    title: str


@router.post("/recent", summary="The note was opened now; answers what others changed since the last time")
def opened(body: RecentIn, account: Account) -> dict[str, Any]:
    clean = need(account, body.path, "read")
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == clean, File.deleted_at.is_(None), File.is_note.is_(True)))
        if file is None:
            raise error("not_found", "Not found.", 404)
        row = db.scalar(select(RecentNote).where(RecentNote.account_id == account.id, RecentNote.file_id == file.id))
        now = datetime.now(UTC)
        if row is None:
            db.add(RecentNote(account_id=account.id, file_id=file.id, opened_at=now))
        else:
            row.opened_at = now
        db.flush()
        keep = (
            select(RecentNote.id)
            .where(RecentNote.account_id == account.id)
            .order_by(RecentNote.opened_at.desc(), RecentNote.id.desc())
            .limit(KEEP)
        )
        db.execute(delete(RecentNote).where(RecentNote.account_id == account.id, RecentNote.id.not_in(keep)))
        changed = news.opened(db, account, file)
        db.commit()
    return {"news": changed}


@router.get("/recent", response_model=list[RecentOut], summary="The notes opened last that are there and may be read")
def listing(account: Account, limit: Annotated[int, Query(ge=1, le=KEEP)] = 10) -> list[RecentOut]:
    with SessionLocal() as db:
        rows = db.execute(
            select(File.path, File.title)
            .join(RecentNote, RecentNote.file_id == File.id)
            .where(
                RecentNote.account_id == account.id,
                File.deleted_at.is_(None),
                File.space_id.in_(readable_spaces(account)),
            )
            .order_by(RecentNote.opened_at.desc(), RecentNote.id.desc())
            .limit(limit)
        ).all()
    return [RecentOut(path=path, title=title or paths.stem(path)) for path, title in rows]
