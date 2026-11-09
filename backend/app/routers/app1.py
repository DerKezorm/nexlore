"""The own iPhone app: ``/api/app/1`` (``nexlore-ios/docs/vertrag-block1.md``, Fassung 0).

**A promise, but only to the own app.** The app in the App Store and the servers out there are never updated at the
same time. As long as ``app/1`` stands in the address, nothing here breaks: new fields may come, none is renamed or
taken away. A change that must break goes to ``/api/app/2`` beside it. ``PROMISED`` names every address, and
``tests/app1_contract.json`` keeps the fields of every answer (``tests/test_app1_contract.py``).

**The app works on its copy.** The server never merges: a change counts only while its base (``base_hash``) is still
the note's state, else it answers ``stale`` and the app merges. A conflict copy, as the browser and MCP write it, never
comes from here (``vault.save(strict=True)``).

Walls, in this order: a device key in ``Authorization: Bearer nxd_…`` (a cookie opens nothing here); the operator's
latch (``app_pairing_allowed``); the device's rate. A device has the rights of a browser session of its account, per
space: read, write or manage. What it may not read does not exist (404 ``not_found``), what it may only read answers
403 ``forbidden``. The two pickups of a pairing need no key and stand behind the sign-in brake instead.

Writes go through the functions of the browser (``vault.save``, ``vault.move``, ``vault.delete_path``,
``vault.restore_trash``): each a version with the source ``app``, its author the account, its session the device.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import posixpath
import threading
import time
import zlib
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, ClassVar, Literal

import anyio
from fastapi import APIRouter, Depends, Form, Header, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .. import __version__
from ..db import SessionLocal
from ..deps import client_ip, readable_spaces
from ..errors import error
from ..models import OPERATOR, READ, WRITE, AppOp, DeviceBase, File, GoneFile, Space, Version, utcnow
from ..security import brake as sign_in_brake
from ..services import attachments, cursor, devices, index, logs, looks, paths, rights, vault
from ..services.devices import Caller, PairingError
from ..services.vault import Actor, VaultError
from . import vault as vault_routes
from .attachments import FILE_POLICY

logger = logging.getLogger("nexlore.app")

router = APIRouter(prefix="/api/app/1", tags=["app"])

#: What this server offers the app; a word it does not know it skips, a missing one hides its button.
FEATURES = ["changes", "batch", "files", "wait", "base"]
#: How long ``/wait`` holds a request open.
WAIT_SECONDS = 25.0
#: How often ``/wait`` looks whether something was committed meanwhile; the database itself it asks every few seconds.
WAIT_STEP = 0.25
WAIT_DB_EVERY = 5.0
#: What one ``/fetch`` hands out at most, its texts together.
FETCH_BYTES = 20 * 1024 * 1024
FETCH_IDS = 200
BATCH_OPS = 100
#: How long the answer to an ``op_id`` is kept.
OP_DAYS = 7
MAX_TEXT = index.MAX_NOTE_BYTES
#: Path errors of the vault that the app knows as one: a path it may not use.
BAD_PATH = frozenset({"path_invalid", "name_invalid", "path_too_long", "not_a_note"})


def _token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def _refused(code: str, text: str, status: int, retry: int | None = None) -> Exception:
    exc = error(code, text, status)
    if retry is not None:
        exc.headers = {"Retry-After": str(retry)}
    return exc


def device(request: Request) -> Caller:
    with SessionLocal() as db:
        found = devices.authenticate(db, _token(request))
        if found is None:
            raise _refused("not_signed_in", "No valid device key.", 401)
        if not devices.allowed(db):
            raise _refused("app_disabled", "The operator has switched the app off.", 403)
    if not devices.brake(found.device_id):
        raise _refused("too_many", "Too many requests from this device. Wait a minute.", 429, 60)
    logs.set_actor(found.account.name)
    return found


Device = Annotated[Caller, Depends(device)]


def _not_scanning() -> None:
    """While the vault is read in for the first time the index is not whole: an empty list would tell the app that
    everything went."""
    if index.status.running and index.status.first:
        raise _refused("scan_running", "The vault is being read in. Try again in a moment.", 503, 10)


def _actor(found: Caller) -> Actor:
    return Actor(name=found.account.name, client=found.client, source=index.APP)


def _moment(mtime_ns: int) -> datetime:
    return datetime.fromtimestamp(mtime_ns / 1_000_000_000, tz=UTC)


# --- Pairing (no key, behind the sign-in brake) ------------------------------------------------------------------


class KeyIn(BaseModel):
    device: str = Field(default="", max_length=200)


class CodeIn(KeyIn):
    code: str = Field(max_length=20)


class PairedAccount(BaseModel):
    id: int
    name: str


class KeyOut(BaseModel):
    key: str
    account: PairedAccount


def _pickup(request: Request, take: Any) -> JSONResponse:
    """The brake counts per sender: there is no account to count at, and 40 bits of a short code hold only with it."""
    with SessionLocal() as db:
        if not devices.allowed(db):
            raise _refused("app_disabled", "The operator has switched the app off.", 403)
    key = "app-pairing:" + client_ip(request)
    wait = sign_in_brake.wait_seconds(key)
    if wait:
        raise _refused("too_many", "Too many attempts. Try again later.", 429, wait)
    with SessionLocal() as db:
        try:
            token, account, _row = take(db)
        except PairingError as exc:
            sign_in_brake.failed(key)
            raise error(exc.code, exc.text, exc.status) from exc
        out = KeyOut(key=token, account=PairedAccount(id=account.id, name=account.display_name or account.name))
    sign_in_brake.succeeded(key)
    # A key must not stay behind in any cache.
    return JSONResponse(content=out.model_dump(), headers={"Cache-Control": "no-store"})


@router.post("/pairing/{pairing_id}/key", response_model=KeyOut, summary="Pick the device key up with the QR code")
def pickup_by_secret(
    pairing_id: str,
    request: Request,
    body: KeyIn | None = None,
    secret: Annotated[str | None, Header(alias="X-Pairing-Secret", max_length=200)] = None,
) -> JSONResponse:
    """Unknown, wrong, expired and used answer the same (404 ``app_pairing_unknown``)."""
    return _pickup(request, lambda db: devices.by_secret(db, pairing_id, secret, body.device if body else ""))


@router.post("/pairing/code", response_model=KeyOut, summary="Pick the device key up with the short code")
def pickup_by_code(body: CodeIn, request: Request) -> JSONResponse:
    return _pickup(request, lambda db: devices.by_code(db, body.code, body.device))


# --- Who am I -----------------------------------------------------------------------------------------------------


class MeAccount(BaseModel):
    id: int
    name: str
    username: str
    operator: bool


class MeDevice(BaseModel):
    id: int
    name: str


class SpaceOut(BaseModel):
    id: int
    name: str
    #: ``read``, ``write`` or ``manage``.
    role: str
    #: ``#rrggbb`` or None.
    color: str | None = None
    #: A symbol's name (``l:<name>`` for one of Lucide) or None.
    icon: str | None = None
    #: The space's managers leave the attachment folders out of the folder listings (issue #17).
    hide_attachments: bool = False


class MeOut(BaseModel):
    version: str
    account: MeAccount
    device: MeDevice
    spaces: list[SpaceOut]
    features: list[str]
    #: What the operator calls the attachment folders, and how files put into them are named: ``pasted_name`` for a
    #: picture without a name of its own, ``uploaded_name`` for any other file (``services/attachments``). The app
    #: names its uploads itself, offline too, and follows these.
    attachment_folder: str = "Attachments"
    pasted_name: str = attachments.PASTED_DEFAULT
    uploaded_name: str = attachments.UPLOADED_DEFAULT


def _spaces(found: Caller) -> list[SpaceOut]:
    listed = vault_routes.spaces(found.account)
    with SessionLocal() as db:
        seen = looks.of_spaces(db, {space.id for space in listed})
    return [SpaceOut(id=space.id, name=space.name, role=space.role, color=seen.get(space.name, {}).get("", {}).get(
        "color"), icon=seen.get(space.name, {}).get("", {}).get("icon"), hide_attachments=space.hide_attachments)
        for space in listed]


@router.get("/me", response_model=MeOut, summary="The account, this device, the spaces it reads, what is offered")
def me(found: Device) -> MeOut:
    account = found.account
    return MeOut(
        version=__version__,
        account=MeAccount(id=account.id, name=account.display_name or account.name, username=account.name,
                          operator=account.role == OPERATOR),
        device=MeDevice(id=found.device_id, name=found.device_name),
        spaces=_spaces(found),
        features=FEATURES,
        attachment_folder=attachments.folder_name(),
        pasted_name=attachments.pasted_pattern(),
        uploaded_name=attachments.uploaded_pattern(),
    )


@router.delete("/device", status_code=204, summary="Disconnect this device")
def forget_device(found: Device) -> None:
    with SessionLocal() as db:
        devices.disconnect(db, found.account.id, found.device_id)


# --- Fetching -----------------------------------------------------------------------------------------------------


class ItemOut(BaseModel):
    id: int
    #: The space's name, the first part of ``path``.
    space: str
    path: str
    #: ``note`` or ``file``.
    kind: str
    hash: str
    size: int
    mtime: datetime
    #: In the trash, or gone from the disk.
    deleted: bool


class ChangesOut(BaseModel):
    cursor: int
    more: bool
    spaces: list[SpaceOut]
    items: list[ItemOut]


@router.get("/changes", response_model=ChangesOut, summary="What changed since a cursor; 0 is the whole vault")
def changes(
    found: Device,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
) -> ChangesOut:
    _not_scanning()
    spaces = _spaces(found)
    readable = readable_spaces(found.account)
    with SessionLocal() as db:
        # ``last`` first: everything numbered up to it is committed, so nothing below it can still come.
        last, oldest = cursor.state(db.connection())
        if since and (since < oldest or since > last):
            raise error("cursor_expired", "The cursor is older than what the server still knows.", 410)
        names = dict(db.execute(select(Space.id, Space.folder)).all())
        rows = db.execute(
            select(File.id, File.space_id, File.path, File.is_note, File.hash, File.size, File.mtime_ns,
                   File.deleted_at, File.cursor)
            .where(File.cursor > since, File.cursor <= last, File.space_id.in_(readable),
                   *([File.deleted_at.is_(None)] if since == 0 else []))
            .order_by(File.cursor).limit(limit + 1)
        ).all()
        found_items: list[tuple[int, ItemOut]] = [
            (row.cursor, ItemOut(id=row.id, space=names.get(row.space_id, paths.space_of(row.path)), path=row.path,
                                 kind="note" if row.is_note else "file", hash=row.hash, size=row.size,
                                 mtime=_moment(row.mtime_ns), deleted=row.deleted_at is not None))
            for row in rows
        ]
        if since:
            # Rows that went without the trash, told as deleted.
            for row in db.execute(
                select(GoneFile).where(GoneFile.cursor > since, GoneFile.cursor <= last,
                                       GoneFile.space_id.in_(readable)).order_by(GoneFile.cursor).limit(limit + 1)
            ).scalars():
                found_items.append((row.cursor, ItemOut(
                    id=row.file_id, space=names.get(row.space_id, paths.space_of(row.path)), path=row.path,
                    kind="note" if paths.is_note(row.path) else "file", hash="", size=0, mtime=row.gone_at,
                    deleted=True)))
    found_items.sort(key=lambda pair: pair[0])
    more = len(found_items) > limit
    page = found_items[:limit]
    # Of one id only the newest state, should a row and an entry of the gone ever meet on one page.
    newest: dict[int, int] = {}
    for position, (_number, item) in enumerate(page):
        newest[item.id] = position
    items = [item for position, (_number, item) in enumerate(page) if newest[item.id] == position]
    return ChangesOut(cursor=page[-1][0] if more else last, more=more, spaces=spaces, items=items)


class CursorOut(BaseModel):
    cursor: int


def _last() -> int:
    with SessionLocal() as db:
        return cursor.state(db.connection())[0]


@router.get("/wait", response_model=CursorOut, summary="Wait up to 25 s for the cursor to grow")
async def wait(found: Device, cursor_: Annotated[int, Query(alias="cursor", ge=0)]) -> CursorOut:
    _not_scanning()
    deadline = time.monotonic() + WAIT_SECONDS
    seen = cursor.moved
    asked = time.monotonic()
    current = await run_in_threadpool(_last)
    while current <= cursor_ and time.monotonic() < deadline:
        await asyncio.sleep(WAIT_STEP)
        if cursor.moved != seen or time.monotonic() - asked >= WAIT_DB_EVERY:
            seen = cursor.moved
            asked = time.monotonic()
            current = await run_in_threadpool(_last)
    return CursorOut(cursor=max(cursor_, current))


class FetchIn(BaseModel):
    ids: list[int] = Field(max_length=FETCH_IDS)


class NoteOut(BaseModel):
    id: int
    path: str
    hash: str
    text: str


class FetchOut(BaseModel):
    notes: list[NoteOut]
    #: Did not fit into this answer: ask again.
    missing: list[int]


def _remember(device_id: int, bases: list[tuple[int, str, bytes]]) -> None:
    """The device's base of each note: the newest it got or wrote, one per note."""
    if not bases:
        return
    now = utcnow()
    with SessionLocal() as db:
        for file_id, hashed, data in bases:
            statement = sqlite_insert(DeviceBase).values(device_id=device_id, file_id=file_id, hash=hashed,
                                                         content=zlib.compress(data, 6), updated_at=now)
            db.execute(statement.on_conflict_do_update(
                index_elements=[DeviceBase.device_id, DeviceBase.file_id],
                set_={"hash": statement.excluded.hash, "content": statement.excluded.content,
                      "updated_at": statement.excluded.updated_at},
            ))
        db.commit()


