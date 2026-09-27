"""Everyday use over HTTP (M6): daily notes, templates, the task overview, the calendar, the options of a space.

Every route asks for its right first (``deps.need``); lists (tasks, calendar) span only the spaces the account may
read (``deps.readable_spaces``), and a space it may not read answers exactly like one that does not exist.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import MANAGE, READ, WRITE, Space
from ..services import everyday, paths, rights
from ..services.vault import Actor, VaultError
from .vault import actor

router = APIRouter(prefix="/api", tags=["everyday"])

ActorDep = Annotated[Actor, Depends(actor)]
SpaceName = Annotated[str, Query(min_length=1, max_length=255)]
DateQuery = Annotated[str, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")]


def _fail(exc: VaultError) -> Exception:
    return error(exc.code, exc.text, exc.status, **exc.values)


def _space_id(account: Any, name: str | None) -> int | None:
    """The id of a space the account may read, from its name; None for no name. One it may not read answers like a
    missing one."""
    if not name:
        return None
    need(account, name, READ)
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == name))
    if space is None:
        raise error("not_found", "Not found.", 404)
    return space.id


def _role(account: Any, name: str) -> str | None:
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == name))
        return rights.role_in(db, account, space.id if space is not None else None)


# --- Options of a space --------------------------------------------------------------------------------------------


class OptionsIn(BaseModel):
    daily_folder: str | None = Field(default=None, max_length=paths.MAX_PATH_CHARS)
    daily_template: str | None = Field(default=None, max_length=paths.MAX_PATH_CHARS)
    template_folder: str | None = Field(default=None, max_length=paths.MAX_PATH_CHARS)


@router.get("/spaces/{name}/options", summary="Where the daily notes and templates of a space live")
def get_options(name: str, account: Account) -> dict[str, str]:
    space = need(account, name, READ)
    if "/" in space:
        raise error("not_found", "Not found.", 404)
    try:
        return everyday.options(space)
    except VaultError as exc:
        raise _fail(exc) from exc


@router.put("/spaces/{name}/options", summary="Set where the daily notes and templates of a space live")
def put_options(name: str, body: OptionsIn, account: Account) -> dict[str, str]:
    space = need(account, name, MANAGE)
    if "/" in space:
        raise error("not_found", "Not found.", 404)
    try:
        return everyday.set_options(space, body.model_dump(exclude_none=True))
    except VaultError as exc:
        raise _fail(exc) from exc


# --- Daily notes and templates -------------------------------------------------------------------------------------


class DailyIn(BaseModel):
    space: str = Field(min_length=1, max_length=255)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/daily", summary="Open the daily note of a date, made from the space's template when missing")
def daily(body: DailyIn, account: Account, who: ActorDep) -> dict[str, Any]:
    space = need(account, body.space, READ)
    if "/" in space:
        raise error("not_found", "Not found.", 404)
    may_write = rights.at_least(_role(account, space), WRITE)
    try:
        made = everyday.open_daily(space, body.date, actor=who, may_write=may_write, language=account.language or "en")
    except VaultError as exc:
        raise _fail(exc) from exc
    return {"path": made.path, "created": made.created}


@router.get("/templates", summary="The templates of a space")
def template_list(space: SpaceName, account: Account) -> list[dict[str, str]]:
    name = need(account, space, READ)
    if "/" in name:
        raise error("not_found", "Not found.", 404)
    try:
        return everyday.template_list(name)
    except VaultError as exc:
        raise _fail(exc) from exc


@router.get("/templates/preview", summary="A template with its placeholders filled, as a new note would start")
def template_preview(
    path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
    account: Account,
    title: Annotated[str, Query(max_length=1024)] = "",
) -> dict[str, str]:
    rel = need(account, path, READ)
    if not paths.is_note(rel):
        raise error("not_a_note", "A template is a note.")
    try:
        text = everyday.render(rel, title=title, when=datetime.now().astimezone(), language=account.language or "en")
    except VaultError as exc:
        raise _fail(exc) from exc
    return {"content": text}


# --- Tasks ---------------------------------------------------------------------------------------------------------


@router.get("/tasks", summary="Tasks across the spaces the account may read")
def task_list(
    account: Account,
    today: DateQuery,
    status: Annotated[str, Query(pattern="^(open|done|all)$")] = "open",
    when: Annotated[str | None, Query(pattern="^(overdue|today|week|later|none)$")] = None,
    on: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    start: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    end: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    space: Annotated[str | None, Query(max_length=255)] = None,
    tag: Annotated[str | None, Query(max_length=255)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    space_id = _space_id(account, space)
    try:
        return everyday.list_tasks(
            readable_spaces(account), status=status, when=when, today=today, on=on, tag=tag or None, q=q or None,
            space_id=space_id, offset=offset, limit=limit, between=(start, end) if start and end else None,
        )
    except VaultError as exc:
        raise _fail(exc) from exc


class ToggleIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    line: int = Field(ge=1)
    raw: str = Field(max_length=1_000_000)
    done: bool
    today: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/tasks/toggle", summary="Tick a task off, or open it again: only its line changes")
def task_toggle(body: ToggleIn, account: Account, who: ActorDep) -> dict[str, Any]:
    rel = need(account, body.path, WRITE)
    try:
        return everyday.toggle(rel, body.line, body.raw, done=body.done, today=body.today, actor=who)
    except VaultError as exc:
        raise _fail(exc) from exc


# --- The calendar --------------------------------------------------------------------------------------------------


@router.get("/calendar", summary="Daily notes and task counts for each day of a month")
def calendar(
    account: Account,
    month: Annotated[str, Query(pattern=r"^\d{4}-\d{2}$")],
    today: DateQuery,
    space: Annotated[str | None, Query(max_length=255)] = None,
) -> dict[str, Any]:
    space_id = _space_id(account, space)
    try:
        return everyday.calendar(readable_spaces(account), month, today=today, space_id=space_id)
    except VaultError as exc:
        raise _fail(exc) from exc
