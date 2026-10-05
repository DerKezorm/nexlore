"""The AI service (``services/ai.py``): the account's own access, or the operator's one for all, the models an access
offers, a task on note text, and the list of what went out. Every account sees only its own; the operator's lock is
checked on every request that sends."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..models import Account as AccountRow
from ..security import brake
from ..services import ai, lore, meaning, settings_service

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


def _state(db: DbSession, row: AccountRow) -> dict[str, Any]:
    return {
        "allowed": ai.allowed(db),
        "ready": ai.ready(db, row),
        "mode": ai.mode(db),
        "access": ai.view(row),
        "shared": ai.shared_view(db, operator=False),
        "tones": list(ai.TONES),
        # How long conversations with Lore stay; the page says so.
        "keep_days": lore.keep_days(db),
    }


@router.get("", summary="The AI service: allowed or not, own or the operator's, the access, what may be chosen")
def read(account: Account, db: DbSession) -> dict[str, Any]:
    return _state(db, _row(db, account))


@router.put("", summary="Change the own access; what is left out stays")
def save(payload: AccessIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = _row(db, account)
    try:
        ai.save(db, row, **payload.model_dump(exclude_unset=True))
    except ai.AiError as exc:
        raise _fail(exc) from exc
    return _state(db, row)


#: Model lists one account may ask for in an hour.
MODEL_LISTS_PER_HOUR = 30


class SharedIn(BaseModel):
    url: str | None = Field(default=None, max_length=500)
    model: str | None = Field(default=None, max_length=200)
    #: The model that turns notes into vectors; empty: Lore finds notes by their words only.
    embed_model: str | None = Field(default=None, max_length=200)
    #: Empty removes the key; left out keeps it.
    key: str | None = Field(default=None, max_length=1000)


@router.get("/shared", summary="The operator's service for every account, and how far notes are read in by meaning")
def shared(_operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return {**ai.shared_view(db, operator=True), "meaning": meaning.progress(db), "meaning_on": meaning.enabled(db)}


@router.put("/shared", summary="Change the operator's service for every account; what is left out stays")
def save_shared(payload: SharedIn, _operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    before = meaning.model(db)
    try:
        ai.save_shared(db, **payload.model_dump(exclude_unset=True))
    except ai.AiError as exc:
        raise _fail(exc) from exc
    if meaning.model(db) != before:
        # Vectors of another model cannot be compared with the new ones: they go, and reading in starts at once.
        meaning.forget(db)
        if meaning.enabled(db):
            meaning.read_in_now()
    return {**ai.shared_view(db, operator=True), "meaning": meaning.progress(db), "meaning_on": meaning.enabled(db)}


@router.post("/shared/models", summary="The models of the operator's service, with what is typed or what is saved")
def shared_models(payload: ModelsIn, operator: OperatorAccount, db: DbSession) -> list[dict[str, str]]:
    if not ai.allowed(db):
        raise error("ai_off", "AI in notes is off on this server.", 403)
    key_name = f"ai-models:{operator.id}"
    if brake.wait_seconds(key_name, MODEL_LISTS_PER_HOUR):
        raise error("too_many_attempts", "Too many tries. Try again later.", 429)
    brake.failed(key_name)
    url = payload.url if payload.url is not None else str(settings_service.get(db, "ai_shared_url") or "")
    key = payload.key if payload.key else ai.shared_key(db)
    try:
        return ai.list_models(db, url, key, trusted=True)
    except ai.AiError as exc:
        raise _fail(exc) from exc


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
