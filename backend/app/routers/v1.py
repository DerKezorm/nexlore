"""The API for programs (``/api/v1``): n8n, nexdeck, scripts. An API token in ``Authorization: Bearer``.

**The promise.** What is under ``/api/v1`` stays as it is: new fields may come, nothing is renamed or taken away. A
change that would break a program goes to ``/api/v2`` beside it. ``docs/api.md`` describes every route.

Walls, in this order: a request that carries an ``Origin`` is refused (browsers send one, programs do not; no web page
can use a token it found); API tokens must be switched on by the operator; the token must be valid; the token must stay
under its rate. The session cookie counts for nothing here, and ``X-Nexlore-Client`` is not needed.

Every route reuses the routes of the interface with the token's account: the same rights, the same "not found" for a
space the account (or the token) may not read, the same size limits. Writing needs a token of the level ``write``
and the right to write in the space; it makes and changes, never deletes, moves or renames (no route for that exists
here). Each change is a version with the source ``api``. A change against a note that changed since the program read
it, or that somebody is editing, goes into a conflict copy, as with MCP.
"""

from __future__ import annotations

import logging
import re
import secrets
import zlib
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import Integer, cast, func, select

from .. import __version__
from ..db import SessionLocal
from ..deps import need, readable_spaces
from ..errors import error
from ..models import READ, WRITE, ApiToken, File, Space, Version
from ..services import apitokens, appearance, everyday, inbox, index, logs, paths, rights, textblocks, vault
from ..services.apitokens import Caller
from ..services.vault import Actor, VaultError
from . import everyday as everyday_routes
from . import export as export_routes
from . import search as search_routes
from . import vault as vault_routes

logger = logging.getLogger("nexlore.api")

router = APIRouter(prefix="/api/v1", tags=["api v1"])

PathQuery = Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)]
DateQuery = Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")]
#: The program's moment with its offset (``2026-10-02T07:30:00+02:00``), for dates and times written into notes; the
#: server's own time without it.
NowField = Field(default="", max_length=40)
MAX_TEXT = index.MAX_NOTE_BYTES


def _token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else None


def caller(request: Request) -> Caller:
    if request.headers.get("origin"):
        raise error("origin_refused", "The API is for programs, not web pages.", 403)
    with SessionLocal() as db:
        if not apitokens.allowed(db):
            raise error("api_off", "The operator has not switched API tokens on.", 401)
        found = apitokens.authenticate(db, _token(request))
    if found is None:
        raise error("token_invalid", "No valid API token.", 401)
    if not apitokens.brake(found.token_id):
        exc = error("slow_down", "Too many requests with this token. Wait a minute.", 429)
        exc.headers = {"Retry-After": "60"}
        raise exc
    logs.set_actor(found.account.name)
    return found


def writer(found: Annotated[Caller, Depends(caller)]) -> Caller:
    if not found.writes:
        raise error("read_only_token", "This token may only read.", 403)
    return found


Reader = Annotated[Caller, Depends(caller)]
Writer = Annotated[Caller, Depends(writer)]


def _actor(found: Caller) -> Actor:
    # One identity per request: an API write never holds a lock and never passes for an editor's tab.
    return Actor(name=found.account.name, client=f"api-{found.token_id}-{secrets.token_hex(4)}", source=index.API)


def _fail(exc: VaultError) -> Exception:
    return error(exc.code, exc.text, exc.status, **exc.values)


def _today(value: str | None) -> str:
    if not value:
        return datetime.now().astimezone().date().isoformat()
    # The pattern lets 2026-13-40 through; the dashboard gave a server error on it.
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise error("bad_date", "The date does not exist.", 400) from exc


def _modified(mtime_ns: int) -> datetime:
    return datetime.fromtimestamp(mtime_ns / 1_000_000_000, tz=UTC)


def _space_only(name: str) -> str:
    if "/" in name:
        raise error("not_found", "Not found.", 404)
    return name


