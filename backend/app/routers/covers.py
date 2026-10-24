"""The cover flow: one level of the vault as cards (``GET /api/coverflow``), and the cover pictures of spaces and
folders (``services/covers``): read with the right to read, set and removed with the right to write. A space or
folder one may not read answers like one that does not exist, its cover too.

The top level (no path) is the spaces one may read; below, a folder's subfolders and its notes. A note's card carries
a little of its text (from the search index, no file is read), its first tags and the first picture it embeds.
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, select, text

from ..db import SessionLocal, sort_key
from ..deps import Account, need
from ..errors import error
from ..models import FTS_TABLE, READ, WRITE, File, Link, Space, Tag
from ..services import covers, looks, mdparse, paths, rights, snippets
from ..services.vault import atomic_write

logger = logging.getLogger("nexlore.vault")
router = APIRouter(prefix="/api", tags=["coverflow"])

#: Notes on one level: a folder of tens of thousands is no shelf to flip through; the answer says how many there were.
MAX_NOTES = 1000
#: How much of a note's text its card shows (characters, cut at a word).
EXCERPT = 320
#: Pictures a browser shows, by ending: what may stand on a note's card.
PICTURE_ENDINGS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp")
_EMBEDS = re.compile(r"!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)")
_COMMENT = re.compile(r"%%.*?%%|<!--.*?-->", re.DOTALL)
_FENCE = re.compile(r"^[ \t]*(```|~~~).*$", re.MULTILINE)


def _excerpt(body: str, title: str) -> str:
    """A little of a note's text as words: no pictures, no comments, no marks of Markdown, not its own title."""
    words = snippets.plain(_FENCE.sub(" ", _COMMENT.sub(" ", _EMBEDS.sub(" ", body))))
    words = snippets.without_title(words, title).strip()
    if len(words) <= EXCERPT:
        return words
    cut = words[:EXCERPT]
    space = cut.rfind(" ")
    return (cut[:space] if space > EXCERPT // 2 else cut).rstrip(" ,;:.-") + "…"


def _subfolders(full) -> int:
    try:
        return sum(
            1 for entry in full.iterdir()
            if not paths.is_hidden(entry.name) and not entry.is_symlink() and entry.is_dir()
        )
    except OSError:
        return 0


def _folder_card(full, rel: str, name: str, notes: int, look: dict[str, Any] | None, writable: bool,
                 space: bool = False) -> dict[str, Any]:
    return {
        "kind": "folder",
        "name": name,
        "path": rel,
        "space": space,
        "folders": _subfolders(full),
        "notes": notes,
        "cover": covers.version(full),
        "icon": (look or {}).get("icon"),
        "color": (look or {}).get("color"),
        "writable": writable,
    }


def _spaces_level(account) -> dict[str, Any]:
    root = paths.vault_root()
    with SessionLocal() as db:
        readable = rights.readable_ids(db, account)
        roles = {space_id: rights.role_in(db, account, space_id) for space_id in readable}
        # Notes lying directly in a space: one slash in the path.
        direct = dict(
            db.execute(
                select(File.space_id, func.count())
                .where(File.deleted_at.is_(None), File.is_note.is_(True), File.space_id.in_(readable),
                       File.path.not_like("%/%/%"))
                .group_by(File.space_id)
            ).all()
        )
        rows = [space for space in db.scalars(select(Space).where(Space.id.in_(readable)))]
        found = looks.of_spaces(db, readable)
    items = []
    for space in sorted(rows, key=lambda row: sort_key(row.folder)):
        full = root / space.folder
        if not full.is_dir():
            continue
        items.append(_folder_card(
            full, space.folder, space.folder, int(direct.get(space.id) or 0), found.get(space.folder, {}).get(""),
            rights.at_least(roles.get(space.id), WRITE), space=True,
        ))
    return {"path": "", "items": items, "total_notes": 0, "writable": False}


def _folder_level(account, clean: str) -> dict[str, Any]:
    try:
        full = paths.resolve(clean)
    except paths.PathError as exc:
        raise error(exc.code, str(exc), **exc.values) from exc
    if not full.is_dir():
        raise error("not_found", "Not found.", 404)
    space_name = clean.partition("/")[0]
    prefix = clean + "/"
    child = func.substr(File.path, len(prefix) + 1)
    first = func.instr(child, "/")
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == space_name))
        if space is None:
            raise error("not_found", "Not found.", 404)
        writable = rights.at_least(rights.role_in(db, account, space.id), WRITE)
        in_range = (File.deleted_at.is_(None), File.path > prefix, File.path < clean + "0")
        # Notes lying directly in each subfolder: the rest of the path below the subfolder has no slash.
        direct = dict(
            db.execute(
                select(func.substr(child, 1, first - 1).label("child"), func.count())
                .where(*in_range, File.is_note.is_(True), first > 0,
                       func.instr(func.substr(child, first + 1), "/") == 0)
                .group_by(text("child"))
            ).all()
        )
        notes = sorted(
            db.execute(
                select(File.id, File.path, File.title, File.mtime_ns)
                .where(*in_range, File.is_note.is_(True), first == 0)
            ).all(),
            key=lambda row: sort_key(row.path.rsplit("/", 1)[-1]),
        )
        total = len(notes)
        notes = notes[:MAX_NOTES]
        ids = [row.id for row in notes]
        bodies: dict[int, str] = {}
        tags: dict[int, list[str]] = {}
        pictures: dict[int, str] = {}
        readable = rights.readable_ids(db, account)
        for start in range(0, len(ids), 500):
            chunk = ids[start : start + 500]
            marks = ",".join(str(int(one)) for one in chunk)
            for rowid, body in db.execute(
                text(f"SELECT rowid, substr(body, 1, 2000) FROM {FTS_TABLE} WHERE rowid IN ({marks})")  # noqa: S608
            ):
                bodies[rowid] = body or ""
            for file_id, tag in db.execute(
                select(Tag.file_id, Tag.tag).where(Tag.file_id.in_(chunk)).order_by(Tag.file_id, Tag.pos)
            ):
                tags.setdefault(file_id, []).append(tag)
            picture = File.__table__.alias("picture")
            for source_id, path, space_id in db.execute(
                select(Link.source_id, picture.c.path, picture.c.space_id)
                .join(picture, picture.c.id == Link.target_id)
                .where(Link.source_id.in_(chunk), Link.kind.in_((mdparse.EMBED, mdparse.MARKDOWN_EMBED)),
                       picture.c.is_note.is_(False), picture.c.deleted_at.is_(None))
                .order_by(Link.source_id, Link.id)
            ):
                # The first picture it embeds, and only one the reader may see (a link may lead into another space).
                if source_id in pictures or space_id not in readable or not path.lower().endswith(PICTURE_ENDINGS):
                    continue
                pictures[source_id] = path
        found = looks.of_spaces(db, {space.id}).get(space_name, {})
    items: list[dict[str, Any]] = []
    try:
        entries = sorted(full.iterdir(), key=lambda entry: sort_key(entry.name))
    except OSError as exc:
        raise error("not_found", "Not found.", 404) from exc
    for entry in entries:
        if paths.is_hidden(entry.name) or entry.is_symlink() or not entry.is_dir():
            continue
        rel = prefix + entry.name
        items.append(_folder_card(entry, rel, entry.name, int(direct.get(entry.name) or 0),
                                  found.get(rel.partition("/")[2]), writable))
    for row in notes:
        name = row.path.rsplit("/", 1)[-1][:-3]
        title = row.title or name
        items.append({
            "kind": "note",
            "name": title,
            "path": row.path,
            "modified": row.mtime_ns // 1_000_000,
            "tags": tags.get(row.id, [])[:3],
            "excerpt": _excerpt(bodies.get(row.id, ""), title),
            "image": pictures.get(row.id),
        })
    return {"path": clean, "items": items, "total_notes": total, "writable": writable}


