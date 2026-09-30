"""Plugins over HTTP (M7): the operator installs and lets out, each account switches on for itself, the frames.

``/api/plugins/{id}/frame`` is the only thing a plugin's frame ever loads: its document, with a policy of its own
that forbids every connection. What a plugin may ask for, it asks the page it sits in; the page calls the routes
here with the account's own session (``query`` for lists of notes, ``note`` to write a note), and these check the
account's rights like every other route and, for writing, that the plugin is switched on and may write.
"""

from __future__ import annotations

import logging
import zlib
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Path, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..db import SessionLocal
from ..deps import Account, DbSession, OperatorAccount, need, readable_spaces
from ..errors import error
from ..models import WRITE, File, Plugin, PluginUser, Space, Tag, Version
from ..services import index, paths, plugins, settings_service, textblocks, vault
from ..services.plugins import PluginError
from ..services.vault import VaultError
from .vault import ActorDep

logger = logging.getLogger("nexlore.plugins")

router = APIRouter(tags=["plugins"])

PluginId = Annotated[str, Path(pattern=r"^[a-z][a-z0-9-]{1,31}$")]


def _fail(exc: PluginError) -> Exception:
    return error(exc.code, exc.text, exc.status)


class PluginOut(BaseModel):
    id: str
    version: str
    author: str
    name: dict[str, str]
    description: dict[str, str]
    permissions: list[str]
    place: dict[str, Any]
    strings: dict[str, dict[str, str]]
    source: str
    enabled: bool = False


def _out(row: Plugin, enabled: bool = False) -> PluginOut:
    manifest = row.manifest or {}
    return PluginOut(
        id=row.id, version=row.version, author=manifest.get("author", ""), name=manifest.get("name", {}),
        description=manifest.get("description", {}), permissions=manifest.get("permissions", []),
        place=manifest.get("place", {}), strings=manifest.get("strings", {}), source=row.source, enabled=enabled,
    )


# --- For everybody ----------------------------------------------------------------------------------------------------


@router.get("/api/plugins", response_model=list[PluginOut])
def mine(account: Account, db: DbSession) -> list[PluginOut]:
    """The plugins the operator let out, each with whether this account switched it on."""
    own = select(PluginUser).where(PluginUser.account_id == account.id)
    chosen = {row.plugin_id: row.enabled for row in db.scalars(own)}
    return [_out(row, chosen.get(row.id, False)) for row in plugins.approved(db)]


class EnabledIn(BaseModel):
    enabled: bool


@router.put("/api/plugins/{plugin_id}/enabled", response_model=PluginOut)
def switch(plugin_id: PluginId, body: EnabledIn, account: Account, db: DbSession) -> PluginOut:
    row = db.get(Plugin, plugin_id)
    if row is None or not row.approved:
        raise error("not_found", "Not found.", 404)
    choice = db.get(PluginUser, (plugin_id, account.id))
    if choice is None:
        choice = PluginUser(plugin_id=plugin_id, account_id=account.id, enabled=body.enabled)
        db.add(choice)
    choice.enabled = body.enabled
    db.commit()
    return _out(row, body.enabled)


@router.get("/api/plugins/{plugin_id}/frame", response_class=HTMLResponse)
def frame(plugin_id: PluginId, account: Account, db: DbSession) -> HTMLResponse:
    row = plugins.enabled_for(db, plugin_id, account.id)
    if row is None:
        raise error("not_found", "Not found.", 404)
    html, policy = plugins.frame(row)
    return HTMLResponse(html, headers={
        "Content-Security-Policy": policy,
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
    })


class Listed(BaseModel):
    path: str
    title: str
    tags: list[str]
    modified: int