@router.post("/fetch", response_model=FetchOut, summary="The texts of notes, up to 200 and 20 MB at a time")
def fetch(body: FetchIn, found: Device) -> FetchOut:
    """An id that is no note, is in the trash or may not be read is in neither list: it does not exist."""
    _not_scanning()
    readable = readable_spaces(found.account)
    wanted = list(dict.fromkeys(body.ids))
    with SessionLocal() as db:
        rows = {row.id: row for row in db.execute(
            select(File.id, File.path, File.space_id, File.size, File.is_note, File.deleted_at)
            .where(File.id.in_(wanted))
        )}
    notes: list[NoteOut] = []
    missing: list[int] = []
    bases: list[tuple[int, str, bytes]] = []
    total = 0
    for file_id in wanted:
        row = rows.get(file_id)
        if row is None or row.deleted_at is not None or not row.is_note or row.space_id not in readable:
            continue
        if notes and total + row.size > FETCH_BYTES:
            missing.append(file_id)
            continue
        try:
            data = paths.vault_root().joinpath(*row.path.split("/")).read_bytes()
        except OSError:
            continue
        if notes and total + len(data) > FETCH_BYTES:
            missing.append(file_id)
            continue
        hashed = index.digest(data)
        notes.append(NoteOut(id=file_id, path=row.path, hash=hashed, text=data.decode("utf-8", errors="replace")))
        bases.append((file_id, hashed, data))
        total += len(data)
    _remember(found.device_id, bases)
    return FetchOut(notes=notes, missing=missing)


