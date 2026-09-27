"""Drafts an AI proposed over MCP, in the interface: listed, compared, taken over or thrown away.

A draft belongs to the account whose key made it; nobody else sees it. And it shows only while that account may
still read its space: a right taken away takes the draft out of sight, and one that is back brings it back. Taking
it over needs the right to write, and saves like the editor: against the state the AI read, so a note changed in
the meantime gets a conflict copy instead of being overwritten.
"""

from __future__ import annotations

import logging
import posixpath
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path, Query
from pydantic import BaseModel
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import WRITE, Draft, File
from ..services import index, mcp, paths, vault
from ..services.vault import VaultError
from .vault import ActorDep

logger = logging.getLogger("nexlore.mcp")

router = APIRouter(prefix="/api/drafts", tags=["drafts"])


class DraftOut(BaseModel):
    id: int
    #: The note it changes, or the note it would make.
    path: str
    title: str
    new: bool
    key_name: str
    reason: str
    created_at: datetime


class DraftFull(DraftOut):
    content: str
    #: What the note holds now; None for a new note, or a note gone since.
    current: str | None
    #: The note changed since the AI read it: taking over writes a conflict copy.
    changed: bool


def _out(draft: Draft, file: File | None) -> DraftOut:
    if draft.file_id is None:
        title = posixpath.basename(draft.path)
    else:
        title = file.title if file is not None else paths.stem(draft.path)
    path = file.path if file is not None else draft.path
    return DraftOut(id=draft.id, path=path, title=title, new=draft.file_id is None, key_name=draft.key_name,
                    reason=draft.reason, created_at=draft.created_at)


def _mine(db, account, draft_id: int) -> tuple[Draft, File | None]:  # type: ignore[no-untyped-def]
    draft = db.get(Draft, draft_id)
    if draft is None or draft.account_id != account.id or draft.space_id not in readable_spaces(account):
        raise error("not_found", "Not found.", 404)
    file = db.get(File, draft.file_id) if draft.file_id is not None else None
    if draft.file_id is not None and (file is None or file.deleted_at is not None):
        file = None
    return draft, file


@router.get("", response_model=list[DraftOut])
def listing(
    account: Account, path: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None
) -> list[DraftOut]:
    """The account's open drafts; with ``path`` only those for that note."""
    readable = readable_spaces(account)
    with SessionLocal() as db:
        query = select(Draft).where(Draft.account_id == account.id, Draft.space_id.in_(readable))
        rows = db.scalars(query.order_by(Draft.created_at.desc(), Draft.id.desc())).all()
        result = []
        for draft in rows:
            file = db.get(File, draft.file_id) if draft.file_id is not None else None
            if draft.file_id is not None and (file is None or file.deleted_at is not None):
                continue  # the note is gone: its draft waits for it to come back from the trash
            out = _out(draft, file)
            if path is None or out.path == path:
                result.append(out)
    return result


@router.get("/{draft_id}", response_model=DraftFull)
def one(draft_id: Annotated[int, Path(ge=1)], account: Account) -> DraftFull:
    with SessionLocal() as db:
        draft, file = _mine(db, account, draft_id)
        out = _out(draft, file)
        content = mcp.draft_text(draft)
    current = None
    changed = False
    if file is not None:
        try:
            _file, data = vault.read(file.path)
            current = index.decode(data)
            changed = index.digest(data) != draft.base_hash
        except VaultError:
            current = None
    return DraftFull(**out.model_dump(), content=index.decode(content), current=current, changed=changed)


class TakenOut(BaseModel):
    path: str
    #: Set when the note had changed: the draft went into this copy instead.
    conflict: str | None = None


@router.post("/{draft_id}/accept", response_model=TakenOut)
def accept(draft_id: Annotated[int, Path(ge=1)], account: Account, who: ActorDep) -> TakenOut:
    with SessionLocal() as db:
        draft, file = _mine(db, account, draft_id)
        if draft.file_id is not None and file is None:
            raise error("not_found", "Not found.", 404)
        data = mcp.draft_text(draft)
        target = file.path if file is not None else draft.path
        base_hash = draft.base_hash
        new = draft.file_id is None
    need(account, target, WRITE)
    try:
        if new:
            made = vault.create_note(posixpath.dirname(target), posixpath.basename(target), data, actor=who,
                                     source=index.MCP)
            result = TakenOut(path=made.path)
        else:
            saved = vault.save(target, data, base_hash=base_hash, actor=who, source=index.MCP)
            result = TakenOut(path=target, conflict=saved.conflict)
    except VaultError as exc:
        raise error("not_found" if exc.status == 404 else exc.code, "Not found." if exc.status == 404 else exc.text,
                    exc.status) from exc
    with SessionLocal() as db:
        found = db.get(Draft, draft_id)
        if found is not None:
            db.delete(found)
            db.commit()
    logger.info("MCP draft taken over draft_id=%s conflict=%s", draft_id, result.conflict is not None)
    return result


@router.delete("/{draft_id}", status_code=204)
def discard(draft_id: Annotated[int, Path(ge=1)], account: Account) -> None:
    with SessionLocal() as db:
        draft, _file = _mine(db, account, draft_id)
        db.delete(draft)
        db.commit()
    logger.info("MCP draft thrown away draft_id=%s", draft_id)