def _home_space(found: Caller) -> str:
    """Where quick capture goes without a space: the account's main space, else its first own space it writes in,
    else the first it writes in (as the interface chooses, ``lib/everyday.homeSpace``)."""
    chosen = appearance.of(found.account.appearance).get("home_space") or ""
    with SessionLocal() as db:
        readable = rights.readable_ids(db, found.account)
        roles = {space_id: rights.role_in(db, found.account, space_id) for space_id in readable}
        names = dict(db.execute(select(Space.id, Space.folder).where(Space.id.in_(roles))).all())
    writable = sorted((names[space_id], role) for space_id, role in roles.items()
                      if space_id in names and rights.at_least(role, WRITE))
    for name, _role in writable:
        if name == chosen:
            return name
    for name, role in writable:
        if role == "manage":
            return name
    if writable:
        return writable[0][0]
    raise error("no_space", "The token's account may write in no space.", 409)


# --- Who --------------------------------------------------------------------------------------------------------------


class MeOut(BaseModel):
    account: str
    display_name: str
    #: ``read`` or ``write``.
    level: str
    #: The spaces the token is limited to; None: every space the account may read.
    spaces: list[str] | None = None
    expires_at: datetime | None = None
    version: str


@router.get("/me", response_model=MeOut, summary="The token's account, level and limits")
def me(found: Reader) -> MeOut:
    with SessionLocal() as db:
        row = db.get(ApiToken, found.token_id)
        names = None
        if found.account.key_spaces is not None:
            names = sorted(db.scalars(select(Space.folder).where(Space.id.in_(rights.readable_ids(db, found.account)))))
    return MeOut(account=found.account.name, display_name=found.account.display_name or found.account.name,
                 level=found.level, spaces=names, expires_at=row.expires_at if row else None, version=__version__)


# --- Reading ----------------------------------------------------------------------------------------------------------


class SpaceOut(BaseModel):
    name: str
    #: The own right: read, write or manage.
    role: str
    notes: int
    daily_folder: str
    template_folder: str


@router.get("/spaces", response_model=list[SpaceOut], summary="The spaces the token may read")
def spaces(found: Reader) -> list[SpaceOut]:
    return [SpaceOut(name=s.name, role=s.role, notes=s.notes, daily_folder=s.daily_folder,
                     template_folder=s.template_folder) for s in vault_routes.spaces(found.account)]


class FolderEntry(BaseModel):
    path: str
    name: str
    #: Notes anywhere below it.
    notes: int


class FileEntry(BaseModel):
    path: str
    name: str
    title: str
    is_note: bool
    size: int
    modified: datetime


class FolderOut(BaseModel):
    path: str
    folders: list[FolderEntry]
    files: list[FileEntry]
    total_files: int