def _readable_row(found: Caller, file_id: int, *, trashed: bool = False) -> File:
    with SessionLocal() as db:
        row = db.get(File, file_id)
        if row is None or (row.deleted_at is not None and not trashed) or not rights.at_least(
            rights.role_in(db, found.account, row.space_id), READ
        ):
            raise error("not_found", "Not found.", 404)
        db.expunge(row)
    return row


@router.get("/files/{file_id}", response_model=None, summary="A file as it is on disk; ETag is its hash, Range works",
            responses={200: {"content": {"application/octet-stream": {}}}})
def file(file_id: int, request: Request, found: Device) -> Response:
    _not_scanning()
    row = _readable_row(found, file_id)
    try:
        full = paths.resolve(row.path)
    except paths.PathError as exc:
        raise error("not_found", "Not found.", 404) from exc
    if not full.is_file():
        raise error("not_found", "Not found.", 404)
    tag = f'"{row.hash}"'
    headers = {"ETag": tag, "Cache-Control": "private, no-cache", "Content-Security-Policy": FILE_POLICY}
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers=headers)
    media_type = mimetypes.guess_type(full.name)[0] or "application/octet-stream"
    return FileResponse(full, media_type=media_type, headers=headers, filename=full.name,
                        content_disposition_type="attachment")


