"""Frag Lore (``services/lore.py``): ask about one's own notes, get the answer as it comes, with its sources; the own
conversations, read and removed. Nobody sees another's conversations, the operator neither.

``POST /api/lore/ask`` answers with ``text/event-stream``: ``start`` (the conversation, the sources, how it searched),
``delta`` (a piece of the answer), then ``done`` or ``error``. Everything that can be refused is refused before the
stream starts, as an ordinary error. The answer is kept even when the browser goes away while it is written.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
from collections.abc import Iterator
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, DbSession, need
from ..errors import error
from ..models import Account as AccountRow
from ..models import LoreConversation
from ..services import ai, lore, meaning, rights, vault
from .vault import ActorDep

logger = logging.getLogger("nexlore.lore")

router = APIRouter(prefix="/api/lore", tags=["lore"])

#: How sure Lore should sound: low, it answers from the material and should not wander.
TEMPERATURE = 0.3


class AskIn(BaseModel):
    question: str = Field(max_length=lore.MAX_QUESTION)
    #: Go on with one's own conversation; left out: a new one.
    conversation: int | None = None
    #: The space ids to look in; left out: every readable one.
    spaces: list[int] | None = Field(default=None, max_length=500)
    #: The note asked about (the tab beside it): it goes along whole, with the notes it links to.
    note: str | None = Field(default=None, max_length=1024)


def _row(db: DbSession, account: Account) -> AccountRow:
    row = db.get(AccountRow, account.id)
    if row is None:
        raise error("sign_in_required", "Sign in first.", 401)
    return row


def _on(db: DbSession) -> None:
    """Asking and looking up only while the operator lets Lore be asked; the own conversations stay readable."""
    if not ai.allowed(db):
        raise error("ai_off", "AI in notes is off on this server.", 403)
    if not lore.allowed(db):
        raise error("lore_off", "Ask Lore is not switched on on this server.", 403)


def _event(name: str, value: Any) -> str:
    return f"event: {name}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n"


@router.post("/ask", summary="Ask Lore about the own notes; the answer comes as a stream of events")
def ask(payload: AskIn, account: Account, db: DbSession) -> StreamingResponse:
    _on(db)
    row = _row(db, account)
    question = payload.question.strip()
    if not question:
        raise error("lore_question_empty", "Ask a question first.", 422)
    try:
        ai.usable(db, row)
    except ai.AiError as exc:
        raise error(exc.code, exc.code.replace("_", " "), exc.status, **exc.values) from exc
    note = need(account, payload.note, rights.READ) if payload.note else None
    try:
        conversation = (
            lore.own_conversation(db, row, payload.conversation)
            if payload.conversation is not None
            else lore.start(db, row, question, note)
        )
        earlier = lore.history(db, row, conversation)
        spaces = lore.chosen_spaces(db, row, payload.spaces)
        material = lore.gather(db, row, question, spaces=spaces, near=note)
        lore.keep(db, row, conversation, "user", {"text": question})
    except lore.LoreError as exc:
        db.rollback()
        raise error(exc.code, exc.code.replace("_", " "), exc.status, **exc.values) from exc
    db.commit()
    conversation_id = conversation.id
    sources = lore.shown_sources(material)
    said = lore.messages(material, earlier, question)
    flowing: queue.Queue[tuple[str, Any] | None] = queue.Queue()

    def work() -> None:
        with SessionLocal() as worker:
            asker = worker.get(AccountRow, account.id)
            talk = worker.get(LoreConversation, conversation_id)
            if asker is None or talk is None:
                flowing.put(("error", {"code": "not_found", "values": {}}))
                flowing.put(None)
                return
            body: dict[str, Any] = {"text": "", "sources": sources, "trace": material.trace}

            def stepped(now: lore.Material) -> None:
                # Lore looked further: the page sees the sources as they are now, and what was looked for.
                body["sources"] = lore.shown_sources(now)
                flowing.put(("sources", {"sources": body["sources"], "trace": now.trace}))

            try:
                spoken = lore.answer(worker, asker, material, said, spaces=spaces, temperature=TEMPERATURE,
                                     heard=lambda piece: flowing.put(("delta", {"t": piece})), stepped=stepped)
                body["text"] = spoken.text
                message_id = lore.keep(worker, asker, talk, "assistant", body)
                worker.commit()
                flowing.put(("done", {"conversation": conversation_id, "message": message_id}))
            except (ai.AiError, lore.LoreError) as exc:
                worker.rollback()
                body["error"] = exc.code
                try:
                    lore.keep(worker, asker, talk, "assistant", body)
                    worker.commit()
                except lore.LoreError:
                    worker.rollback()
                flowing.put(("error", {"code": exc.code, "values": exc.values}))
            except Exception:
                worker.rollback()
                logger.exception("Lore could not answer")
                flowing.put(("error", {"code": "internal_error", "values": {}}))
            finally:
                flowing.put(None)

    threading.Thread(target=work, name="lore-answer", daemon=True).start()

    def stream() -> Iterator[str]:
        yield _event("start", {"conversation": conversation_id, "sources": sources, "trace": material.trace})
        while True:
            item = flowing.get()
            if item is None:
                return
            yield _event(*item)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


class AnswerIn(BaseModel):
    #: The answer of the conversation meant.
    message: int
    #: For a proposal: the note it is for, when the conversation did not start at a note (the overlay knows the note
    #: open while it was asked).
    note: str | None = Field(default=None, max_length=1024)


@router.post("/conversations/{conversation_id}/note", status_code=201,
             summary="An answer as a note of its own, its sources as links")
def save_note(conversation_id: int, payload: AnswerIn, account: Account, db: DbSession,
              who: ActorDep) -> dict[str, str]:
    _on(db)
    row = _row(db, account)
    try:
        file = lore.save_note(db, row, lore.own_conversation(db, row, conversation_id), payload.message, who)
    except lore.LoreError as exc:
        raise error(exc.code, exc.code.replace("_", " "), exc.status, **exc.values) from exc
    except vault.VaultError as exc:
        raise error(exc.code, str(exc), exc.status) from exc
    return {"path": file.path}


@router.post("/conversations/{conversation_id}/propose", status_code=201,
             summary="What an answer about a note says, as a proposal for that note")
def propose(conversation_id: int, payload: AnswerIn, account: Account, db: DbSession) -> dict[str, Any]:
    _on(db)
    row = _row(db, account)
    note = need(account, payload.note, rights.READ) if payload.note else None
    try:
        conversation = lore.own_conversation(db, row, conversation_id)
        proposal = lore.propose(db, row, conversation, payload.message, note_path=note)
    except lore.LoreError as exc:
        raise error(exc.code, exc.code.replace("_", " "), exc.status, **exc.values) from exc
    except ai.AiError as exc:
        raise error(exc.code, exc.code.replace("_", " "), exc.status, **exc.values) from exc
    return {"proposal": proposal.id, "path": lore.path_of(db, proposal.file_id)}


@router.get("/similar", summary="The notes nearest in meaning to a note, among those one may read")
def similar(account: Account, db: DbSession, path: Annotated[str, Query(max_length=1024)]) -> dict[str, Any]:
    _on(db)
    clean = need(account, path, rights.READ)
    if not meaning.enabled(db):
        return {"on": False, "notes": []}
    from ..models import File

    file_id = db.scalar(select(File.id).where(File.path == clean, File.deleted_at.is_(None)))
    if file_id is None:
        raise error("not_found", "Not found.", 404)
    found = meaning.similar(db, file_id, rights.readable_ids(db, _row(db, account)))
    return {"on": True, "notes": meaning.shown(db, found)}


@router.get("/conversations", summary="The own conversations, newest first; with note: those about that note")
def conversations(
    account: Account, db: DbSession, note: Annotated[str | None, Query(max_length=1024)] = None
) -> list[dict[str, Any]]:
    if note is not None:
        note = need(account, note, rights.READ)
    return lore.listing(db, _row(db, account), note_path=note)


@router.get("/conversations/{conversation_id}", summary="One of the own conversations")
def conversation(conversation_id: int, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    try:
        return lore.read(db, row, lore.own_conversation(db, row, conversation_id))
    except lore.LoreError as exc:
        raise error(exc.code, "Not found.", exc.status) from exc


@router.delete("/conversations/{conversation_id}", summary="Remove one of the own conversations")
def remove(conversation_id: int, account: Account, db: DbSession) -> dict[str, int]:
    row = _row(db, account)
    removed = lore.forget(db, row, conversation_id)
    if not removed:
        raise error("not_found", "Not found.", 404)
    return {"removed": removed}


@router.delete("/conversations", summary="Remove every own conversation")
def remove_all(account: Account, db: DbSession) -> dict[str, int]:
    return {"removed": lore.forget(db, _row(db, account))}
