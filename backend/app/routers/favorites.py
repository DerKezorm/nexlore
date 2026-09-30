"""The own favorites (``services/favorites``): listed with the right to read, each with what it is now. A favorite in a
space the account may not read is left out, as if it were not there. A search needs no right: its hits are the
reader's own."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import File, Space
from ..services import favorites, paths

router = APIRouter(prefix="/api", tags=["favorites"])


class FavoriteIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS + 1 + favorites.MAX_HEADING)
    on: bool = True
    #: The group to put it in (empty: none); left out, a favorite that is there keeps its group.
    section: str | None = Field(default=None, max_length=favorites.MAX_SECTION)


@router.get("/favorites", summary="The own favorites that are there and may be read, in the order they were added")
def listing(account: Account) -> list[dict[str, Any]]:
    readable = readable_spaces(account)
    with SessionLocal() as db:
        spaces = {folder: space_id for space_id, folder in db.execute(select(Space.id, Space.folder))}
        out: list[dict[str, Any]] = []
        for path, section in favorites.of(db, account.id):
            if path.startswith(favorites.SEARCH):
                out.append({"path": path, "kind": "search", "title": path[len(favorites.SEARCH) :], "section": section})
                continue
            heading = favorites.heading_of(path)
            target = heading[0] if heading else path
            if spaces.get(paths.space_of(target)) not in readable:
                continue
            file = db.scalar(select(File).where(File.path == target, File.deleted_at.is_(None)))
            if heading and file is not None and file.is_note:
                out.append({"path": path, "kind": "heading", "title": heading[1], "note": target, "section": section})
            elif heading:
                continue
            elif file is not None:
                kind = "note" if file.is_note else "file"
                out.append({"path": path, "kind": kind, "title": file.title or paths.stem(path), "section": section})
            elif paths.vault_root().joinpath(*path.split("/")).is_dir():
                out.append({"path": path, "kind": "folder", "title": path.rsplit("/", 1)[-1], "section": section})
    return out


@router.put("/favorites", status_code=204, summary="Make a note, folder, heading or search a favorite, or not any more")
def set_favorite(body: FavoriteIn, account: Account) -> None:
    section = None if body.section is None else " ".join(body.section.split())
    if body.path.startswith(favorites.SEARCH):
        words = " ".join(body.path[len(favorites.SEARCH) :].split())
        if not words or len(words) > favorites.MAX_QUERY:
            raise error("bad_favorite", "A search needs words, and not too many.", 422)
        clean = favorites.SEARCH + words
    else:
        heading = favorites.heading_of(body.path)
        target = need(account, heading[0] if heading else body.path, "read")
        if heading:
            words = " ".join(heading[1].split())
            if not words or len(words) > favorites.MAX_HEADING:
                raise error("bad_favorite", "A heading needs words, and not too many.", 422)
        clean = f"{target}#{words}" if heading else target
        full = paths.vault_root().joinpath(*target.split("/"))
        if body.on and (not full.exists() or (heading and not full.is_file())):
            raise error("not_found", "Not found.", 404)
    with SessionLocal() as db:
        try:
            favorites.put(db, account.id, clean, body.on, section)
        except favorites.FavoriteError as exc:
            raise error("too_many_favorites", "Too many favorites.", 422, max=favorites.MAX) from exc
        db.commit()