class BaseOut(BaseModel):
    hash: str
    text: str


@router.get("/notes/{file_id}/base", response_model=BaseOut,
            summary="A note's state with this hash: this device's base first, else from the versions")
def base(file_id: int, found: Device, hash_: Annotated[str, Query(alias="hash", pattern=r"^[0-9a-f]{64}$")]) -> BaseOut:
    _not_scanning()
    _readable_row(found, file_id, trashed=True)
    with SessionLocal() as db:
        content = db.scalar(select(DeviceBase.content).where(
            DeviceBase.device_id == found.device_id, DeviceBase.file_id == file_id, DeviceBase.hash == hash_))
        if content is None:
            content = db.scalar(select(Version.content).where(Version.file_id == file_id, Version.hash == hash_)
                                .order_by(Version.updated_at.desc(), Version.id.desc()).limit(1))
    if content is None:
        raise error("not_found", "Not found.", 404)
    return BaseOut(hash=hash_, text=zlib.decompress(content).decode("utf-8", errors="replace"))


# --- Sending ------------------------------------------------------------------------------------------------------

OpId = Annotated[str, Field(min_length=1, max_length=64)]
Hash = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
PathField = Annotated[str, Field(min_length=1, max_length=paths.MAX_PATH_CHARS)]


class CreateOp(BaseModel):
    type: Literal["create"]
    op_id: OpId
    space: str = Field(min_length=1, max_length=255)
    path: PathField
    text: str


