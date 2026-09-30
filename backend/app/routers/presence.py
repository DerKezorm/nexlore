"""Who has a note open right now (``services/presence``): only for those who may read it."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, need
from ..errors import error
from ..models import READ
from ..models import Account as AccountRow
from ..services import paths, presence, vault
from ..services.vault import _valid_lock
from .vault import Actor, actor

router = APIRouter(prefix="/api", tags=["presence"])


class HereIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)


@router.post("/presence", summary="This tab has the note open; who else has it")
def here(body: HereIn, account: Account, who: Annotated[Actor, Depends(actor)]) -> dict[str, Any]:
    clean = need(account, body.path, READ)
    with SessionLocal() as db:
        file = vault.live(db, clean)
        if file is None or not file.is_note:
            raise error("not_found", "No such note.", 404)
        row = db.get(AccountRow, account.id)
        avatar = row.avatar_at.isoformat() if row is not None and row.avatar_at else None
        lock = _valid_lock(db, file.id)
        presence.touch(file.id, account.id, account.name, avatar, who.client)
        return {"people": presence.others(file.id, account.id, lock.holder if lock else None)}


@router.delete("/presence", status_code=204, summary="This tab closed the note")
def gone(
    path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
    account: Account,
    who: Annotated[Actor, Depends(actor)],
) -> None:
    clean = need(account, path, READ)
    with SessionLocal() as db:
        file = vault.live(db, clean)
    if file is not None:
        presence.leave(file.id, account.id, who.client)
