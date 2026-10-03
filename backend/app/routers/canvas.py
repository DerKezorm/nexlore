"""Canvases (``services/canvas``): reading, saving and making ``.canvas`` files.

A canvas is edited like a note: one person at a time (the lock under ``/api/locks``), saved against the state the page
loaded, and a save against a state that changed in between, or while somebody else holds the lock, goes into a
conflict copy beside it. Reading needs the right to read the space, saving and making the right to write.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import aliased

from ..db import SessionLocal
from ..deps import Account, need, readable_spaces
from ..errors import error
from ..models import READ, WRITE, File, Link
from ..services import canvas, index, paths, vault
from ..services.vault import VaultError
from .vault import BOM, ActorDep, LockOut, PathQuery, _fail

router = APIRouter(prefix="/api", tags=["canvas"])


class CanvasOut(BaseModel):
    path: str
    content: str
    hash: str
    size: int
    modified: int
    #: Shown, never saved: the file is not UTF-8, or no canvas nexlore can keep (``problem`` says why).
    readonly: bool = False
    problem: str | None = None
    lock: LockOut | None = None
    #: Where each card's path leads for whoever asks, from the vault's top (None: nowhere, or not for them).
    cards: dict[str, str | None] = {}
    #: The cards' paths that lead into a space whoever asks may not read: shown locked, their content never sent.
    locked: list[str] = []


class CanvasStateOut(BaseModel):
    hash: str
    modified: int
    lock: LockOut | None = None


def _lock(file_id: int, who: vault.Actor) -> LockOut | None:
    with SessionLocal() as db:
        lock = vault.lock_state(db, file_id)
        if lock is None:
            return None
        return LockOut(
            holder=lock.holder_name, mine=lock.holder == who.client, expires_at=lock.expires_at,
            own=lock.holder != who.client and lock.holder_name == who.name,
        )


def _read(path: str) -> tuple[File, bytes]:
    try:
        file, data = vault.read(path)
    except VaultError as exc:
        raise _fail(exc) from exc
    if not paths.is_canvas(file.path):
        raise error("not_a_canvas", "This file is no canvas.", 422)
    return file, data


def _cards(file_id: int, account: Account) -> tuple[dict[str, str | None], list[str]]:
    """Where the canvas's cards lead, as the index knows it, with the rights of ``account``: a card in a space they
    may not read leads nowhere for them and is named as locked."""
    readable = readable_spaces(account)
    with SessionLocal() as db:
        rows = db.execute(
            select(Link.target, Link.target_space_id, File.path)
            .outerjoin(File, File.id == Link.target_id)
            .where(Link.source_id == file_id, Link.kind == canvas.KIND)
        ).all()
    cards: dict[str, str | None] = {}
    locked: set[str] = set()
    for written, space_id, path in rows:
        if path is not None and space_id is not None and space_id not in readable:
            locked.add(written)
            path = None
        cards[written] = path
    return cards, sorted(locked)


def _out(file: File, data: bytes, who: vault.Actor) -> CanvasOut:
    problem = None
    body = data.removeprefix(BOM)
    try:
        content = body.decode("utf-8")
    except UnicodeDecodeError:
        content = body.decode("utf-8", errors="replace")
        problem = "not_utf8"
    if problem is None:
        try:
            canvas.parse(content)
        except canvas.CanvasError as exc:
            problem = exc.code
    return CanvasOut(
        path=file.path, content=content, hash=index.digest(data), size=len(data), modified=file.mtime_ns // 1_000_000,
        readonly=problem is not None, problem=problem, lock=_lock(file.id, who),
    )


@router.get("/canvas", response_model=CanvasOut, summary="A canvas with its text, state and lock")
def read(path: PathQuery, account: Account, who: ActorDep) -> CanvasOut:
    need(account, path, READ)
    file, data = _read(path)
    out = _out(file, data, who)
    out.cards, out.locked = _cards(file.id, account)
    return out


class LyingOnOut(BaseModel):
    count: int
    #: The first few, by name.
    paths: list[str]


@router.get("/canvases/on", response_model=LyingOnOut, summary="The canvases a note, file or folder lies on")
def lying_on(path: PathQuery, account: Account) -> LyingOnOut:
    """For the warning before trashing: those canvases keep a card that says it is gone, and show it again when it
    comes back. Only canvases whoever asks may read (a canvas in another space must not show itself this way), and
    none that goes into the trash along with it. A canvas in the trash names no card (its links leave the index)."""
    clean = need(account, path, READ)
    readable = readable_spaces(account)
    board = aliased(File)
    card = aliased(File)
    with SessionLocal() as db:
        rows = db.execute(
            select(board.path, board.space_id)
            .join(Link, Link.source_id == board.id)
            .join(card, card.id == Link.target_id)
            .where(
                Link.kind == canvas.KIND,
                or_(card.path == clean, card.path.startswith(clean + "/", autoescape=True)),
            )
            .distinct()
        ).all()
    goes_along = {board for board, _ in rows if board == clean or board.startswith(clean + "/")}
    found = sorted({board for board, space_id in rows if space_id in readable} - goes_along, key=paths.fold)
    return LyingOnOut(count=len(found), paths=found[:10])


@router.get("/canvas/state", response_model=CanvasStateOut, summary="How a canvas stands on disk, without its text")
def state(path: PathQuery, account: Account, who: ActorDep) -> CanvasStateOut:
    """An open canvas asks every few seconds whether to load again (somebody saved, Obsidian changed it)."""
    need(account, path, READ)
    file, data = _read(path)
    return CanvasStateOut(hash=index.digest(data), modified=file.mtime_ns // 1_000_000, lock=_lock(file.id, who))


class SaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    content: str = Field(max_length=canvas.MAX_BYTES)
    base_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class SaveOut(BaseModel):
    saved: bool
    hash: str
    conflict: str | None = None


@router.put("/canvas", response_model=SaveOut, summary="Save a canvas against the state it was loaded as")
def save(body: SaveIn, account: Account, who: ActorDep) -> SaveOut:
    need(account, body.path, WRITE)
    _file, current = _read(body.path)
    try:
        canvas.parse(body.content)
    except canvas.CanvasError as exc:
        raise error(exc.code, exc.text, 413 if exc.code == "too_large" else 422) from exc
    data = body.content.encode("utf-8")
    if current.startswith(BOM) and not data.startswith(BOM):
        data = BOM + data
    try:
        result = vault.save(body.path, data, base_hash=body.base_hash, actor=who)
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
    folder: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    #: Without ``.canvas``; the page sends the word for "Untitled" in the reader's language.
    name: str = Field(min_length=1, max_length=255)


@router.post("/canvases", response_model=CanvasOut, status_code=201, summary="Make a new, empty canvas in a folder")
def create(body: CreateIn, account: Account, who: ActorDep) -> CanvasOut:
    need(account, body.folder, WRITE)
    try:
        file = vault.create_canvas(body.folder, body.name, actor=who)
        file, data = vault.read(file.path)
    except VaultError as exc:
        raise _fail(exc) from exc
    return _out(file, data, who)
