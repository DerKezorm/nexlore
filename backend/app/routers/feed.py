"""The calendar subscription of the own account (``services/feed``), and files as a ZIP: a space, or chosen ones."""

from __future__ import annotations

import tempfile
import zipfile
from collections.abc import Iterator
from datetime import datetime
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Path, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need
from ..errors import error
from ..models import MANAGE, READ, File, Space
from ..models import Account as AccountRow
from ..services import feed, paths, rights, settings_service

router = APIRouter(prefix="/api", tags=["feed"])

FEED_PATH = "/api/calendar/feed/"
#: A space bigger than this on disk is not packed in one go.
ZIP_LIMIT = 2 * 1024 * 1024 * 1024


@router.get("/me/calendar-feed", summary="Whether the calendar subscription is open, and the account has an address")
def feed_state(account: Account) -> dict[str, bool]:
    with SessionLocal() as db:
        allowed = feed.allowed(db)
        row = db.get(AccountRow, account.id)
        active = bool(row and row.calendar_feed_hash)
    return {"allowed": allowed, "active": active}


@router.post("/me/calendar-feed", summary="A new address for the calendar subscription; the one before stops")
def feed_make(account: Account) -> dict[str, str]:
    with SessionLocal() as db:
        if not feed.allowed(db):
            raise error("calendar_feed_closed", "The operator has not opened the calendar subscription.", 403)
        row = db.get(AccountRow, account.id)
        token = feed.make(db, row)
    return {"path": FEED_PATH + token + ".ics"}


@router.delete("/me/calendar-feed", status_code=204, summary="Stop the calendar subscription of the own account")
def feed_stop(account: Account) -> None:
    with SessionLocal() as db:
        row = db.get(AccountRow, account.id)
        feed.stop(db, row)


@router.get("/calendar/feed/{name}", include_in_schema=False)
def feed_file(name: Annotated[str, Path(max_length=120)], request: Request) -> Response:
    """The feed itself, for a calendar app: no session, the key in the address."""
    token = name.removesuffix(".ics")
    with SessionLocal() as db:
        account = feed.owner(db, token)
        if account is None:
            raise error("not_found", "Not found.", 404)
        base = settings_service.get(db, "public_url") or str(request.base_url).rstrip("/")
        text = feed.calendar(db, account, today=datetime.now().astimezone().date(), base_url=base, name="nexlore")
    return Response(
        content=text,
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "no-store", "Content-Disposition": 'inline; filename="nexlore.ics"'},
    )


@router.get("/spaces/{name}/zip", summary="Every note and file of a space the index knows, as one ZIP file")
def space_zip(name: Annotated[str, Path(max_length=255)], account: Account) -> StreamingResponse:
    space = need(account, name, READ)
    if "/" in space:
        raise error("not_found", "Not found.", 404)
    with SessionLocal() as db:
        space_id = db.scalar(select(Space.id).where(Space.folder == space))
        if space_id is None:
            raise error("not_found", "Not found.", 404)
        rows = db.execute(
            select(File.path, File.size).where(File.space_id == space_id, File.deleted_at.is_(None)).order_by(File.path)
        ).all()
        manages = rights.at_least(rights.role_in(db, account, space_id), MANAGE)
    files = [(rel, rel) for rel, _ in rows]
    size = sum(size or 0 for _, size in rows)
    if manages:
        # Obsidian's settings, themes, snippets and plugins, so the way back to Obsidian keeps them. Only for those
        # who manage the space: a plugin's settings may hold its own keys.
        for rel, extra in _obsidian_folder(space):
            files.append((rel, rel))
            size += extra
    if size > ZIP_LIMIT:
        raise error("too_large", "The space is too large to pack in one go; take a backup instead.", 413)
    stamp = datetime.now().astimezone().strftime("%Y-%m-%d")
    return _packed(files, f"{space}-{stamp}.zip")


def _obsidian_folder(space: str) -> list[tuple[str, int]]:
    """Every file under the space's ``.obsidian/`` (vault path, size); links are not followed."""
    folder = paths.vault_root() / space / ".obsidian"
    if not folder.is_dir() or folder.is_symlink():
        return []
    found = []
    for item in sorted(folder.rglob("*")):
        if item.is_file() and not item.is_symlink() and item.resolve().is_relative_to(folder.resolve()):
            found.append((f"{space}/{item.relative_to(folder.parent).as_posix()}", item.stat().st_size))
    return found


def _packed(files: list[tuple[str, str]], filename: str) -> StreamingResponse:
    """The files (vault path, name in the archive) as one ZIP, packed first (on disk once it grows), then sent: a file
    gone meanwhile is left out, not a broken archive."""
    buffer = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)  # noqa: SIM115 (closed by chunks())
    root = paths.vault_root()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for rel, name in files:
            try:
                data = root.joinpath(*rel.split("/")).read_bytes()
            except OSError:
                continue
            archive.writestr(name, data)
    buffer.seek(0)

    def chunks() -> Iterator[bytes]:
        with buffer:
            while data := buffer.read(1024 * 1024):
                yield data

    return StreamingResponse(
        chunks(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


FilePath = Annotated[str, Field(min_length=1, max_length=paths.MAX_PATH_CHARS)]


class FilesIn(BaseModel):
    paths: list[FilePath] = Field(min_length=1, max_length=200)
    #: The archive's name, without ``.zip``.
    name: str = Field(default="files", max_length=100)


@router.post("/files/zip", summary="Chosen files (the pictures of a note, say) as one ZIP file")
def files_zip(body: FilesIn, account: Account) -> StreamingResponse:
    """Every file must be one the account may read and the index knows; in the archive each goes by its name alone,
    a second of the same name numbered (``photo (2).png``)."""
    chosen: list[tuple[str, str]] = []
    taken: set[str] = set()
    total = 0
    with SessionLocal() as db:
        for raw in dict.fromkeys(body.paths):
            clean = need(account, raw, READ)
            row = db.execute(select(File.path, File.size).where(File.path == clean, File.deleted_at.is_(None))).first()
            if row is None:
                raise error("not_found", "No such file.", 404)
            total += row.size or 0
            name = row.path.rsplit("/", 1)[-1]
            stem, dot, ext = name.rpartition(".")
            if not dot:
                stem, ext = name, ""
            count = 1
            while name.casefold() in taken:
                count += 1
                name = f"{stem} ({count}).{ext}" if ext else f"{stem} ({count})"
            taken.add(name.casefold())
            chosen.append((row.path, name))
    if total > ZIP_LIMIT:
        raise error("too_large", "These files are too large to pack in one go.", 413)
    safe = "".join(char for char in body.name if char.isalnum() or char in " -_").strip() or "files"
    return _packed(chosen, f"{safe}.zip")
