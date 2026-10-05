"""Proposals: somebody who may read a space writes a change for one of its notes, with a message; the writers of the
space see it on the note, compare, take it over or turn it down; the proposer sees what became of it.

Taking over saves against the state the proposal was written on, as the editor does: changed in between, the text
goes into a conflict copy instead of over somebody's words. A proposal is never visible to anyone who may not read
its space; a declined or taken one stays for its proposer to see.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import READ, WRITE, File, Proposal
from ..models import Account as AccountRow
from ..services import paths, rights, vault
from ..services.vault import VaultError
from .vault import ActorDep

logger = logging.getLogger("nexlore.proposals")
router = APIRouter(prefix="/api", tags=["proposals"])

MAX_BYTES = 1024 * 1024
MAX_OPEN = 50
#: ``copied``: taken over, but into a conflict copy beside the note (it changed, or somebody was editing it).
OPEN, TAKEN, DECLINED, COPIED = "open", "taken", "declined", "copied"
#: For the moment between claiming a proposal and writing it: a second click finds it decided.
TAKING = "taking"


class ProposalIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    content: str = Field(max_length=MAX_BYTES)
    base_hash: str = Field(min_length=64, max_length=64)
    message: str = Field(default="", max_length=500)


class ProposalOut(BaseModel):
    id: int
    path: str
    title: str
    by: str
    message: str
    status: str
    created_at: datetime
    decided_at: datetime | None = None
    decided_by: str | None = None
    #: The proposed text; only in the answers about one note.
    content: str | None = None
    #: Written by Lore for the person who asked.
    lore: bool = False


def _out(db: Session, row: Proposal, with_content: bool = False) -> ProposalOut | None:
    file = db.get(File, row.file_id)
    if file is None or file.deleted_at is not None:
        return None
    by = db.scalar(select(AccountRow.name).where(AccountRow.id == row.account_id)) or ""
    return ProposalOut(
        id=row.id, path=file.path, title=file.title, by=by, message=row.message, status=row.status,
        created_at=row.created_at, decided_at=row.decided_at, decided_by=row.decided_by,
        content=row.content.decode("utf-8") if with_content else None, lore=bool(row.lore),
    )


def _writable(account: Any) -> set[int]:
    return readable_spaces(account, WRITE)


@router.post("/proposals", status_code=201, response_model=ProposalOut, summary="Propose a change to a note")
def propose(body: ProposalIn, account: Account) -> ProposalOut:
    clean = need(account, body.path, READ)
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == clean, File.deleted_at.is_(None), File.is_note.is_(True)))
        if file is None:
            raise error("not_found", "Not found.", 404)
        waiting = db.scalar(
            select(func.count()).select_from(Proposal).where(Proposal.account_id == account.id, Proposal.status == OPEN)
        ) or 0
        if waiting >= MAX_OPEN:
            raise error("too_many_proposals", "Too many proposals wait for an answer.", 422, max=MAX_OPEN)
        row = Proposal(
            account_id=account.id, space_id=file.space_id, file_id=file.id, base_hash=body.base_hash,
            content=body.content.encode("utf-8"), message=body.message.strip(),
        )
        db.add(row)
        db.commit()
        out = _out(db, row)
    assert out is not None
    logger.info("Proposal made proposal_id=%s", out.id)
    return out


@router.get("/proposals/note", response_model=list[ProposalOut], summary="The open proposals for a note")
def for_note(
    account: Account, path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)]
) -> list[ProposalOut]:
    """For the writers of its space all open ones; for anybody else the own."""
    clean = need(account, path, READ)
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == clean, File.deleted_at.is_(None)))
        if file is None:
            return []
        query = select(Proposal).where(Proposal.file_id == file.id, Proposal.status == OPEN)
        if file.space_id not in _writable(account):
            query = query.where(Proposal.account_id == account.id)
        rows = db.scalars(query.order_by(Proposal.id)).all()
        return [out for row in rows if (out := _out(db, row, with_content=True)) is not None]


@router.get("/proposals", summary="Proposals waiting for the own answer, and what became of the own proposals")
def overview(account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        waiting = db.scalars(
            select(Proposal)
            .where(Proposal.space_id.in_(_writable(account)), Proposal.status == OPEN)
            .where(Proposal.account_id != account.id)
            .order_by(Proposal.id.desc())
            .limit(50)
        ).all()
        mine = db.scalars(
            select(Proposal).where(Proposal.account_id == account.id).order_by(Proposal.id.desc()).limit(20)
        ).all()
        readable = readable_spaces(account)
        return {
            "waiting": [out for row in waiting if (out := _out(db, row)) is not None],
            "mine": [out for row in mine if row.space_id in readable and (out := _out(db, row)) is not None],
        }


def _decidable(db: Session, account: Any, proposal_id: int) -> tuple[Proposal, File]:
    row = db.get(Proposal, proposal_id)
    file = db.get(File, row.file_id) if row is not None else None
    if row is None or file is None or file.deleted_at is not None or row.space_id not in readable_spaces(account):
        raise error("not_found", "Not found.", 404)
    if not rights.at_least(rights.role_in(db, account, row.space_id), WRITE):
        raise error("forbidden", "Only who may write in the space decides.", 403)
    if row.status != OPEN:
        raise error("decided", "This proposal was answered already.", 409)
    return row, file


@router.post("/proposals/{proposal_id}/take", summary="Take a proposal over into the note")
def take(proposal_id: Annotated[int, Path(ge=1)], account: Account, who: ActorDep) -> dict[str, Any]:
    with SessionLocal() as db:
        row, file = _decidable(db, account, proposal_id)
        target, data, base_hash = file.path, row.content, row.base_hash
        # Claimed at once, in one step: two clicks at the same moment wrote it twice (review P6.15).
        claimed = db.execute(
            update(Proposal).where(Proposal.id == proposal_id, Proposal.status == OPEN).values(status=TAKING)
        ).rowcount
        db.commit()
        if not claimed:
            raise error("decided", "This proposal was answered already.", 409)
    try:
        saved = vault.save(target, data, base_hash=base_hash, actor=who, source="proposal")
    except VaultError as exc:
        with SessionLocal() as db:
            db.execute(update(Proposal).where(Proposal.id == proposal_id).values(status=OPEN))
            db.commit()
        raise error(exc.code, exc.text, exc.status) from exc
    with SessionLocal() as db:
        found = db.get(Proposal, proposal_id)
        if found is not None:
            # Into a copy is not into the note: the proposer reads so (review P6.5).
            found.status = COPIED if saved.conflict else TAKEN
            found.decided_at, found.decided_by = datetime.now(UTC), account.name
            db.commit()
    logger.info("Proposal taken over proposal_id=%s conflict=%s", proposal_id, saved.conflict is not None)
    return {"path": target, "conflict": saved.conflict, "reason": saved.reason}


@router.post("/proposals/{proposal_id}/decline", status_code=204, summary="Turn a proposal down")
def decline(proposal_id: Annotated[int, Path(ge=1)], account: Account) -> None:
    with SessionLocal() as db:
        row, _ = _decidable(db, account, proposal_id)
        row.status, row.decided_at, row.decided_by = DECLINED, datetime.now(UTC), account.name
        db.commit()


@router.delete("/proposals/{proposal_id}", status_code=204, summary="Take back an own proposal still waiting")
def withdraw(proposal_id: Annotated[int, Path(ge=1)], account: Account) -> None:
    with SessionLocal() as db:
        row = db.get(Proposal, proposal_id)
        if row is None or row.account_id != account.id:
            raise error("not_found", "Not found.", 404)
        db.delete(row)
        db.commit()