class UpdateOp(BaseModel):
    type: Literal["update"]
    op_id: OpId
    id: int
    base_hash: Hash
    text: str


class MoveOp(BaseModel):
    type: Literal["move"]
    op_id: OpId
    id: int
    path: PathField


class DeleteOp(BaseModel):
    type: Literal["delete"]
    op_id: OpId
    id: int
    base_hash: Hash


class RestoreOp(BaseModel):
    type: Literal["restore"]
    op_id: OpId
    id: int


Op = Annotated[CreateOp | UpdateOp | MoveOp | DeleteOp | RestoreOp, Field(discriminator="type")]


class BatchIn(BaseModel):
    ops: list[Op] = Field(max_length=BATCH_OPS)


class ResultOut(BaseModel):
    op_id: str
    ok: bool
    #: Why it failed: ``exists``, ``stale``, ``in_trash``, ``forbidden``, ``too_large``, ``bad_path``,
    #: ``across_spaces``, ``not_found`` or ``skipped`` (an earlier operation on the same id failed).
    code: str | None = None
    id: int | None = None
    path: str | None = None
    hash: str | None = None
    #: ``move``: the notes whose links into the moved note were rewritten.
    touched: list[int] | None = None


class BatchOut(BaseModel):
    results: list[ResultOut]
    cursor: int


class OpFailed(Exception):
    def __init__(self, code: str, **values: Any) -> None:
        super().__init__(code)
        self.code = code
        self.values = values


