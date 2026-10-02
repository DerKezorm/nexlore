"""The account's own AI service (``services/ai.py``): its access, the models it offers, a task on note text, and the
list of what went out. Every account sees only its own; the operator's lock is checked on every request that sends."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..errors import error
from ..models import Account as AccountRow
from ..security import brake
from ..services import ai

router = APIRouter(prefix="/api/ai", tags=["ai"])


class AccessIn(BaseModel):
    active: bool | None = None
    url: str | None = Field(default=None, max_length=500)
    model: str | None = Field(default=None, max_length=200)
    #: Empty removes the key; left out keeps it.
    key: str | None = Field(default=None, max_length=1000)


class ModelsIn(BaseModel):
    """The address and key being typed, before they are saved; left out: the saved ones."""

    url: str | None = Field(default=None, max_length=500)
    key: str | None = Field(default=None, max_length=1000)


class RunIn(BaseModel):
    task: Literal["spelling", "rewrite", "translate", "summarize", "write"]
    text: str = Field(default="", max_length=ai.MAX_CHARS + 1)
    #: The tone of "rewrite", the language of "translate".
    target: str = Field(default="", max_length=100)
    #: The request of "write".
    instruction: str = Field(default="", max_length=ai.MAX_INSTRUCTION + 1)


def _row(db: DbSession, account: Account) -> AccountRow:
    row = db.get(AccountRow, account.id)
    if row is None:
        raise error("sign_in_required", "Sign in first.", 401)
    return row


def _fail(exc: ai.AiError):
    return error(exc.code, exc.code.replace("_", " "), exc.status, **exc.values)


@router.get("", summary="The own AI service: allowed by the operator, the access, and what may be chosen")
def read(account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    return {"allowed": ai.allowed(db), "ready": ai.ready(db, row), "access": ai.view(row), "tones": list(ai.TONES)}


@router.put("", summary="Change the own access; what is left out stays")
def save(payload: AccessIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    try:
        access = ai.save(db, row, **payload.model_dump(exclude_unset=True))
    except ai.AiError as exc:
        raise _fail(exc) from exc
    return {"allowed": ai.allowed(db), "ready": ai.ready(db, row), "access": access, "tones": list(ai.TONES)}


#: Model lists one account may ask for in an hour.
MODEL_LISTS_PER_HOUR = 30


@router.post("/models", summary="The models of an access: the test that address and key are right")
def models(payload: ModelsIn, account: Account, db: DbSession) -> list[dict[str, str]]:
    # It sends the key out: only with the operator's lock open.
    if not ai.allowed(db):
        raise error("ai_off", "AI in notes is off on this server.", 403)
    # Each asking may wait on a slow service: a few an hour, or one account ties up the server (review before 1.0.0).
    key_name = f"ai-models:{account.id}"
    if brake.wait_seconds(key_name, MODEL_LISTS_PER_HOUR):
        raise error("too_many_attempts", "Too many tries. Try again later.", 429)
    brake.failed(key_name)
    row = _row(db, account)
    url = payload.url if payload.url is not None else row.ai_url
    key = payload.key if payload.key else ai.key_of(row)
    try:
        return ai.list_models(db, url, key)
    except ai.AiError as exc:
        raise _fail(exc) from exc


@router.post("/run", summary="Send note text to the own service for one task and get its text back")
def run(payload: RunIn, account: Account, db: DbSession) -> dict[str, str]:
    row = _row(db, account)
    try:
        text = ai.run(
            db, row, task=payload.task, text=payload.text, target=payload.target, instruction=payload.instruction
        )
    except ai.AiError as exc:
        raise _fail(exc) from exc
    return {"text": text}


@router.get("/events", summary="What went out to the own service, word for word, newest first (14 days)")
def events(account: Account, db: DbSession) -> list[dict[str, Any]]:
    return ai.events(db, _row(db, account))


@router.delete("/events", summary="Clear the own list at once")
def clear(account: Account, db: DbSession) -> dict[str, int]:
    return {"removed": ai.clear_events(db, _row(db, account))}
