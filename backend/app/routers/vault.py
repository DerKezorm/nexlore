"""The vault over HTTP: spaces, folders, notes, links, tags, search, locks, versions, trash.

Paths travel as query parameters or in the body, always vault-relative with ``/``. Every route needs an account
and a right in the space the path lies in (``deps.need``); a space it may not read answers like one that does not
exist, and lists, search and tags leave it out (the graph has its own router).

A browser tab names itself in ``X-Nexlore-Client``: locks belong to a tab, not to an account, so the same person in
two tabs cannot type over themselves.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query
from fastapi import Path as PathParam
from pydantic import BaseModel, Field
from sqlalchemy import Integer, cast, func, select, text

from ..db import SessionLocal
from ..deps import Account, OperatorAccount, need, readable_spaces
from ..errors import error
from ..models import FTS_TABLE, MANAGE, OPERATOR, READ, WRITE, File, Link, Membership, Space, Tag
from ..services import everyday, index, paths, rights, vault
from ..services.vault import Actor, VaultError

router = APIRouter(prefix="/api", tags=["vault"])

CLIENT_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
BOM = b"\xef\xbb\xbf"
#: Marks around a search hit in a snippet: control characters, so they can never be confused with note text or HTML.
HIT_START = "\x02"
HIT_END = "\x03"
MAX_NOTE_UPLOAD = index.MAX_NOTE_BYTES


def _fail(exc: VaultError) -> Exception:
    return error(exc.code, exc.text, exc.status, **exc.values)


def _where(find: Any, key: Any) -> str:
    """The path of a version or trash entry, for the rights check. A missing one answers exactly like one in a space
    the caller may not read (``rights.check``), so numbers cannot be counted through."""
    try:
        return str(find(key))
    except VaultError as exc:
        if exc.code == "not_found":
            raise error("not_found", "No such file.", 404) from exc
        raise _fail(exc) from exc


def actor(account: Account, x_nexlore_client: Annotated[str | None, Header()] = None) -> Actor:
    # Changes always carry the header (the guard middleware refuses them otherwise). A read without it gets an id
    # of its own, never one shared with other callers: it holds no lock, so it must not look like a holder.
    valid = x_nexlore_client and CLIENT_PATTERN.match(x_nexlore_client)
    client = x_nexlore_client if valid else f"reader-{secrets.token_hex(8)}"
    return Actor(name=account.name, client=client)


ActorDep = Annotated[Actor, Depends(actor)]
PathQuery = Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)]
TrashId = Annotated[str, PathParam(max_length=64, pattern=r"^[fg]-(note-)?[0-9a-f-]+$")]


# --- Spaces and folders ---------------------------------------------------------------------------------------------


class SpaceOut(BaseModel):
    id: int
    name: str
    notes: int
    files: int
    #: The own right: read, write or manage.
    role: str


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)


@router.get("/spaces", response_model=list[SpaceOut])
def spaces(account: Account) -> list[SpaceOut]:
    root = paths.vault_root()
    with SessionLocal() as db:
        roles = {space_id: rights.role_in(db, account, space_id) for space_id in rights.readable_ids(db, account)}
        counts = {
            space_id: (notes or 0, files)
            for space_id, notes, files in db.execute(
                # Cast: a sum of a Boolean column comes back as a Boolean, 2 notes would read as True.
                select(File.space_id, func.sum(cast(File.is_note, Integer)), func.count())
                .where(File.deleted_at.is_(None))
                .group_by(File.space_id)
            )
        }
        rows = list(db.scalars(select(Space).order_by(Space.folder)))
    result = []
    for space in rows:
        role = roles.get(space.id)
        if role is None or not (root / space.folder).is_dir():
            continue
        notes, files = counts.get(space.id, (0, 0))
        result.append(SpaceOut(id=space.id, name=space.folder, notes=int(notes), files=files, role=role))
    return result


@router.post("/spaces", response_model=SpaceOut, status_code=201)
def create_space(body: NameIn, account: Account) -> SpaceOut:
    """Every account may make spaces of its own; whoever makes one manages it."""
    with SessionLocal() as db:
        try:
            rights.free_name(db, body.name.strip())
        except rights.RightsError as exc:
            raise error(exc.code, exc.text, exc.status) from exc
    try:
        name = vault.create_space(body.name.strip())
    except VaultError as exc:
        raise _fail(exc) from exc
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == name))
        assert space is not None
        db.add(Membership(space_id=space.id, account_id=account.id, role=MANAGE))
        db.commit()
        return SpaceOut(id=space.id, name=name, notes=0, files=0, role=MANAGE)


class FolderEntry(BaseModel):
    name: str
    path: str
    notes: int


class FileEntry(BaseModel):
    id: int
    name: str
    path: str
    title: str
    is_note: bool
    size: int
    modified: int


class FolderOut(BaseModel):
    path: str
    folders: list[FolderEntry]
    files: list[FileEntry]
    #: Files directly in the folder, all of them; ``files`` holds the page asked for.
    total_files: int = 0


@router.get("/folder", response_model=FolderOut)
def folder(
    path: PathQuery,
    account: Account,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int | None, Query(ge=1, le=5000)] = None,
) -> FolderOut:
    """What lies directly in a space or folder: its subfolders with how many notes are below, and its files, by
    name; ``offset`` and ``limit`` give a page of the files (a flat folder can hold tens of thousands)."""
    need(account, path, READ)
    try:
        clean = paths.parse(path)
        full = paths.resolve(clean)
    except paths.PathError as exc:
        raise error(exc.code, str(exc)) from exc
    if not full.is_dir():
        raise error("not_found", "No such folder.", 404)
    prefix = clean + "/"
    with SessionLocal() as db:
        child = func.substr(File.path, len(prefix) + 1)
        counts = dict(
            db.execute(
                select(
                    func.substr(child, 1, func.instr(child, "/") - 1).label("child"),
                    func.count(),
                )
                .where(
                    File.deleted_at.is_(None), File.is_note.is_(True), File.path > prefix, File.path < clean + "0",
                    func.instr(child, "/") > 0,
                )
                .group_by(text("child"))
            ).all()
        )
        files = list(
            db.scalars(
                select(File).where(
                    File.deleted_at.is_(None), File.path > prefix, File.path < clean + "0",
                    func.instr(func.substr(File.path, len(prefix) + 1), "/") == 0,
                )
            )
        )
    folders = []
    try:
        entries = list(os.scandir(full))
    except OSError as exc:
        raise error("not_found", "No such folder.", 404) from exc
    for entry in entries:
        if paths.is_hidden(entry.name) or entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
            continue
        folders.append(FolderEntry(name=entry.name, path=prefix + entry.name, notes=counts.get(entry.name, 0)))
    folders.sort(key=lambda item: paths.fold(item.name))
    ordered = sorted(
        (
            FileEntry(
                id=file.id, name=file.path.rsplit("/", 1)[-1], path=file.path, title=file.title,
                is_note=file.is_note, size=file.size, modified=file.mtime_ns // 1_000_000,
            )
            for file in files
        ),
        key=lambda item: paths.fold(item.name),
    )
    end = None if limit is None else offset + limit
    return FolderOut(path=clean, folders=folders, files=ordered[offset:end], total_files=len(ordered))


class FolderIn(BaseModel):
    parent: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    name: str = Field(min_length=1, max_length=255)


@router.post("/folders", status_code=201)
def create_folder(body: FolderIn, account: Account) -> dict[str, str]:
    need(account, body.parent, WRITE)
    try:
        return {"path": vault.create_folder(body.parent, body.name.strip())}
    except VaultError as exc:
        raise _fail(exc) from exc


# --- Notes ----------------------------------------------------------------------------------------------------------


class LockOut(BaseModel):
    holder: str
    mine: bool
    expires_at: datetime


class NoteOut(BaseModel):
    id: int
    path: str
    title: str
    content: str
    hash: str
    #: The file starts with a byte order mark; it is kept on saving.
    bom: bool
    #: The file is not valid UTF-8: shown, but not to be saved from the text (that would lose bytes).
    readonly: bool
    size: int
    modified: int
    front: Any = None
    tags: list[str]
    lock: LockOut | None = None


def _note_out(file: File, data: bytes, who: Actor) -> NoteOut:
    bom = data.startswith(BOM)
    readonly = False
    try:
        content = data[len(BOM) :].decode("utf-8") if bom else data.decode("utf-8")
    except UnicodeDecodeError:
        content = data.decode("utf-8", errors="replace")
        readonly = True
    with SessionLocal() as db:
        tags = list(db.scalars(select(Tag.tag).where(Tag.file_id == file.id).order_by(Tag.tag_key)))
        lock = vault.lock_state(db, file.id)
        lock_out = None
        if lock is not None:
            lock_out = LockOut(holder=lock.holder_name, mine=lock.holder == who.client, expires_at=lock.expires_at)
    return NoteOut(
        id=file.id, path=file.path, title=file.title, content=content, hash=index.digest(data), bom=bom,
        readonly=readonly, size=len(data), modified=file.mtime_ns // 1_000_000, front=file.front, tags=tags,
        lock=lock_out,
    )


@router.get("/note", response_model=NoteOut)
def note(path: PathQuery, account: Account, who: ActorDep) -> NoteOut:
    need(account, path, READ)
    try:
        file, data = vault.read(path)
    except VaultError as exc:
        raise _fail(exc) from exc
    if not file.is_note:
        raise error("not_a_note", "This file is not a note.")
    return _note_out(file, data, who)


_COPY = re.compile(r"^(.*) \(conflict \d{4}-\d{2}-\d{2} \d{6}\)\.md$")


@router.get("/note/copies")
def note_copies(path: PathQuery, account: Account) -> dict[str, list[str]]:
    """The conflict copies of a note next to it, and for a copy its note: what the note page shows a banner for,
    without reading the whole folder."""
    clean = need(account, path, READ)
    stem = clean[:-3] if clean.lower().endswith(".md") else clean
    found: list[str] = []
    with SessionLocal() as db:
        # A note that is not there answers like one in a space the account may not read.
        if db.scalar(select(File.id).where(File.path == clean, File.deleted_at.is_(None))) is None:
            raise error("not_found", "Not found.", 404)
        prefix = stem + " (conflict "
        for (candidate,) in db.execute(
            select(File.path).where(
                File.deleted_at.is_(None), File.path > prefix, File.path < prefix + "\uffff"
            )
        ):
            if _COPY.match(candidate) and _COPY.match(candidate).group(1) == stem:  # type: ignore[union-attr]
                found.append(candidate)
        original = _COPY.match(clean)
        if original:
            note_path = original.group(1) + ".md"
            if db.scalar(select(File.id).where(File.path == note_path, File.deleted_at.is_(None))) is not None:
                found.append(note_path)
    return {"paths": sorted(found)}


class NoteStateOut(BaseModel):
    hash: str
    modified: int
    lock: LockOut | None = None


@router.get("/note/state", response_model=NoteStateOut)
def note_state(path: PathQuery, account: Account, who: ActorDep) -> NoteStateOut:
    """How a note stands on disk, without its text: an open page asks every few seconds whether to load it again."""
    need(account, path, READ)
    try:
        file, data = vault.read(path)
    except VaultError as exc:
        raise _fail(exc) from exc
    if not file.is_note:
        raise error("not_a_note", "This file is not a note.")
    with SessionLocal() as db:
        lock = vault.lock_state(db, file.id)
        lock_out = None
        if lock is not None:
            lock_out = LockOut(holder=lock.holder_name, mine=lock.holder == who.client, expires_at=lock.expires_at)
    return NoteStateOut(hash=index.digest(data), modified=file.mtime_ns // 1_000_000, lock=lock_out)


class SaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    content: str = Field(max_length=MAX_NOTE_UPLOAD)
    base_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class SaveOut(BaseModel):
    saved: bool
    hash: str
    conflict: str | None = None


@router.put("/note", response_model=SaveOut)
def save(body: SaveIn, account: Account, who: ActorDep) -> SaveOut:
    need(account, body.path, WRITE)
    try:
        _file, current = vault.read(body.path)
    except VaultError as exc:
        raise _fail(exc) from exc
    data = body.content.encode("utf-8")
    if current.startswith(BOM):
        data = BOM + data
    try:
        result = vault.save(body.path, data, base_hash=body.base_hash, actor=who)
    except VaultError as exc:
        raise _fail(exc) from exc
    if result.conflict:
        # The state that caused the conflict, read again: the file may have changed once more since the first read.
        try:
            _file, now = vault.read(body.path)
        except VaultError:
            now = current
        return SaveOut(saved=False, hash=index.digest(now), conflict=result.conflict)
    return SaveOut(saved=result.changed, hash=index.digest(data))


class CreateIn(BaseModel):
    folder: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    title: str = Field(min_length=1, max_length=1024)
    content: str = Field(default="", max_length=MAX_NOTE_UPLOAD)
    #: A template of the same space to start from (M6); its placeholders are filled, ``content`` is then ignored.
    template: str | None = Field(default=None, max_length=paths.MAX_PATH_CHARS)


@router.post("/notes", response_model=NoteOut, status_code=201)
def create_note(body: CreateIn, account: Account, who: ActorDep) -> NoteOut:
    folder = need(account, body.folder, WRITE)
    content = body.content
    if body.template:
        template = need(account, body.template, READ)
        if paths.space_of(template) != paths.space_of(folder):
            raise error("not_found", "Not found.", 404)
        try:
            content = everyday.render(
                template, title=body.title.strip(), when=datetime.now().astimezone(), language=account.language or "en"
            )
        except VaultError as exc:
            raise _fail(exc) from exc
    try:
        file = vault.create_note(body.folder, body.title, content.encode("utf-8"), actor=who)
        file, data = vault.read(file.path)
    except VaultError as exc:
        raise _fail(exc) from exc
    return _note_out(file, data, who)


@router.delete("/files")
def delete(
    path: PathQuery,
    account: Account,
    who: ActorDep,
    along: Annotated[list[str], Query(max_length=500)] = [],  # noqa: B006 - FastAPI copies the default
) -> dict[str, int]:
    """Into the trash; ``along``: files only this note uses that go with it (see ``GET /api/files/own``). A whole
    space goes only by the hand of a manager."""
    clean = need(account, path, WRITE)
    if "/" not in clean:
        need(account, clean, MANAGE)
    try:
        return {"files": vault.delete_path(path, actor=who, along=along)}
    except VaultError as exc:
        raise _fail(exc) from exc


@router.get("/files/own")
def own(path: PathQuery, account: Account) -> dict[str, list[str]]:
    """The files only this note uses: the delete dialog offers them to go along."""
    need(account, path, READ)
    try:
        return {"paths": vault.its_own(path)}
    except VaultError as exc:
        raise _fail(exc) from exc


class MoveIn(BaseModel):
    source: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    destination: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)


@router.post("/move")
def move(body: MoveIn, account: Account, who: ActorDep) -> dict[str, Any]:
    # Moving never crosses spaces (the vault refuses it), so the right in the source covers the destination.
    need(account, body.source, WRITE)
    need(account, body.destination, WRITE)
    try:
        moved = vault.move(body.source, body.destination, actor=who)
    except VaultError as exc:
        raise _fail(exc) from exc
    # Links follow in every space, also where the mover may only read or not even that (a link into a space must
    # not die because its note was renamed). The count names only notes the mover may read: any other would tell
    # that a space they do not know links here.
    readable = readable_spaces(account)
    rewritten = sum(1 for space_id in moved.rewritten_spaces if space_id in readable)
    return {"path": moved.path, "files": moved.files, "rewritten": rewritten}


# --- Links, tags, search, graph -------------------------------------------------------------------------------------


class Outgoing(BaseModel):
    kind: str
    target: str
    subpath: str
    line: int
    path: str | None
    title: str | None


class Backlink(BaseModel):
    path: str
    title: str
    line: int
    kind: str


class LinksOut(BaseModel):
    outgoing: list[Outgoing]
    backlinks: list[Backlink]


def _live_file(db: Any, path: str) -> File:
    try:
        clean = paths.parse(path)
    except paths.PathError as exc:
        raise error(exc.code, str(exc)) from exc
    file = vault.live(db, clean)
    if file is None:
        raise error("not_found", "No such file.", 404)
    return file


@router.get("/links", response_model=LinksOut)
def links(path: PathQuery, account: Account) -> LinksOut:
    # Links can lead into another space (``[[Space/Note]]``): a target there, and a note there that links here, is
    # shown only to whoever may read that space. For anybody else the link leads nowhere, exactly like one whose
    # note does not exist, and the backlink is not there.
    need(account, path, READ)
    readable = readable_spaces(account)
    with SessionLocal() as db:
        file = _live_file(db, path)
        target_file = File.__table__.alias("target")
        outgoing = []
        for kind, target, subpath, line, target_path, target_title, target_space in db.execute(
            select(Link.kind, Link.target, Link.subpath, Link.line, target_file.c.path, target_file.c.title,
                   target_file.c.space_id)
            .outerjoin(target_file, target_file.c.id == Link.target_id)
            .where(Link.source_id == file.id)
            .order_by(Link.line, Link.id)
        ):
            if target_space is not None and target_space not in readable:
                target_path = target_title = None
            outgoing.append(
                Outgoing(kind=kind, target=target, subpath=subpath, line=line, path=target_path, title=target_title)
            )
        backlinks = [
            Backlink(path=source_path, title=title, line=line, kind=kind)
            for source_path, title, line, kind in db.execute(
                select(File.path, File.title, Link.line, Link.kind)
                .join(File, File.id == Link.source_id)
                .where(Link.target_id == file.id, File.deleted_at.is_(None), Link.source_id != file.id,
                       File.space_id.in_(readable))
                .order_by(File.path, Link.line)
            )
        ]
    return LinksOut(outgoing=outgoing, backlinks=backlinks)


@router.get("/tags")
def tags(account: Account, space: Annotated[str | None, Query(max_length=255)] = None) -> list[dict[str, Any]]:
    readable = readable_spaces(account)
    with SessionLocal() as db:
        query = (
            select(func.min(Tag.tag), func.count())
            .join(File, File.id == Tag.file_id)
            .where(File.deleted_at.is_(None), File.space_id.in_(readable))
            .group_by(Tag.tag_key)
            .order_by(func.count().desc(), Tag.tag_key)
        )
        if space:
            query = query.join(Space, Space.id == File.space_id).where(Space.folder == space)
        return [{"tag": tag, "count": count} for tag, count in db.execute(query)]


class Hit(BaseModel):
    path: str
    title: str
    snippet: str


_TERM = re.compile(r"[^\s\"]+")


def fts_query(raw: str) -> str | None:
    """User words as an FTS5 query: every word must occur, each as a prefix. No operator of FTS5 gets through."""
    # A NUL ends a string for SQLite and leaves the quote open: FTS5 answered "unterminated string" with a 500.
    terms = [term.replace('"', "").replace("\x00", "") for term in _TERM.findall(raw)][:12]
    terms = [term for term in terms if term]
    if not terms:
        return None
    return " ".join(f'"{term}"*' for term in terms)


@router.get("/search", response_model=list[Hit])
def search(
    account: Account,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    space: Annotated[str | None, Query(max_length=255)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[Hit]:
    query = fts_query(q)
    if query is None:
        return []
    sql = (
        f"SELECT f.path, f.title, snippet({FTS_TABLE}, 1, :start, :end, '…', 12) "  # noqa: S608
        f"FROM {FTS_TABLE} JOIN files f ON f.id = {FTS_TABLE}.rowid "
        "JOIN spaces s ON s.id = f.space_id "
        f"WHERE {FTS_TABLE} MATCH :query AND f.deleted_at IS NULL "
        "AND f.space_id IN (SELECT value FROM json_each(:spaces)) "
        + ("AND s.folder = :space " if space else "")
        + f"ORDER BY bm25({FTS_TABLE}, 10.0, 1.0) LIMIT :limit"
    )
    values: dict[str, Any] = {
        "query": query, "start": HIT_START, "end": HIT_END, "limit": limit,
        "spaces": json.dumps(sorted(readable_spaces(account))),
    }
    if space:
        values["space"] = space
    with SessionLocal() as db:
        rows = db.execute(text(sql), values).all()
    return [Hit(path=path, title=title, snippet=snippet or "") for path, title, snippet in rows]


class Found(BaseModel):
    path: str
    title: str
    #: With ``source``: the shortest text a wiki link in that note needs to reach this one (the name, or the path
    #: in the space where the name alone leads elsewhere).
    link: str | None = None


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/notes/find", response_model=list[Found])
def find_notes(
    account: Account,
    q: Annotated[str, Query(max_length=200)] = "",
    space: Annotated[str | None, Query(max_length=255)] = None,
    source: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[Found]:
    """Notes by title or file name, for the quick switcher and the suggestions after ``[[``: those that start with
    what was typed first, then those that contain it; nothing typed: the ones changed last. Readable spaces only.
    ``source``: a note being edited; then each result says how to link to it from there, notes of its own space
    come first, and those of another space (readable, like everything here) link with the space's name in front."""
    readable = readable_spaces(account)
    words = q.strip()
    clean = need(account, source, READ) if source else None
    with SessionLocal() as db:
        query = select(File.id, File.path, File.title, File.name_key, File.space_id).where(
            File.is_note.is_(True), File.deleted_at.is_(None), File.space_id.in_(readable)
        )
        if space:
            query = query.join(Space, Space.id == File.space_id).where(Space.folder == space)
        home = paths.space_of(clean) if clean is not None else None
        if home is not None and db.scalar(select(Space.id).where(Space.folder == home)) is None:
            return []
        if not words:
            if home is not None:
                # Nothing typed while writing a link: the notes changed last in the note's own space.
                query = query.where(File.path > home + "/", File.path < home + "0")
            rows = list(db.execute(query.order_by(File.mtime_ns.desc()).limit(limit)).all())
        else:
            folded = paths.fold(words)
            found = db.execute(
                query.where(
                    File.name_key.like(_like(folded), escape="\\") | File.title.like(_like(words), escape="\\")
                ).limit(2000)
            ).all()

            def rank(row: Any) -> tuple[int, int, int, str]:
                starts = row.name_key.startswith(folded) or paths.fold(row.title).startswith(folded)
                elsewhere = home is not None and paths.space_of(row.path) != home
                return (1 if elsewhere else 0, 0 if starts else 1, len(row.title), paths.fold(row.title))

            rows = sorted(found, key=rank)[:limit]
        links: dict[int, str] = {}
        if clean is not None and rows:
            names = index.Names(db, rows[0].space_id, preload=False)
            for row in rows:
                space_name, _, inside = row.path.partition("/")
                inside = inside[:-3]
                name = inside.rsplit("/", 1)[-1]
                if space_name != home:
                    # Into another space: its name in front, the note's name alone where that leads there.
                    name, inside = f"{space_name}/{name}", f"{space_name}/{inside}"
                links[row.id] = name if index.resolve("wiki", name, clean, names) == row.id else inside
    return [Found(path=row.path, title=row.title, link=links.get(row.id)) for row in rows]


# --- Locks ----------------------------------------------------------------------------------------------------------


class LockIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)


@router.post("/locks", response_model=LockOut)
def lock(body: LockIn, account: Account, who: ActorDep) -> LockOut:
    need(account, body.path, WRITE)
    try:
        held = vault.acquire(body.path, who)
    except VaultError as exc:
        raise _fail(exc) from exc
    return LockOut(holder=held.holder_name, mine=True, expires_at=held.expires_at)


@router.delete("/locks", status_code=204)
def unlock(path: PathQuery, account: Account, who: ActorDep) -> None:
    need(account, path, READ)
    try:
        vault.release(path, who)
    except VaultError as exc:
        raise _fail(exc) from exc


# --- Versions -------------------------------------------------------------------------------------------------------


class VersionOut(BaseModel):
    id: int
    path: str
    created_at: datetime
    updated_at: datetime
    source: str
    author: str | None
    size: int


@router.get("/versions", response_model=list[VersionOut])
def versions(path: PathQuery, account: Account) -> list[VersionOut]:
    need(account, path, READ)
    try:
        rows = vault.versions(path)
    except VaultError as exc:
        raise _fail(exc) from exc
    return [
        VersionOut(id=row.id, path=row.path, created_at=row.created_at, updated_at=row.updated_at, source=row.source,
                   author=row.author, size=row.size)
        for row in rows
    ]


@router.get("/versions/{version_id}")
def version(version_id: int, account: Account) -> dict[str, Any]:
    try:
        need(account, _where(vault.version_path, version_id), READ)
        row, data = vault.version_content(version_id)
    except VaultError as exc:
        raise _fail(exc) from exc
    return {"id": row.id, "path": row.path, "content": data.decode("utf-8", errors="replace")}


@router.post("/versions/{version_id}/restore")
def restore_version(version_id: int, account: Account, who: ActorDep) -> dict[str, str]:
    try:
        need(account, _where(vault.version_path, version_id), WRITE)
        file = vault.restore_version(version_id, actor=who)
    except VaultError as exc:
        raise _fail(exc) from exc
    return {"path": file.path}


# --- Trash ----------------------------------------------------------------------------------------------------------


class TrashOut(BaseModel):
    id: str
    path: str
    files: int
    deleted_at: datetime
    how: str
    by: str | None


@router.get("/trash", response_model=list[TrashOut])
def trash(account: Account) -> list[TrashOut]:
    """The trash of every space the account may write in: reading alone does not bring back or remove."""
    return [TrashOut(**entry.__dict__) for entry in vault.trash(readable_spaces(account, WRITE))]


@router.post("/trash/{entry_id}/restore")
def restore_trash(entry_id: TrashId, account: Account, who: ActorDep) -> dict[str, list[str]]:
    try:
        need(account, _where(vault.trash_path, entry_id), WRITE)
        return {"paths": vault.restore_trash(entry_id, actor=who)}
    except VaultError as exc:
        raise _fail(exc) from exc


@router.delete("/trash/{entry_id}")
def purge_trash(entry_id: TrashId, account: Account) -> dict[str, int]:
    try:
        need(account, _where(vault.trash_path, entry_id), WRITE)
        return {"files": vault.purge_trash(entry_id)}
    except VaultError as exc:
        raise _fail(exc) from exc


# --- Index ----------------------------------------------------------------------------------------------------------


@router.get("/index")
def index_status(account: OperatorAccount) -> dict[str, Any]:
    """How far the index is. The operator's: the last pass names every space of the vault."""
    state = index.status
    last = state.last
    return {
        "running": state.running,
        "phase": state.phase,
        "done": state.done,
        "total": state.total,
        "last_at": state.last_at,
        "last": last.__dict__ if last else None,
        "held_back": state.held_back,
    }


@router.get("/index/progress")
def index_progress(account: Account) -> dict[str, Any]:
    """Whether the vault is being read right now, for the notice at the top of the app. Every account asks it; the
    counts, which span every space, only the operator sees, everybody else a share."""
    state = index.status
    if not state.visible:
        return {"running": False}
    total = max(state.total, 1)
    answer: dict[str, Any] = {
        "running": True,
        "phase": state.phase,
        "percent": min(99, state.done * 100 // total) if state.total else None,
    }
    if account.role == OPERATOR:
        answer.update(done=min(state.done, state.total), total=state.total)
    return answer


@router.post("/index/scan")
def index_scan(_operator: OperatorAccount, confirm_deletions: bool = False) -> dict[str, Any]:
    """A full pass now, over every space. ``confirm_deletions``: files the brake held back were deleted on purpose.
    Never a second pass beside a running one: that answers ``scan_running``."""
    try:
        stats = index.scan(confirm_deletions=confirm_deletions, wait=False)
    except index.ScanRunning as exc:
        raise error("scan_running", "The vault is being read already.", 409) from exc
    return stats.__dict__