def _from_vault(exc: VaultError) -> OpFailed:
    if exc.code in BAD_PATH:
        return OpFailed("bad_path")
    if exc.code == "move_across_spaces":
        return OpFailed("across_spaces")
    if exc.code == "quota_exceeded":
        # The account's space is full: for the app the file is too large to take.
        return OpFailed("too_large")
    return OpFailed(exc.code, **{key: value for key, value in exc.values.items() if key in ("id", "hash", "path")})


def _row_for(found: Caller, file_id: int, need: str) -> File:
    """The row behind an id with the right ``need`` in its space; in the trash too."""
    with SessionLocal() as db:
        row = db.get(File, file_id)
        role = rights.role_in(db, found.account, row.space_id) if row is not None else None
        if row is None or not rights.at_least(role, READ):
            raise OpFailed("not_found")
        if not rights.at_least(role, need):
            raise OpFailed("forbidden")
        db.expunge(row)
    return row


def _text(text: str) -> bytes:
    data = text.encode("utf-8")
    if len(data) > MAX_TEXT:
        raise OpFailed("too_large")
    return data


def _create(found: Caller, op: CreateOp) -> dict[str, Any]:
    try:
        rel = paths.parse(op.path)
    except paths.PathError as exc:
        raise OpFailed("bad_path") from exc
    if "/" not in rel or paths.space_of(rel) != op.space or not paths.is_note(rel):
        raise OpFailed("bad_path")
    with SessionLocal() as db:
        try:
            rights.check(db, found.account, rel, WRITE)
        except rights.RightsError as exc:
            raise OpFailed(exc.code) from exc
    data = _text(op.text)
    try:
        made = vault.create_at(rel, data, actor=_actor(found), source=index.APP)
    except VaultError as exc:
        if exc.code == "exists" and exc.values.get("id") is not None and exc.values.get("hash") == index.digest(data):
            # The same note made twice (an answer lost on the way): that is a success.
            row = _row_for(found, int(exc.values["id"]), READ)
            _remember(found.device_id, [(row.id, row.hash, data)])
            return {"id": row.id, "path": row.path, "hash": row.hash}
        raise _from_vault(exc) from exc
    _remember(found.device_id, [(made.id, made.hash, data)])
    return {"id": made.id, "path": made.path, "hash": made.hash}


def _update(found: Caller, op: UpdateOp) -> dict[str, Any]:
    row = _row_for(found, op.id, WRITE)
    if row.deleted_at is not None:
        raise OpFailed("in_trash")
    if not paths.is_note(row.path) and not paths.is_canvas(row.path):
        raise OpFailed("forbidden")
    data = _text(op.text)
    try:
        saved = vault.save(row.path, data, base_hash=op.base_hash, actor=_actor(found), source=index.APP,
                           strict=True)
    except VaultError as exc:
        raise _from_vault(exc) from exc
    _remember(found.device_id, [(row.id, saved.file.hash, data)])
    return {"hash": saved.file.hash}


def _move(found: Caller, op: MoveOp) -> dict[str, Any]:
    row = _row_for(found, op.id, WRITE)
    if row.deleted_at is not None:
        raise OpFailed("in_trash")
    try:
        destination = paths.parse(op.path)
    except paths.PathError as exc:
        raise OpFailed("bad_path") from exc
    if "/" not in destination:
        raise OpFailed("bad_path")
    if paths.space_of(destination) != paths.space_of(row.path):
        raise OpFailed("across_spaces")
    if destination == row.path:
        return {"path": row.path, "touched": []}
    try:
        moved = vault.move(row.path, destination, actor=_actor(found), ignore_locks=True)
    except VaultError as exc:
        raise _from_vault(exc) from exc
    readable = readable_spaces(found.account)
    # Other notes only, and only those it may read: a note elsewhere is none of its business.
    touched = [note_id for note_id, space_id in zip(moved.rewritten_ids, moved.rewritten_spaces, strict=True)
               if space_id in readable and note_id != row.id]
    return {"path": moved.path, "touched": list(dict.fromkeys(touched))}


