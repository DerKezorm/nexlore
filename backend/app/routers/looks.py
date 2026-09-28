"""Symbols and colours of spaces and folders (``services/looks``): read with the right to read, set with the right to
write. A space or folder one may not read answers like one that does not exist."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import WRITE, Space
from ..services import looks, paths

router = APIRouter(prefix="/api", tags=["looks"])


@router.get("/looks", summary="The symbols and colours of every space and folder one may read, and those to choose")
def all_looks(account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        found = looks.of_spaces(db, readable_spaces(account))
    return {"looks": found, "icons": list(looks.ICONS), "colors": list(looks.COLORS)}


class LookIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)


@router.put("/looks", status_code=204, summary="Give a space or folder a symbol and a colour, or neither")
def set_look(body: LookIn, account: Account) -> Response:
    clean = need(account, body.path, WRITE)
    try:
        full = paths.resolve(clean)
    except paths.PathError as exc:
        raise error(exc.code, str(exc)) from exc
    if not full.is_dir():
        raise error("not_found", "Not found.", 404)
    space_name, _, folder = clean.partition("/")
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == space_name))
        if space is None:
            raise error("not_found", "Not found.", 404)
        try:
            looks.put(db, space.id, folder, body.icon, body.color)
        except looks.LookError as exc:
            raise error("invalid_input", str(exc), 422) from exc
        db.commit()
    return Response(status_code=204)