@router.get("/folder", response_model=FolderOut, summary="What lies directly in a space or folder")
def folder(
    found: Reader,
    path: PathQuery,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> FolderOut:
    listing = vault_routes.folder(path, found.account, offset, limit)
    return FolderOut(
        path=listing.path,
        folders=[FolderEntry(path=f.path, name=f.name, notes=f.notes) for f in listing.folders],
        files=[FileEntry(path=f.path, name=f.name, title=f.title, is_note=f.is_note, size=f.size,
                         modified=_modified(f.modified * 1_000_000)) for f in listing.files],
        total_files=listing.total_files,
    )


class NoteOut(BaseModel):
    path: str
    title: str
    content: str
    #: Give it back as ``base_hash`` when changing the note.
    hash: str
    tags: list[str]
    #: The front matter as JSON, None without one.
    front: Any = None
    modified: datetime
    #: The note is not UTF-8: it is shown, but never written from text.
    readonly: bool


@router.get("/note", response_model=NoteOut, summary="A note: its text, tags, front matter and hash")
def note(found: Reader, path: PathQuery) -> NoteOut:
    read = vault_routes.note(path, found.account, _actor(found))
    return NoteOut(path=read.path, title=read.title, content=read.content, hash=read.hash, tags=read.tags,
                   front=read.front, modified=_modified(read.modified * 1_000_000), readonly=read.readonly)


def _pdf(found: Caller, *, note: str | None, folder: str | None, paper: str, language: str | None, links: str,
         properties: bool, embeds: bool) -> Response:
    options = export_routes.OptionsIn(
        paper=paper, language=language, links=links, properties=properties, embeds=embeds,  # type: ignore[arg-type]
    )
    return export_routes.export_pdf(export_routes.ExportIn(path=note, folder=folder, options=options), found.account)


@router.get("/note/pdf", response_class=Response, summary="A note as PDF, set as the app sets it",
            responses={200: {"content": {"application/pdf": {}}}})
def note_pdf(
    found: Reader, path: PathQuery,
    paper: Annotated[Literal["a4", "letter"], Query()] = "a4",
    language: Annotated[Literal["de", "en"] | None, Query()] = None,
    links: Annotated[Literal["footnote", "text"], Query()] = "footnote",
    properties: bool = True, embeds: bool = True,
) -> Response:
    return _pdf(found, note=path, folder=None, paper=paper, language=language, links=links, properties=properties,
                embeds=embeds)


@router.get("/folder/pdf", response_class=Response, summary="Every note of a folder as one PDF, with contents",
            responses={200: {"content": {"application/pdf": {}}}})
def folder_pdf(
    found: Reader, path: PathQuery,
    paper: Annotated[Literal["a4", "letter"], Query()] = "a4",
    language: Annotated[Literal["de", "en"] | None, Query()] = None,
    links: Annotated[Literal["footnote", "text"], Query()] = "footnote",
    properties: bool = True, embeds: bool = True,
) -> Response:
    return _pdf(found, note=None, folder=path, paper=paper, language=language, links=links, properties=properties,
                embeds=embeds)


class LinkOut(BaseModel):
    #: What the link says.
    target: str
    #: The note it leads to; None: no note (or one in a space the token may not read).
    path: str | None
    line: int


class BacklinkOut(BaseModel):
    path: str
    title: str
    line: int
    #: The line the link stands in, as plain text (for the first notes only).
    context: str | None = None


class LinksOut(BaseModel):
    outgoing: list[LinkOut]
    backlinks: list[BacklinkOut]


@router.get("/links", response_model=LinksOut, summary="Where a note's links lead, and what links to it")
def links(found: Reader, path: PathQuery) -> LinksOut:
    got = vault_routes.links(path, found.account)
    return LinksOut(outgoing=[LinkOut(target=o.target, path=o.path, line=o.line) for o in got.outgoing],
                    backlinks=[BacklinkOut(path=b.path, title=b.title, line=b.line, context=b.context)
                               for b in got.backlinks])


class LineOut(BaseModel):
    line: int
    text: str


class HitOut(BaseModel):
    path: str
    title: str
    #: The lines that fit, without marks.
    lines: list[LineOut]


class SearchOut(BaseModel):
    notes: list[HitOut]
    #: More notes fit: ask again with ``offset``.
    more: bool


_MARKS = str.maketrans({vault_routes.HIT_START: None, vault_routes.HIT_END: None})


@router.get("/search", response_model=SearchOut,
            summary="Search with the operators of the search page: phrases, -left_out, OR, tag:, path:, file:, task:")
def search(
    found: Reader,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> SearchOut:
    page = search_routes.search_notes(found.account, q, limit, offset)
    return SearchOut(
        notes=[HitOut(path=n.path, title=n.title, lines=[LineOut(line=ln.line, text=ln.text.translate(_MARKS))
                                                        for ln in n.lines]) for n in page.notes],
        more=page.more,
    )


class RecentNote(BaseModel):
    path: str
    title: str
    space: str
    modified: datetime


@router.get("/recent", response_model=list[RecentNote], summary="The notes changed last")
def recent(
    found: Reader,
    space: Annotated[str | None, Query(max_length=255)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
) -> list[RecentNote]:
    readable = readable_spaces(found.account)
    if space:
        need(found.account, _space_only(space), READ)
    with SessionLocal() as db:
        query = select(File.path, File.title, File.mtime_ns, Space.folder).join(Space, Space.id == File.space_id).where(
            File.deleted_at.is_(None), File.is_note.is_(True), File.space_id.in_(readable)
        )
        if space:
            query = query.where(Space.folder == space)
        rows = db.execute(query.order_by(File.mtime_ns.desc(), File.id.desc()).limit(limit)).all()
    return [RecentNote(path=path, title=title or paths.stem(path), space=folder, modified=_modified(mtime))
            for path, title, mtime, folder in rows]


class TemplateOut(BaseModel):
    path: str
    title: str


@router.get("/templates", response_model=list[TemplateOut], summary="The templates of a space")
def templates(found: Reader, space: Annotated[str, Query(min_length=1, max_length=255)]) -> list[TemplateOut]:
    return [TemplateOut(**item) for item in everyday_routes.template_list(space, found.account)]


# --- Tasks ------------------------------------------------------------------------------------------------------------


class TaskOut(BaseModel):
    path: str
    title: str
    line: int
    #: The whole line; give it back when ticking the task off.
    raw: str
    text: str
    #: ``open``, ``done`` or ``cancelled``.
    status: str
    due: str | None = None
    scheduled: str | None = None
    completed: str | None = None
    priority: int = 0
    tags: list[str] = []
    #: The note's hash when listed; give it back as ``hash`` when ticking off.
    file_hash: str


class TaskCounts(BaseModel):
    open: int
    done: int
    cancelled: int
    overdue: int
    today: int
    week: int
    later: int
    none: int


class TasksOut(BaseModel):
    total: int
    counts: TaskCounts
    items: list[TaskOut]


@router.get("/tasks", response_model=TasksOut, summary="Tasks across the spaces the token may read")
def tasks(
    found: Reader,
    status: Annotated[str, Query(pattern="^(open|done|cancelled|all)$")] = "open",
    when: Annotated[str | None, Query(pattern="^(overdue|today|week|later|none)$")] = None,
    today: DateQuery = None,
    space: Annotated[str | None, Query(max_length=255)] = None,
    tag: Annotated[str | None, Query(max_length=255)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> TasksOut:
    got = everyday_routes.task_list(found.account, _today(today), status, when, None, None, None, space or None,
                                    tag or None, q or None, offset, limit)
    return TasksOut(total=got["total"], counts=TaskCounts(**got["counts"]),
                    items=[TaskOut(**{key: item[key] for key in TaskOut.model_fields}) for item in got["items"]])


class CompleteIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    line: int = Field(ge=1)
    raw: str = Field(max_length=100_000)
    #: False opens it again.
    done: bool = True
    #: ``file_hash`` from the list; when the note changed since, a line that is there twice is not guessed at.
    hash: str | None = Field(default=None, max_length=128)
    today: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class CompleteOut(BaseModel):
    path: str
    line: int
    raw: str
    #: A conflict copy, when the note could not take the change.
    conflict: str | None = None
    #: The next one of a recurring task, written above it.
    added: str | None = None


@router.post("/tasks/complete", response_model=CompleteOut, summary="Tick a task off, or open it again")
def complete(body: CompleteIn, found: Writer) -> CompleteOut:
    rel = need(found.account, body.path, WRITE)
    try:
        done = everyday.toggle(rel, body.line, body.raw, done=body.done, today=_today(body.today), actor=_actor(found),
                               seen=body.hash, source=index.API)
    except VaultError as exc:
        raise _fail(exc) from exc
    return CompleteOut(path=done["path"], line=done["line"], raw=done["raw"], conflict=done.get("conflict"),
                       added=done.get("added"))


# --- The dashboard ----------------------------------------------------------------------------------------------------

#: An entry of an inbox: a list item at the start of a line.
_ENTRY = re.compile(r"^[-*+][ \t]", re.MULTILINE)


class DashboardOut(BaseModel):
    spaces: int
    notes: int
    #: Open tasks, and of those: overdue, due today, due in the next six days.
    tasks_open: int
    tasks_overdue: int
    tasks_today: int
    tasks_week: int
    #: Entries waiting in the inbox notes.
    inbox: int


@router.get("/dashboard", response_model=DashboardOut, summary="The numbers for a dashboard, in one request")
def dashboard(
    found: Reader,
    today: DateQuery = None,
    space: Annotated[str | None, Query(max_length=255)] = None,
) -> DashboardOut:
    readable = readable_spaces(found.account)
    if space:
        need(found.account, _space_only(space), READ)
    with SessionLocal() as db:
        names = dict(db.execute(select(Space.id, Space.folder).where(Space.id.in_(readable))).all())
        if space:
            names = {space_id: name for space_id, name in names.items() if name == space}
        notes = db.scalar(
            select(func.sum(cast(File.is_note, Integer))).where(File.deleted_at.is_(None), File.space_id.in_(names))
        ) or 0
        boxes = [path for name in names.values() if (path := inbox._find(db, name, None)) is not None]
    counts = everyday.list_tasks(set(names), status="open", today=_today(today), limit=1)["counts"]
    waiting = 0
    for path in boxes:
        try:
            _file, data = vault.read(path)
        except VaultError:
            continue
        waiting += len(_ENTRY.findall(data.decode("utf-8", errors="replace")))
    return DashboardOut(spaces=len(names), notes=int(notes), tasks_open=counts["open"],
                        tasks_overdue=counts["overdue"], tasks_today=counts["today"], tasks_week=counts["week"],
                        inbox=waiting)


# --- Writing ----------------------------------------------------------------------------------------------------------


class CreateIn(BaseModel):
    #: A space or a folder in it.
    folder: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    title: str = Field(min_length=1, max_length=1024)
    content: str = Field(default="", max_length=MAX_TEXT)
    #: A template of the same space; its placeholders are filled and ``content`` is ignored.
    template: str | None = Field(default=None, max_length=paths.MAX_PATH_CHARS)
    now: str = NowField


class SavedOut(BaseModel):
    path: str
    #: The note's hash after the change; with a conflict the note's as it is.
    hash: str
    #: False: the text went into ``conflict``, the note stayed as it was.
    saved: bool
    conflict: str | None = None


@router.post("/notes", response_model=NoteOut, status_code=201, summary="Make a note, from a template if wanted")
def create(body: CreateIn, found: Writer) -> NoteOut:
    folder = need(found.account, body.folder, WRITE)
    content = body.content
    if body.template:
        template = need(found.account, body.template, READ)
        if paths.space_of(template) != paths.space_of(folder):
            raise error("not_found", "Not found.", 404)
        try:
            content = everyday.render(template, title=body.title.strip(), when=everyday.reader_time(body.now),
                                      language=found.account.language or "en")
        except VaultError as exc:
            raise _fail(exc) from exc
    try:
        made = vault.create_note(folder, body.title, content.encode("utf-8"), actor=_actor(found), source=index.API)
    except VaultError as exc:
        raise _fail(exc) from exc
    logger.info("API note made token_id=%s", found.token_id)
    return note(found, made.path)


class ReplaceIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    content: str = Field(max_length=MAX_TEXT)
    #: The hash the note had when read (``GET /api/v1/note``).
    base_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


def _base(file: File, current: bytes, base_hash: str) -> bytes | None:
    """The text the program read: the file, or, when it changed since, that state from the note's versions; None
    when that state is not kept any more (a version bundled away)."""
    if index.digest(current) == base_hash:
        return current
    with SessionLocal() as db:
        content = db.scalar(select(Version.content).where(Version.file_id == file.id, Version.hash == base_hash)
                            .limit(1))
    return zlib.decompress(content) if content is not None else None


@router.put("/note", response_model=SavedOut, summary="Replace a note's text; unchanged lines stay as they were")
def replace(body: ReplaceIn, found: Writer) -> SavedOut:
    clean = need(found.account, body.path, WRITE)
    try:
        file, current = vault.read(clean)
    except VaultError as exc:
        raise _fail(exc) from exc
    if not file.is_note:
        raise error("not_a_note", "This file is not a note.")
    try:
        current.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise error("not_utf8", "The note is not UTF-8; it is shown, never written from text.", 409) from exc
    # Read in a state nexlore no longer keeps: the text as written, and saving makes it a conflict copy, as promised
    # (review before 1.0.0: it was refused with base_unknown and the program's text was lost).
    base = _base(file, current, body.base_hash)
    data = textblocks.keep_unchanged(base, body.content) if base is not None else body.content.encode("utf-8")
    if len(data) > MAX_TEXT:
        raise error("too_large", "A note holds at most 5 MB.", 413)
    try:
        saved = vault.save(clean, data, base_hash=body.base_hash, actor=_actor(found), source=index.API)
    except VaultError as exc:
        raise _fail(exc) from exc
    logger.info("API note written token_id=%s conflict=%s", found.token_id, saved.conflict is not None)
    return SavedOut(path=clean, hash=saved.file.hash, saved=saved.conflict is None, conflict=saved.conflict)


class AppendIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    text: str = Field(min_length=1, max_length=MAX_TEXT)


class PathOut(BaseModel):
    path: str


def _append(found: Caller, rel: str, text: str) -> None:
    try:
        inbox.append(rel, text, actor=_actor(found), source=index.API)
    except inbox.InboxError as exc:
        raise error(exc.code, str(exc), exc.status) from exc


@router.post("/note/append", response_model=PathOut, summary="Add text at the end of a note")
def append(body: AppendIn, found: Writer) -> PathOut:
    clean = need(found.account, body.path, WRITE)
    if not paths.is_note(clean):
        raise error("not_a_note", "This file is not a note.")
    _append(found, clean, body.text)
    return PathOut(path=clean)


class DailyIn(BaseModel):
    space: str = Field(min_length=1, max_length=255)
    #: Left out: today (by ``now``, else the server's clock).
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    #: Added at the end of the daily note; left out, the note is only made when missing.
    text: str | None = Field(default=None, max_length=MAX_TEXT)
    now: str = NowField


class DailyOut(BaseModel):
    path: str
    #: The note was made now (from the space's daily template).
    created: bool


@router.post("/daily", response_model=DailyOut, summary="The daily note, made from the template when missing")
def daily(body: DailyIn, found: Writer) -> DailyOut:
    space = _space_only(need(found.account, body.space, WRITE))
    moment = everyday.reader_time(body.now)
    try:
        made = everyday.open_daily(space, body.date or moment.date().isoformat(), actor=_actor(found), may_write=True,
                                   language=found.account.language or "en", now=moment, source=index.API)
    except VaultError as exc:
        raise _fail(exc) from exc
    if body.text and body.text.strip():
        _append(found, made.path, body.text)
    return DailyOut(path=made.path, created=made.created)


class InboxIn(BaseModel):
    text: str = Field(min_length=1, max_length=inbox.MAX_CHARS)
    #: Left out: the account's main space.
    space: str | None = Field(default=None, max_length=255)
    now: str = NowField


@router.post("/inbox", response_model=PathOut, summary="Put words on top of a space's inbox note")
def capture(body: InboxIn, found: Writer) -> PathOut:
    space = _space_only(need(found.account, body.space or _home_space(found), WRITE))
    stamp = everyday.reader_time(body.now).strftime("%Y-%m-%d %H:%M")
    try:
        path = inbox.capture(space, body.text, stamp, actor=_actor(found), language=found.account.language,
                             source=index.API)
    except inbox.InboxError as exc:
        raise error(exc.code, str(exc), exc.status) from exc
    except VaultError as exc:
        raise _fail(exc) from exc
    return PathOut(path=path)