@router.get("/coverflow", summary="One level of the vault as cards: the spaces, or a folder's subfolders and notes")
def coverflow(account: Account, path: Annotated[str, Query(max_length=paths.MAX_PATH_CHARS)] = "") -> dict[str, Any]:
    if not path.strip("/"):
        return _spaces_level(account)
    clean = need(account, path, READ)
    return _folder_level(account, clean)


def _folder(account, path: str, role: str):
    clean = need(account, path, role)
    try:
        full = paths.resolve(clean)
    except paths.PathError as exc:
        raise error(exc.code, str(exc), **exc.values) from exc
    if not full.is_dir():
        raise error("not_found", "Not found.", 404)
    return clean, full


@router.get("/cover", summary="The cover picture of a space or folder")
def get_cover(path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)], account: Account) -> Response:
    _clean, full = _folder(account, path, READ)
    try:
        picture = covers.file_of(full).read_bytes()
    except OSError as exc:
        raise error("not_found", "Not found.", 404) from exc
    # The address carries the time it was set (?v=), so a new picture is a new address: kept long, but only here.
    return Response(picture, media_type="image/webp", headers={
        "Cache-Control": "private, max-age=31536000, immutable", "Content-Security-Policy": "sandbox",
    })


@router.put("/cover", summary="Set the cover picture of a space or folder (the picture as the body, or an image file "
            "of the vault as `source`)")
async def set_cover(
    request: Request,
    account: Account,
    path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
    focus: Annotated[float, Query(ge=0, le=100)] = 50,
    source: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None,
) -> dict[str, Any]:
    clean, full = await run_in_threadpool(_folder, account, path, WRITE)
    if source:
        data = await run_in_threadpool(_vault_picture, account, source)
    else:
        data = await request.body()
    try:
        picture = await run_in_threadpool(covers.make, data, focus)
    except covers.CoverError as exc:
        raise error(exc.code, exc.code.replace("_", " "), 422, max_mb=covers.MAX_BYTES // (1024 * 1024)) from exc
    await run_in_threadpool(atomic_write, covers.file_of(full), picture)
    logger.info("Cover set")
    return {"path": clean, "cover": covers.version(full)}


def _vault_picture(account, source: str) -> bytes:
    """The bytes of an image file the index knows and the account may read."""
    clean = need(account, source, READ)
    with SessionLocal() as db:
        known = db.scalar(select(File.id).where(File.path == clean, File.deleted_at.is_(None), File.is_note.is_(False)))
    try:
        full = paths.resolve(clean)
    except paths.PathError as exc:
        raise error(exc.code, str(exc), **exc.values) from exc
    if known is None or not full.is_file():
        raise error("not_found", "Not found.", 404)
    if full.stat().st_size > covers.MAX_BYTES:
        raise error("cover_too_large", "cover too large", 422, max_mb=covers.MAX_BYTES // (1024 * 1024))
    return full.read_bytes()


@router.delete("/cover", status_code=204, summary="Remove the cover picture of a space or folder")
def remove_cover(
    path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)], account: Account
) -> Response:
    _clean, full = _folder(account, path, WRITE)
    covers.file_of(full).unlink(missing_ok=True)
    logger.info("Cover removed")
    return Response(status_code=204)
