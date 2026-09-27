"""Attachments over HTTP: uploading, handing files out, the list on the files page, the limits.

**Handing out** is where a file from anybody meets the browser of somebody else. So a file is only ever shown in the
page when it is a kind that cannot run anything, and its content says so (a ``.png`` holding HTML is a download).
SVG, HTML and PDF are always downloads, and every answer carries a policy that forbids scripts and plugins even if
a browser were to show it. ``?download=1`` makes anything a download.
"""

from __future__ import annotations

import os
from dataclasses import asdict
from pathlib import PurePosixPath
from typing import Annotated, Any
from urllib.parse import unquote

import anyio
from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from starlette.requests import ClientDisconnect

from ..db import SessionLocal
from ..deps import Account, OperatorAccount, need
from ..errors import error
from ..models import READ, WRITE, File, Link, Space
from ..services import attachments, media, paths, settings_service
from ..services.vault import VaultError
from .vault import ActorDep, PathQuery, _fail

router = APIRouter(prefix="/api", tags=["attachments"])

#: What may show in the page, by the kind its content has. Everything else is a download.
SHOWN = {
    "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif",
    "bmp": "image/bmp", "heic": "image/heic", "mp4": "video/mp4", "mov": "video/quicktime",
}
#: Sound and text have no magic to read; by their ending, and text only ever as plain text.
SHOWN_BY_ENDING = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
    ".wav": "audio/wav", ".flac": "audio/flac", ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
    ".json": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
}
#: Downloads with their true type, so the browser and the system know what they are.
DOWNLOAD_TYPES = {".pdf": "application/pdf", ".svg": "image/svg+xml", ".zip": "application/zip"}
#: No script, no plugin, no form, no frame, whatever the browser decides to do with the answer.
FILE_POLICY = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"


class UploadOut(BaseModel):
    path: str
    size: int
    kind: str | None
    duplicate: bool
    removed: list[str]
    original: str | None
    link: str


@router.post("/attachments", response_model=UploadOut, status_code=201)
async def upload(
    request: Request,
    account: Account,
    who: ActorDep,
    name: Annotated[str, Query(min_length=1, max_length=255)],
    note: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None,
    folder: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None,
    pasted: bool = False,
) -> UploadOut:
    """The body is the file itself, streamed; ``name`` its name, ``note`` the note it is for (it lands in that note's
    attachment folder) or ``folder`` where it goes. Duplicates are found within the space only, where the uploader
    may read anyway."""
    if note is None and folder is None:
        raise error("invalid_input", "Name a note or a folder.", 422)
    need(account, note if note is not None else folder or "", WRITE)
    try:
        plan = await run_in_threadpool(
            attachments.plan, note=note, folder=folder, name=name, pasted=pasted, actor=who
        )
        declared = request.headers.get("content-length", "")
        if declared.isdigit():
            attachments.check_size(plan, int(declared))
    except VaultError as exc:
        raise _fail(exc) from exc
    created = not plan.directory.exists()
    received = attachments.temporary(plan)
    size = 0
    try:
        async with await anyio.open_file(received, "wb") as handle:
            async for chunk in request.stream():
                size += len(chunk)
                attachments.check_size(plan, size)
                await handle.write(chunk)
            await handle.flush()
            await anyio.to_thread.run_sync(os.fsync, handle.wrapped.fileno())
        if not size:
            raise VaultError("empty", "the file is empty")
        result = await run_in_threadpool(attachments.finish, plan, received, size, who)
    except VaultError as exc:
        raise _fail(exc) from exc
    except ClientDisconnect as exc:
        raise error("upload_aborted", "The upload stopped before the end.") from exc
    finally:
        received.unlink(missing_ok=True)
        if created:
            try:
                plan.directory.rmdir()  # only when nothing landed in it
            except OSError:
                pass
    return UploadOut(**asdict(result))


def _delivery(full: Any, kind: str | None, download: bool) -> tuple[str, bool]:
    """(media type, shown in the page)."""
    ending = PurePosixPath(full.name).suffix.lower()
    if not download and kind in SHOWN and (kind != "heic" or ending in (".heic", ".heif")):
        return SHOWN[kind], True
    if not download and kind is None and ending in SHOWN_BY_ENDING:
        return SHOWN_BY_ENDING[ending], True
    return DOWNLOAD_TYPES.get(ending, "application/octet-stream"), False


@router.get("/file", response_model=None)
def file(path: PathQuery, request: Request, account: Account, download: bool = False) -> Response:
    """A file of the vault as it is on disk. Only files the index knows: nothing hidden, nothing half-written."""
    need(account, path, READ)
    try:
        clean = paths.parse(path)
        full = paths.resolve(clean)
    except paths.PathError as exc:
        raise error(exc.code, str(exc)) from exc
    with SessionLocal() as db:
        known = db.scalar(select(File.id).where(File.path == clean, File.deleted_at.is_(None)))
    if known is None or not full.is_file():
        raise error("not_found", "No such file.", 404)
    stat = full.stat()
    tag = f'"{stat.st_size:x}-{stat.st_mtime_ns:x}"'
    headers = {"ETag": tag, "Cache-Control": "private, no-cache", "Content-Security-Policy": FILE_POLICY}
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers=headers)
    with open(full, "rb") as handle:
        kind = media.sniff(handle.read(64))
    media_type, shown = _delivery(full, kind, download)
    return FileResponse(
        full, media_type=media_type, headers=headers, filename=full.name,
        content_disposition_type="inline" if shown else "attachment", stat_result=stat,
    )