def _delete(found: Caller, op: DeleteOp) -> dict[str, Any]:
    row = _row_for(found, op.id, WRITE)
    if row.deleted_at is not None:
        return {}
    try:
        vault.delete_path(row.path, actor=_actor(found), ignore_locks=True, base_hash=op.base_hash)
    except VaultError as exc:
        raise _from_vault(exc) from exc
    return {}


def _restore(found: Caller, op: RestoreOp) -> dict[str, Any]:
    row = _row_for(found, op.id, WRITE)
    if row.deleted_at is None:
        return {"path": row.path}
    try:
        restored = vault.restore_trash(f"f-{row.id}", actor=_actor(found))
    except VaultError as exc:
        raise _from_vault(exc) from exc
    if not restored:
        raise OpFailed("not_found")
    return {"path": restored[0]}


RUN = {"create": _create, "update": _update, "move": _move, "delete": _delete, "restore": _restore}


def _stored(device_id: int, op_id: str) -> dict[str, Any] | None:
    with SessionLocal() as db:
        return db.scalar(select(AppOp.result).where(AppOp.device_id == device_id, AppOp.op_id == op_id))


def _store(device_id: int, result: dict[str, Any]) -> None:
    with SessionLocal() as db:
        db.execute(sqlite_insert(AppOp).values(device_id=device_id, op_id=result["op_id"], result=result,
                                               created_at=utcnow()).on_conflict_do_nothing())
        db.commit()


class _OneAtATime:
    """The same ``op_id`` twice at once (the app retries after a timeout while the first request still runs): the
    second waits for the first and then finds its answer. One process serves nexlore (``index.guard`` too). Entered
    in one thread and left in another is fine: it is a plain lock."""

    #: The ``op_id``s running right now, each with its lock and how many requests hold or wait for it.
    running: ClassVar[dict[tuple[int, str], list[Any]]] = {}
    guard: ClassVar[threading.Lock] = threading.Lock()

    def __init__(self, device_id: int, op_id: str) -> None:
        self.key = (device_id, op_id)

    def __enter__(self) -> None:
        with self.guard:
            self.entry = self.running.setdefault(self.key, [threading.Lock(), 0])
            self.entry[1] += 1
        self.entry[0].acquire()

    def __exit__(self, *_exc: object) -> None:
        self.entry[0].release()
        with self.guard:
            self.entry[1] -= 1
            if not self.entry[1]:
                del self.running[self.key]


def _forget_old_ops() -> None:
    with SessionLocal() as db:
        db.execute(delete(AppOp).where(AppOp.created_at < utcnow() - timedelta(days=OP_DAYS)))
        db.commit()


def _run(found: Caller, op: Any) -> dict[str, Any]:
    try:
        done = RUN[op.type](found, op)
    except OpFailed as exc:
        return {"op_id": op.op_id, "ok": False, "code": exc.code, **exc.values}
    return {"op_id": op.op_id, "ok": True, **done}


@router.post("/batch", response_model=BatchOut, response_model_exclude_none=True,
             summary="Changes from the app, in order; each answered on its own")
def batch(body: BatchIn, found: Device) -> BatchOut:
    """A failed operation holds up only later ones on the same id (``skipped``), so that each note keeps its order.
    The same ``op_id`` again gets the answer it got, and nothing happens twice; a skipped one decided nothing and is
    not kept."""
    _not_scanning()
    _forget_old_ops()
    failed: set[int] = set()
    results: list[dict[str, Any]] = []
    for op in body.ops:
        target = getattr(op, "id", None)
        with _OneAtATime(found.device_id, op.op_id):
            result = _stored(found.device_id, op.op_id)
            if result is None:
                if target is not None and target in failed:
                    result = {"op_id": op.op_id, "ok": False, "code": "skipped"}
                else:
                    result = _run(found, op)
                    _store(found.device_id, result)
        if not result["ok"] and target is not None:
            failed.add(target)
        results.append(result)
    logger.info("App batch device_id=%s ops=%s failed=%s", found.device_id, len(results),
                sum(1 for result in results if not result["ok"]))
    return BatchOut(results=[ResultOut(**result) for result in results], cursor=_last())


