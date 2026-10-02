"""Mentions of a note without a link, turning one into a link, and the page for cleaning up a space
(``services/mentions``). Everything here keeps to the spaces the account may read; linking needs the right to write
in the note that gets the link."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import READ, WRITE, Space
from ..services import mentions, paths
from .vault import Actor, actor

router = APIRouter(prefix="/api", tags=["cleanup"])

PathQuery = Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)]


@router.get("/mentions", summary="Where other notes name this one without a link")
def unlinked(path: PathQuery, account: Account) -> dict[str, Any]:
    clean = need(account, path, READ)
    readable = readable_spaces(account)
    writable = readable_spaces(account, WRITE)
    places, more = mentions.unlinked(clean, readable)
    with SessionLocal() as db:
        spaces = {folder: space_id for space_id, folder in db.execute(select(Space.id, Space.folder))}
    return {
        "places": [
            {**asdict(place), "writable": spaces.get(paths.space_of(place.path)) in writable} for place in places
        ],
        "more": more,
    }


class LinkIn(BaseModel):
    #: The note the words stand in, and the note they name.
    source: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    target: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    line: int = Field(ge=1, le=10_000_000)
    column: int = Field(ge=0, le=10_000_000)
    words: str = Field(min_length=1, max_length=1024)


@router.post("/mentions/link", summary="Turn one mention into a link")
def link(body: LinkIn, account: Account, who: Annotated[Actor, Depends(actor)]) -> dict[str, str]:
    source = need(account, body.source, WRITE)
    target = need(account, body.target, READ)
    try:
        written = mentions.link_place(source, target, body.line, body.column, body.words, author=who.name,
                                      as_source=who.writes_as())
    except mentions.MentionError as exc:
        status = 404 if exc.code == "not_found" else 409
        raise error(exc.code, str(exc), status) from exc
    return {"link": written}


@router.get("/cleanup", summary="Notes without a link in or out, and links that lead nowhere, in one space")
def cleanup(space: Annotated[str, Query(min_length=1, max_length=255)], account: Account) -> dict[str, Any]:
    need(account, space, READ)
    with SessionLocal() as db:
        space_id = db.scalar(select(Space.id).where(Space.folder == space))
    if space_id is None:
        raise error("not_found", "No such space.", 404)
    lonely, lonely_total = mentions.lonely_notes(space_id)
    broken, broken_total = mentions.broken_links(space_id)
    return {
        "lonely": [asdict(row) for row in lonely],
        "lonely_total": lonely_total,
        "broken": [asdict(row) for row in broken],
        "broken_total": broken_total,
    }