class AttachmentOut(BaseModel):
    id: int
    path: str
    size: int
    modified: int
    owner: str | None
    #: How many notes link it.
    uses: int


class AttachmentsOut(BaseModel):
    total: int
    items: list[AttachmentOut]


@router.get("/attachments", response_model=AttachmentsOut)
def listing(
    account: Account,
    space: Annotated[str, Query(min_length=1, max_length=255)],
    unused: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AttachmentsOut:
    """The files in a space that are not notes, with how many notes link each; ``unused``: only those none links."""
    if "/" in space:
        raise error("not_found", "No such space.", 404)
    need(account, space, READ)
    with SessionLocal() as db:
        if db.scalar(select(Space.id).where(Space.folder == space)) is None:
            raise error("not_found", "No such space.", 404)
        uses = (
            select(Link.target_id, func.count(func.distinct(Link.source_id)).label("uses"))
            .join(File, File.id == Link.source_id)
            .where(File.deleted_at.is_(None), Link.target_id.is_not(None))
            .group_by(Link.target_id)
            .subquery()
        )
        count = func.coalesce(uses.c.uses, 0)
        query = (
            select(File, count)
            .outerjoin(uses, uses.c.target_id == File.id)
            # Below the space by the path index ("/" sorts right before "0").
            .where(File.deleted_at.is_(None), File.is_note.is_(False), File.path > space + "/", File.path < space + "0")
        )
        if unused:
            query = query.where(count == 0)
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = db.execute(query.order_by(File.path).limit(limit).offset(offset)).all()
    return AttachmentsOut(
        total=total,
        items=[
            AttachmentOut(id=row.id, path=row.path, size=row.size, modified=row.mtime_ns // 1_000_000, owner=row.owner,
                          uses=int(used))
            for row, used in rows
        ],
    )


class UsageOut(BaseModel):
    used: int
    #: 0: no limit.
    quota: int
    per_file: int
    folder: str
    strip_location: bool


@router.get("/attachments/usage", response_model=UsageOut)
def usage(who: ActorDep) -> UsageOut:
    """What the signed-in account may upload and has uploaded."""
    limits = attachments.limits(who.name)
    with SessionLocal() as db:
        strip = bool(settings_service.get(db, "strip_location"))
    return UsageOut(used=limits.used, quota=limits.quota, per_file=limits.per_file, folder=attachments.folder_name(),
                    strip_location=strip)


class FileSettings(BaseModel):
    attachment_folder: str = Field(min_length=1, max_length=255)
    upload_max_mb: int = Field(ge=1, le=1024 * 1024)
    quota_mb: int = Field(ge=0, le=1024 * 1024 * 1024)
    strip_location: bool


@router.get("/settings/files", response_model=FileSettings)
def file_settings(_operator: OperatorAccount) -> FileSettings:
    with SessionLocal() as db:
        values = settings_service.get_all(db)
    return FileSettings(**{key: values[key] for key in FileSettings.model_fields})


@router.put("/settings/files", response_model=FileSettings)
def save_file_settings(body: FileSettings, _operator: OperatorAccount) -> FileSettings:
    try:
        folder_name = paths.check_name(body.attachment_folder.strip())
    except paths.PathError as exc:
        raise error(exc.code, str(exc)) from exc
    values = body.model_dump() | {"attachment_folder": folder_name}
    with SessionLocal() as db:
        settings_service.save(db, values)
    return FileSettings(**values)


class ResolveOut(BaseModel):
    path: str | None
    is_note: bool = False


@router.get("/resolve", response_model=ResolveOut)
def resolve(
    account: Account,
    source: PathQuery,
    target: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
    kind: Annotated[str, Query(pattern="^(wiki|embed|md|md_embed)$")] = "embed",
) -> ResolveOut:
    """Where a link written in ``source`` leads, the way the index resolves it (an embed typed but not saved yet)."""
    from ..services import index

    clean = need(account, source, READ)
    with SessionLocal() as db:
        space_id = db.scalar(select(File.space_id).where(File.path == clean, File.deleted_at.is_(None)))
        if space_id is None:
            raise error("not_found", "No such note.", 404)
        names = index.Names(db, space_id, preload=False)
        # A Markdown link is written escaped (``Anh%C3%A4nge/Foto%201.png``); the index keeps it decoded.
        found = index.resolve(kind, unquote(target) if kind.startswith("md") else target, clean, names)
        row = db.get(File, found) if found is not None else None
    return ResolveOut(path=row.path, is_note=row.is_note) if row is not None else ResolveOut(path=None)

