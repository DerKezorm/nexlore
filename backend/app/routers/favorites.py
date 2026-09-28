"""The own favorites (``services/favorites``): listed with the right to read, each with what it is now. A favorite in a
space the account may not read is left out, as if it were not there."""

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
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    on: bool = True


@router.get("/favorites", summary="The own favorites that are there and may be read, in the order they were added")
def listing(account: Account) -> list[dict[str, Any]]:
    readable = readable_spaces(account)
    with SessionLocal() as db:
        spaces = {folder: space_id for space_id, folder in db.execute(select(Space.id, Space.folder))}
        out: list[dict[str, Any]] = []
        for path in favorites.of(db, account.id):
            if spaces.get(paths.space_of(path)) not in readable:
                continue
            file = db.scalar(select(File).where(File.path == path, File.deleted_at.is_(None)))
            if file is not None:
                kind = "note" if file.is_note else "file"
                out.append({"path": path, "kind": kind, "title": file.title or paths.stem(path)})
            elif paths.vault_root().joinpath(*path.split("/")).is_dir():
                out.append({"path": path, "kind": "folder", "title": path.rsplit("/", 1)[-1]})
    return out


@router.put("/favorites", status_code=204, summary="Make a note or folder a favorite, or not any more")
def set_favorite(body: FavoriteIn, account: Account) -> None:
    clean = need(account, body.path, "read")
    full = paths.vault_root().joinpath(*clean.split("/"))
    if body.on and not full.exists():
        raise error("not_found", "Not found.", 404)
    with SessionLocal() as db:
        try:
            favorites.put(db, account.id, clean, body.on)
        except favorites.FavoriteError as exc:
            raise error("too_many_favorites", "Too many favorites.", 422, max=favorites.MAX) from exc
        db.commit()
