"""Drawings (``services/ink``): reading, saving and making the ``.svg`` files nexlore draws in.

A drawing is edited like a canvas: one person at a time (the lock under ``/api/locks``), saved against the state the
page loaded, and a save against a state that changed in between, or while somebody else holds the lock, goes into a
conflict copy beside it. The page sends the strokes, never SVG: the server writes the file itself (``ink.write``).
Reading needs the right to read the space, saving and making the right to write.

An SVG without the mark is somebody's picture: it is answered as ``not_ink`` with nothing to draw (the page shows it
as the file it is) and never written here.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..deps import Account, need
from ..errors import error
from ..models import READ, WRITE, File
from ..services import attachments, index, ink, paths, vault
from ..services.vault import VaultError
from .canvas import _lock
from .vault import BOM, ActorDep, LockOut, PathQuery, _fail

router = APIRouter(prefix="/api", tags=["ink"])


class InkOut(BaseModel):
    path: str
    #: The drawing as the file holds it (``services/ink``); None when it cannot be drawn in (``problem`` says why).
    ink: dict[str, Any] | None
    hash: str
    size: int
    modified: int
    #: Shown, never saved: an SVG without the mark (``not_ink``), not UTF-8 (``not_utf8``), or data nexlore cannot
    #: keep (``bad_ink``, ``too_large``, ``newer_ink``).
    readonly: bool = False
    problem: str | None = None
    lock: LockOut | None = None


class InkStateOut(BaseModel):
    hash: str
    modified: int
    lock: LockOut | None = None


def _read(path: str) -> tuple[File, bytes]:
    try:
        file, data = vault.read(path)
    except VaultError as exc:
        raise _fail(exc) from exc
    if not paths.is_svg(file.path):
        raise error("not_a_drawing", "This file is no drawing.", 422)
    return file, data


def _drawing(data: bytes) -> tuple[dict[str, Any] | None, str | None]:
    """The drawing in a file, or why there is none to draw in."""
    if not ink.is_ink(data):
        return None, "not_ink"
    try:
        text = data.removeprefix(BOM).decode("utf-8")
    except UnicodeDecodeError:
        return None, "not_utf8"
    try:
        return ink.parse(text), None
    except ink.InkError as exc:
        return None, exc.code


@router.get("/ink", response_model=InkOut, summary="A drawing with its strokes, state and lock")
def read(path: PathQuery, account: Account, who: ActorDep) -> InkOut:
    need(account, path, READ)
    file, data = _read(path)
    drawing, problem = _drawing(data)
    return InkOut(
        path=file.path, ink=drawing, hash=index.digest(data), size=len(data), modified=file.mtime_ns // 1_000_000,
        readonly=problem is not None, problem=problem, lock=_lock(file.id, who),
    )


@router.get("/ink/state", response_model=InkStateOut, summary="How a drawing stands on disk, without its strokes")
def state(path: PathQuery, account: Account, who: ActorDep) -> InkStateOut:
    """An open drawing asks every few seconds whether to load again (somebody saved, the iPad changed it)."""
    need(account, path, READ)
    file, data = _read(path)
    return InkStateOut(hash=index.digest(data), modified=file.mtime_ns // 1_000_000, lock=_lock(file.id, who))


class SaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    #: The drawing as ``ink.check`` takes it; checked there, not here, so that unknown fields stay.
    ink: dict[str, Any]
    base_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class SaveOut(BaseModel):
    saved: bool
    hash: str
    conflict: str | None = None


@router.put("/ink", response_model=SaveOut, summary="Save a drawing against the state it was loaded as")
def save(body: SaveIn, account: Account, who: ActorDep) -> SaveOut:
    need(account, body.path, WRITE)
    _file, current = _read(body.path)
    if not ink.is_ink(current):
        # Somebody's picture: drawing over it would replace it with a drawing of nothing.
        raise error("not_ink", "This picture is no drawing of nexlore's.", 422)
    try:
        data = ink.encode(body.ink)
    except ink.InkError as exc:
        raise error(exc.code, exc.text, 413 if exc.code == "too_large" else 422) from exc
    try:
        result = vault.save(body.path, data, base_hash=body.base_hash, actor=who, drawing=True)
    except VaultError as exc:
        raise _fail(exc) from exc
    if result.conflict:
        try:
            _file, now = vault.read(body.path)
        except VaultError:
            now = current
        return SaveOut(saved=False, hash=index.digest(now), conflict=result.conflict)
    return SaveOut(saved=result.changed, hash=index.digest(data))


class CreateIn(BaseModel):
    #: The note the drawing is for: it lands in that note's attachment folder.
    note: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)


class CreateOut(BaseModel):
    path: str
    #: What to put into the note where the drawing goes: ``![[Shopping 1.svg]]``.
    embed: str


@router.post("/inks", response_model=CreateOut, status_code=201, summary="Make a new, empty drawing for a note")
def create(body: CreateIn, account: Account, who: ActorDep) -> CreateOut:
    need(account, body.note, WRITE)
    try:
        made = attachments.new_ink(body.note, actor=who)
    except VaultError as exc:
        raise _fail(exc) from exc
    return CreateOut(path=made.path, embed=made.embed)
