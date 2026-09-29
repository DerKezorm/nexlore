"""Comments in the margin of a note (``services/comments``): reading the note is enough to comment."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..deps import Account, need
from ..errors import error
from ..models import MANAGE, READ, WRITE, File
from ..services import comments, paths, rights, vault
from ..services.comments import CommentError, Who

router = APIRouter(prefix="/api/comments", tags=["comments"])

PathQuery = Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)]


@contextmanager
def _note(account: Any, path: str) -> Iterator[tuple[Session, File, Who]]:
    clean = need(account, path, READ)
    with SessionLocal() as db:
        file = vault.live(db, clean)
        if file is None or not file.is_note:
            raise error("not_found", "No such note.", 404)
        role = rights.role_in(db, account, file.space_id)
        who = Who(id=account.id, name=account.name, may_write=rights.at_least(role, WRITE),
                  may_manage=rights.at_least(role, MANAGE))
        try:
            yield db, file, who
        except CommentError as exc:
            raise error(exc.code, str(exc), exc.status) from exc


@router.get("", summary="The threads of a note, open ones first")
def listing(path: PathQuery, account: Account) -> dict[str, Any]:
    with _note(account, path) as (db, file, who):
        return {"threads": comments.threads(db, file.id, who)}


class StartIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    quote: str = Field(max_length=comments.MAX_QUOTE * 2)
    before: str = Field(default="", max_length=2000)
    after: str = Field(default="", max_length=2000)
    body: str = Field(max_length=comments.MAX_BODY * 2)


@router.post("", status_code=201, summary="Start a thread on words of a note")
def start(body: StartIn, account: Account) -> dict[str, int]:
    with _note(account, body.path) as (db, file, who):
        made = comments.start(db, file, who, quote=body.quote, before=body.before, after=body.after, body=body.body)
        return {"id": made.id}


class BodyIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    body: str = Field(max_length=comments.MAX_BODY * 2)


@router.post("/{thread_id}/replies", status_code=201, summary="Answer in a thread")
def reply(thread_id: int, body: BodyIn, account: Account) -> dict[str, int]:
    with _note(account, body.path) as (db, file, who):
        return {"id": comments.reply(db, file.id, thread_id, who, body.body).id}


@router.put("/{comment_id}", summary="Change one's own comment")
def edit(comment_id: int, body: BodyIn, account: Account) -> dict[str, int]:
    with _note(account, body.path) as (db, file, who):
        return {"id": comments.edit(db, file.id, comment_id, who, body.body).id}


@router.delete("/{comment_id}", status_code=204, summary="Take a comment back; the first one takes its thread along")
def remove(comment_id: int, path: PathQuery, account: Account) -> None:
    with _note(account, path) as (db, file, who):
        comments.remove(db, file.id, comment_id, who)


class ResolveIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    done: bool


@router.post("/{thread_id}/resolve", status_code=204, summary="Close a thread, or open it again")
def resolve(thread_id: int, body: ResolveIn, account: Account) -> None:
    with _note(account, body.path) as (db, file, who):
        comments.resolve(db, file.id, thread_id, who, body.done)


@router.get("/people", summary="Who may read the note, for @names")
def people(path: PathQuery, account: Account, q: Annotated[str, Query(max_length=64)] = "") -> list[str]:
    with _note(account, path) as (db, file, _who):
        return comments.people(db, file.space_id, q)