@router.post("/files", response_model=ResultOut, response_model_exclude_none=True,
             summary="Upload a file; answered like a create")
async def upload(
    found: Device,
    space: Annotated[str, Form(min_length=1, max_length=255)],
    path: Annotated[str, Form(min_length=1, max_length=paths.MAX_PATH_CHARS)],
    op_id: Annotated[str, Form(min_length=1, max_length=64)],
    file: UploadFile,
) -> ResultOut:
    """The same file in the space already: its id, nothing stored twice. A name taken by another file: the upload
    gets the next free name beside it, both stay (attachments are never merged)."""
    _not_scanning()
    running = _OneAtATime(found.device_id, op_id)
    # Waiting for the same upload still running takes a thread, not the event loop.
    await run_in_threadpool(running.__enter__)
    try:
        stored = await run_in_threadpool(_stored, found.device_id, op_id)
        if stored is not None:
            return ResultOut(**stored)
        try:
            result = {"op_id": op_id, "ok": True, **await _upload(found, space, path, file)}
        except OpFailed as exc:
            result = {"op_id": op_id, "ok": False, "code": exc.code, **exc.values}
        await run_in_threadpool(_store, found.device_id, result)
        return ResultOut(**result)
    finally:
        running.__exit__(None, None, None)


async def _upload(found: Caller, space: str, path: str, file: UploadFile) -> dict[str, Any]:
    try:
        rel = paths.parse(path)
    except paths.PathError as exc:
        raise OpFailed("bad_path") from exc
    if rel.count("/") < 1 or paths.space_of(rel) != space:
        raise OpFailed("bad_path")
    folder, name = posixpath.split(rel)

    def plan() -> attachments.Plan:
        with SessionLocal() as db:
            try:
                rights.check(db, found.account, rel, WRITE)
            except rights.RightsError as exc:
                raise OpFailed(exc.code) from exc
        try:
            if "/" in folder:
                parent = space
                for part in folder.split("/")[1:]:
                    parent = vault.create_folder(parent, part, existing_ok=True)
            return attachments.plan(note=None, folder=folder, name=name, pasted=False, actor=_actor(found))
        except VaultError as exc:
            raise _from_vault(exc) from exc

    upload_plan = await run_in_threadpool(plan)
    received = attachments.temporary(upload_plan)
    size = 0
    try:
        async with await anyio.open_file(received, "wb") as handle:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                attachments.check_size(upload_plan, size)
                await handle.write(chunk)
            await handle.flush()
            await anyio.to_thread.run_sync(os.fsync, handle.wrapped.fileno())
        if not size:
            raise OpFailed("empty")
        stored = await run_in_threadpool(attachments.finish, upload_plan, received, size, _actor(found))
    except VaultError as exc:
        raise _from_vault(exc) from exc
    finally:
        received.unlink(missing_ok=True)
    kept = stored.original or stored.path
    with SessionLocal() as db:
        row = db.scalar(select(File).where(File.path == kept, File.deleted_at.is_(None)))
        if row is None:
            raise OpFailed("not_found")
        return {"id": row.id, "path": row.path, "hash": row.hash}


#: Every address of the promise. A new one is added here; none is ever taken away (``/api/app/2`` instead).
PROMISED = (
    "/api/app/1/batch",
    "/api/app/1/changes",
    "/api/app/1/device",
    "/api/app/1/fetch",
    "/api/app/1/files",
    "/api/app/1/files/{file_id}",
    "/api/app/1/me",
    "/api/app/1/notes/{file_id}/base",
    "/api/app/1/pairing/code",
    "/api/app/1/pairing/{pairing_id}/key",
    "/api/app/1/wait",
)