@router.get("/api/plugins/query", response_model=list[Listed])
def query(
    account: Account,
    tag: Annotated[str | None, Query(max_length=255)] = None,
    folder: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None,
    space: Annotated[str | None, Query(max_length=255)] = None,
    sort: Annotated[str, Query(pattern="^(modified|title)$")] = "modified",
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
    random: bool = False,
    day: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
) -> list[Listed]:
    """Notes for a plugin's list (the query block, rediscover): readable spaces only, like every list."""
    readable = readable_spaces(account)
    with SessionLocal() as db:
        statement = select(File.id, File.path, File.title, File.mtime_ns).where(
            File.is_note.is_(True), File.deleted_at.is_(None), File.space_id.in_(readable)
        )
        if space:
            statement = statement.join(Space, Space.id == File.space_id).where(Space.folder == space)
        if tag:
            tagged = select(Tag.file_id).where(Tag.tag_key == paths.fold(tag.lstrip("#")))
            statement = statement.where(File.id.in_(tagged))
        if folder:
            inside = folder.strip("/").replace("\\", "/")
            escaped = inside.replace("%", "\\%").replace("_", "\\_")
            statement = statement.where(
                File.path.like(f"%/{escaped}/%", escape="\\") | File.path.like(f"{escaped}/%", escape="\\")
            )
        if day:
            try:
                start = datetime.fromisoformat(day).replace(tzinfo=UTC)
            except ValueError as exc:
                # The pattern lets 2026-13-40 through; a plugin can send anything.
                raise error("invalid_input", "The input is not valid.", 422, fields=["day"]) from exc
            first, last = int(start.timestamp() * 1e9), int((start + timedelta(days=1)).timestamp() * 1e9)
            statement = statement.where((File.name_key == day) | ((File.mtime_ns >= first) & (File.mtime_ns < last)))
        if random:
            statement = statement.order_by(func.random())
        elif sort == "title":
            # As a reader sorts: `Ärger` with the A (SQLite put it after Z; review before 1.0.0, P5.11).
            statement = statement.order_by(func.nx_sort(File.title))
        else:
            statement = statement.order_by(File.mtime_ns.desc())
        rows = db.execute(statement.limit(limit)).all()
        tags: dict[int, list[str]] = {}
        for file_id, name in db.execute(
            select(Tag.file_id, Tag.tag).where(Tag.file_id.in_([row.id for row in rows])).order_by(Tag.pos)
        ):
            tags.setdefault(file_id, []).append(name)
    return [Listed(path=row.path, title=row.title, tags=tags.get(row.id, []), modified=row.mtime_ns // 1_000_000)
            for row in rows]


class NoteIn(BaseModel):
    plugin: str = Field(pattern=r"^[a-z][a-z0-9-]{1,31}$")
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    content: str = Field(max_length=index.MAX_NOTE_BYTES)
    base_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.put("/api/plugins/note")
def write_note(body: NoteIn, account: Account, who: ActorDep) -> dict[str, Any]:
    """A plugin writes the note it shows (Kanban): with the right to write, only for a plugin switched on that may
    write, lines it did not change kept byte for byte, a conflict copy when the note changed since it was read."""
    with SessionLocal() as db:
        row = plugins.enabled_for(db, body.plugin, account.id)
        if row is None or "note:write" not in (row.manifest or {}).get("permissions", []):
            raise error("not_found", "Not found.", 404)
    clean = need(account, body.path, WRITE)
    try:
        file, current = vault.read(clean)
    except VaultError as exc:
        raise error("not_found", "Not found.", 404) from exc
    if index.digest(current) == body.base_hash:
        base = current
    else:
        with SessionLocal() as db:
            stored = db.scalar(
                select(Version.content).where(Version.file_id == file.id, Version.hash == body.base_hash).limit(1)
            )
        base = zlib.decompress(stored) if stored is not None else current
    try:
        data = textblocks.keep_unchanged(base, body.content)
        saved = vault.save(clean, data, base_hash=body.base_hash, actor=who, source=index.PLUGIN)
    except (UnicodeDecodeError, VaultError) as exc:
        raise error("not_saved", "Not saved.", 409) from exc
    logger.info("Plugin wrote a note plugin=%s conflict=%s", body.plugin, saved.conflict is not None)
    return {"saved": saved.conflict is None, "conflict": saved.conflict, "hash": saved.file.hash}


# --- For the operator -------------------------------------------------------------------------------------------------


class AdminPlugins(BaseModel):
    catalog: list[PluginOut]
    installed: list[dict[str, Any]]
    upload_allowed: bool


@router.get("/api/admin/plugins", response_model=AdminPlugins)
def admin_list(_operator: OperatorAccount, db: DbSession) -> AdminPlugins:
    installed = [
        {**_out(row).model_dump(), "approved": row.approved, "installed_at": row.installed_at,
         "installed_by": row.installed_by, "users": db.scalar(select(func.count()).select_from(PluginUser).where(
             PluginUser.plugin_id == row.id, PluginUser.enabled.is_(True))) or 0}
        for row in db.scalars(select(Plugin).order_by(Plugin.id))
    ]
    catalog = [PluginOut(id=e.manifest["id"], version=e.manifest["version"], author=e.manifest["author"],
                         name=e.manifest["name"], description=e.manifest["description"],
                         permissions=e.manifest["permissions"], place=e.manifest["place"], strings={},
                         source="catalog") for e in plugins.catalog()]
    return AdminPlugins(catalog=catalog, installed=installed,
                        upload_allowed=bool(settings_service.get(db, "plugin_upload_allowed")))


@router.post("/api/admin/plugins/{plugin_id}/install", response_model=PluginOut)
def admin_install(plugin_id: PluginId, operator: OperatorAccount, db: DbSession) -> PluginOut:
    try:
        return _out(plugins.install(db, plugins.from_catalog(plugin_id), source="catalog", by=operator.name))
    except PluginError as exc:
        raise _fail(exc) from exc


class UploadIn(BaseModel):
    manifest: dict[str, Any]
    code: str = Field(max_length=plugins.MAX_CODE)


@router.post("/api/admin/plugins", response_model=PluginOut, status_code=201)
def admin_upload(body: UploadIn, operator: OperatorAccount, db: DbSession) -> PluginOut:
    """A plugin file of one's own: only behind the operator's latch, never under an id of the catalog."""
    if not settings_service.get(db, "plugin_upload_allowed"):
        raise error("plugin_upload_off", "Plugins of one's own are not allowed here.", 403)
    try:
        manifest = plugins.check_manifest(body.manifest)
        if any(entry.manifest["id"] == manifest["id"] for entry in plugins.catalog()):
            raise PluginError("exists", "The catalog has a plugin of this id.", 409)
        code = body.code.encode("utf-8")
        entry = plugins.Entry(manifest=manifest, code=plugins.check_code(code), code_hash=plugins.sha256(code))
        return _out(plugins.install(db, entry, source="upload", by=operator.name))
    except PluginError as exc:
        raise _fail(exc) from exc


class ApprovedIn(BaseModel):
    approved: bool


@router.put("/api/admin/plugins/{plugin_id}", response_model=PluginOut)
def admin_approve(plugin_id: PluginId, body: ApprovedIn, operator: OperatorAccount, db: DbSession) -> PluginOut:
    row = db.get(Plugin, plugin_id)
    if row is None:
        raise error("not_found", "Not found.", 404)
    row.approved = body.approved
    db.commit()
    logger.info("Plugin %s plugin=%s by=%s", "let out" if body.approved else "held back", plugin_id, operator.name)
    return _out(row)


@router.delete("/api/admin/plugins/{plugin_id}", status_code=204)
def admin_remove(plugin_id: PluginId, operator: OperatorAccount, db: DbSession) -> None:
    row = db.get(Plugin, plugin_id)
    if row is None:
        raise error("not_found", "Not found.", 404)
    db.query(PluginUser).filter(PluginUser.plugin_id == plugin_id).delete()
    db.delete(row)
    db.commit()
    logger.info("Plugin removed plugin=%s by=%s", plugin_id, operator.name)
