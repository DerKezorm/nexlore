"""The index: what the database knows about the files in the vault.

The files are the truth, the index follows them. ``scan`` walks the whole vault and brings the index up to date;
``refresh`` does the same for a handful of paths the watcher reported. Everything that writes a file through
nexlore calls ``record`` right after, so the watcher, seeing the event later, finds nothing to do.

A file keeps its row, and with it its versions and backlinks, when it moves: a file that vanished and one that
appeared with the same content in the same scan are one file that moved (the way Obsidian and Syncthing rename).
A path that comes back after vanishing takes its old row back, so a vault that was briefly not mounted does not
lose its history.

⚠️ The mass-deletion brake: when more than half of a space's files, and more than ``MASS_DELETION_MIN`` of them,
vanish in one scan, the deletion is held back and a warning logged. An unmounted share or a sync client in the
middle of its work looks exactly like that, and the trash is not the place for a whole vault.

All changes to the index run under ``guard``. A long scan takes it batch by batch, so saving a note never waits for
more than one batch.

⚠️ Signing in, reading and saving go on while a scan runs (measured with 20,000 notes: one transaction of the old
scan held SQLite's write lock for 6.6 s, and a sign-in failed with "database is locked"). So a scan writes in short
transactions only: new files ``BATCH`` at a time, links resolved again part by part (``relink``), removals batch by
batch, each with its own commit. And only one scan runs at a time (``scan_lock``): the watcher waits for a full scan
and then finds its paths known; a scan asked for by a person while one runs is refused, not started twice.
"""

from __future__ import annotations

import logging
import os
import posixpath
import threading
import time
import zlib
from collections import defaultdict, deque
from collections.abc import Iterable, Iterator
from concurrent.futures import Executor, ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import Self

from sqlalchemy import bindparam, delete, event, func, insert, inspect, select, text, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import FTS_TABLE, File, Link, Lock, Setting, Space, Tag, Task, Version, utcnow
from . import mdparse, midword, paths
from . import tasks as tasks_service
from .prepare import (
    MAX_NOTE_BYTES,
    Analysis,
    Prepared,
    analyse,
    decode,
    digest,
    name_key,
    prepare,
    target_key,
)

__all__ = ["MAX_NOTE_BYTES", "decode", "digest", "name_key", "target_key"]

logger = logging.getLogger("nexlore.index")


class FairLock:
    """A re-entrant lock that goes to whoever waited longest. Python's own lets the thread that just let go take it
    straight back: measured on a test server with 100,000 notes, a save waited 9.5 s while the scan took the lock for
    one part of its links after the other, each part only 0.3 s long."""

    def __init__(self) -> None:
        self._state = threading.Condition(threading.Lock())
        self._owner: int | None = None
        self._depth = 0
        self._queue: deque[object] = deque()

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        me = threading.get_ident()
        with self._state:
            if self._owner == me:
                self._depth += 1
                return True
            if self._owner is None and not self._queue:
                self._owner, self._depth = me, 1
                return True
            if not blocking:
                return False
            ticket = object()
            self._queue.append(ticket)
            deadline = None if timeout < 0 else time.monotonic() + timeout
            while self._owner is not None or self._queue[0] is not ticket:
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    self._queue.remove(ticket)
                    self._state.notify_all()
                    return False
                self._state.wait(left)
            self._queue.popleft()
            self._owner, self._depth = me, 1
            return True

    def release(self) -> None:
        with self._state:
            if self._owner != threading.get_ident():
                raise RuntimeError("release of a lock not held")
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._state.notify_all()

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


guard = FairLock()
#: One scan at a time, the full one and the watcher's alike.
scan_lock = threading.Lock()

BATCH = 200
READERS = 8
MASS_DELETION_MIN = 50
#: Up to this many changed names, links are re-resolved one query at a time; above, from a table in memory.
SMALL_CHANGE = 64
#: Names (or notes) whose links a big scan resolves again in one transaction.
RELINK_PART = 500
#: From this many files to look at, a scan shows in the interface as "reading the vault".
PROGRESS_MIN = 200


class ScanRunning(Exception):
    """A scan was asked for while another one runs."""


INITIAL = "initial"
APP = "app"
EXTERNAL = "external"
RENAME = "rename"
RESTORE = "restore"
IMPORT = "import"
#: Written by an AI over MCP, directly or as a draft taken over (M7).
MCP = "mcp"
#: Written by a program with an API token (``/api/v1``).
API = "api"
#: Written by a plugin in the browser (M7), with the account of the person using it.
PLUGIN = "plugin"


@dataclass
class ScanStats:
    files: int = 0
    added: int = 0
    changed: int = 0
    removed: int = 0
    moved: int = 0
    revived: int = 0
    held_back: int = 0
    errors: int = 0
    seconds: float = 0.0
    spaces: list[str] = field(default_factory=list)

    @property
    def touched(self) -> int:
        return self.added + self.changed + self.removed + self.moved + self.revived


@dataclass
class Status:
    running: bool = False
    phase: str = ""
    done: int = 0
    total: int = 0
    #: The index knew no file when this scan began: the vault is read for the first time.
    first: bool = False
    #: The last full scan (the watcher's small ones are not what a person asks about).
    last: ScanStats | None = None
    last_at: datetime | None = None
    held_back: dict[str, int] = field(default_factory=dict)

    @property
    def visible(self) -> bool:
        """Worth telling people about: the vault is read for the first time, or many files at once."""
        return self.running and (self.first or self.total >= PROGRESS_MIN)


status = Status()
#: Grows with every file the index takes in or lets go, from wherever the change came: the pages ask for it with the
#: progress and load the tree again when it moved (review P4.9: a file added outside showed only after a reload).
revision = 0


def _changed() -> None:
    global revision
    revision += 1


# --- Names and link resolution -------------------------------------------------------------------------------------


class _Family:
    """The spaces one resolution may reach: their names by folder, and the ``Names`` made so far for each.
    ``preload``: the names of other spaces are loaded whole too (a big change: a scan, a rename with many links).
    Measured on a test server with 100,000 notes and 55,600 links into other spaces: asked row by row, the first scan
    took 171 s instead of 97 s, and a rename that rewrote 1,841 notes 27 s."""

    def __init__(self, db: Session, *, preload: bool = False) -> None:
        self.db = db
        self.preload = preload
        self.names: dict[int, Names] = {}
        self._folders: dict[int, str] | None = None
        self._ids: dict[str, int] = {}

    def _load(self) -> dict[int, str]:
        if self._folders is None:
            self._folders = {space_id: folder for space_id, folder in self.db.execute(select(Space.id, Space.folder))}
            for space_id, folder in sorted(self._folders.items()):
                self._ids.setdefault(paths.fold(folder), space_id)
        return self._folders

    def folder_of(self, space_id: int) -> str | None:
        return self._load().get(space_id)

    def id_of(self, key: str) -> int | None:
        self._load()
        return self._ids.get(key)


class Names:
    """Answers "which file is called so" for one space. Loaded whole for big changes, asked row by row for small.

    A link can lead into another space when written with that space's name in front (``[[Team/Note]]``). The names
    of such a space come from the same family, made when first needed: row by row for a small change (always
    current), loaded whole for a big one (again whenever a file of that space came, went or moved)."""

    def __init__(self, db: Session, space_id: int, *, preload: bool, family: _Family | None = None) -> None:
        self.db = db
        self.space_id = space_id
        self.family = family if family is not None else _Family(db, preload=preload)
        self.family.names.setdefault(space_id, self)
        #: How often the space's names had changed when these were loaded (``renames``).
        self.marker = renames(space_id)
        self._by_path: dict[str, int] | None = None
        self._by_name: dict[str, list[tuple[int, str]]] | None = None
        if preload:
            self._by_path = {}
            self._by_name = {}
            rows = db.execute(
                select(File.id, File.path, File.path_key, File.name_key).where(
                    File.space_id == space_id, File.deleted_at.is_(None)
                )
            )
            for file_id, path, path_key, key in rows:
                self._by_path[path_key] = file_id
                self._by_name.setdefault(key, []).append((file_id, path))

    def by_path(self, path_key: str) -> int | None:
        if self._by_path is not None:
            return self._by_path.get(path_key)
        return self.db.scalar(
            select(File.id).where(
                File.space_id == self.space_id, File.path_key == path_key, File.deleted_at.is_(None)
            ).limit(1)
        )

    def by_name(self, key: str) -> list[tuple[int, str]]:
        if self._by_name is not None:
            return self._by_name.get(key, [])
        rows = self.db.execute(
            select(File.id, File.path).where(
                File.space_id == self.space_id, File.name_key == key, File.deleted_at.is_(None)
            )
        )
        return [(file_id, path) for file_id, path in rows]

    @property
    def folder(self) -> str | None:
        return self.family.folder_of(self.space_id)

    def named(self, key: str) -> Names | None:
        """The names of the space whose folder, casefolded, is ``key``; None when there is no such space."""
        space_id = self.family.id_of(key)
        if space_id is None:
            return None
        found = self.family.names.get(space_id)
        # Loaded whole, another space's names are loaded again once a file there came, went or moved.
        if found is not None and (found is self or not self.family.preload or found.marker == renames(space_id)):
            return found
        fresh = Names(self.db, space_id, preload=self.family.preload, family=self.family)
        self.family.names[space_id] = fresh
        return fresh

    def home(self, space: str) -> Names:
        """The names of the space a note lies in (``space``, its folder): these, or those of its family."""
        if self.family.folder_of(self.space_id) in (space, None):
            return self
        return self.named(paths.fold(space)) or self


def inside(space: str, joined: str) -> str | None:
    normal = posixpath.normpath(joined)
    return normal if normal.startswith(space + "/") else None


def by_path(names: Names, candidate: str | None) -> int | None:
    if candidate is None:
        return None
    found = names.by_path(paths.fold(candidate))
    if found is None and not candidate.lower().endswith(paths.NOTE_SUFFIX):
        found = names.by_path(paths.fold(candidate + paths.NOTE_SUFFIX))
    return found


def _pick(candidates: list[tuple[int, str]], folder: str) -> int | None:
    """Several files of one name: the one in ``folder`` (the note's), else the one nearest the top, else
    alphabetical."""
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][0]
    folder = paths.fold(folder)
    beside = [item for item in candidates if paths.fold(posixpath.dirname(item[1])) == folder]
    if beside:
        return beside[0][0]
    return min(candidates, key=lambda item: (item[1].count("/"), paths.fold(item[1])))[0]


def crossing(kind: str, target: str, source: str) -> tuple[str, str] | None:
    """Where a link written in ``source`` could lead into another space: the first part of its path, casefolded (the
    space's name, if there is such a space), and the rest. None where it cannot: a plain name, a relative wiki link,
    a Markdown path that stays inside the note's space.

    Wiki links name the space in front (``[[Team/Folder/Note]]``). Markdown links do so from the top of the vault
    (``/Team/Note.md``, ``Team/Note.md``, the way Obsidian writes them on a whole vault), or climb out of their space
    (``../../Team/Note.md``)."""
    text_target = target.strip()
    rooted = text_target.startswith("/")
    text_target = text_target.lstrip("/")
    if kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED) and not rooted:
        joined = posixpath.normpath(posixpath.join(posixpath.dirname(source), text_target))
        if not joined.startswith(paths.space_of(source) + "/"):
            text_target = joined
    # A relative wiki link (``./``, ``../``) starts with a dot: never a space's name, it stays in its space.
    first, slash, rest = text_target.partition("/")
    rest = rest.strip("/")
    if not slash or not rest or first in ("", ".", ".."):
        return None
    return paths.fold(first), rest


def via_of(kind: str, target: str, source: str) -> str | None:
    found = crossing(kind, target, source)
    return found[0][:255] if found is not None else None


def resolve(kind: str, target: str, source: str, names: Names) -> int | None:
    """The file a link points at, the way Obsidian finds it: in the space of ``source`` first, then, for a link
    written with the name of another space in front, in that space. ``names`` may be those of any space."""
    return resolve_full(kind, target, source, names)[0]


def resolve_full(kind: str, target: str, source: str, names: Names) -> tuple[int | None, int | None]:
    """``resolve``, plus the space of the target where it lies in another space than ``source`` (else None).

    The space of the note comes first, always: what another space holds, or whether there is one of that name,
    never changes where a link leads that its own space can answer. So a person who may not read the other space
    learns nothing from their own links."""
    space = paths.space_of(source)
    home = names.home(space)
    found = _within(kind, target, source, home)
    if found is not None:
        return found, None
    across = crossing(kind, target, source)
    if across is None or across[0] == paths.fold(space):
        return None, None
    other = home.named(across[0])
    folder = other.folder if other is not None else None
    if other is None or folder is None or other.space_id == home.space_id:
        return None, None
    rest = across[1]
    joined = inside(folder, f"{folder}/{rest}")
    if kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED):
        # A path, read strictly: the way other programs read it.
        found = by_path(other, joined)
    else:
        found = by_path(other, joined)
        if found is None and "/" in rest:
            tail = "/" + paths.fold(rest)
            found = _pick([
                item for item in other.by_name(target_key(rest))
                if paths.fold(item[1]).endswith((tail, tail + paths.NOTE_SUFFIX))
            ], folder)
        elif found is None:
            # ``[[Team/Note]]``: a note of that name anywhere in the space, the one nearest its top.
            found = _pick(other.by_name(target_key(rest)), folder)
    return (found, other.space_id) if found is not None else (None, None)


def _within(kind: str, target: str, source: str, names: Names) -> int | None:
    """The file a link points at, the way Obsidian finds it, within the space of ``source``."""
    space = paths.space_of(source)
    folder = posixpath.dirname(source)
    text_target = target.strip()
    if not text_target:
        return None
    rooted = text_target.startswith("/")
    text_target = text_target.lstrip("/")
    # Obsidian opened on the whole vault (all spaces as one) writes paths that start with the space's own folder.
    with_space = (
        by_path(names, inside(space, space + text_target[len(space) :]))
        if paths.fold(text_target).startswith(paths.fold(space) + "/")
        else None
    )
    if kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED):
        found = None if rooted else by_path(names, inside(space, f"{folder}/{text_target}"))
        found = found or by_path(names, inside(space, f"{space}/{text_target}")) or with_space
        if found is None and "/" not in text_target:
            found = _pick(names.by_name(target_key(text_target)), folder)
        return found
    if text_target.startswith(("./", "../")):
        return by_path(names, inside(space, f"{folder}/{text_target}"))
    if "/" in text_target:
        found = by_path(names, inside(space, f"{space}/{text_target}")) or with_space
        if found is not None:
            return found
        tail = "/" + paths.fold(text_target)
        matching = [
            item for item in names.by_name(target_key(text_target))
            if paths.fold(item[1]).endswith((tail, tail + paths.NOTE_SUFFIX))
        ]
        return _pick(matching, folder)
    return _pick(names.by_name(target_key(text_target)), folder)


# --- Reading and recording files -----------------------------------------------------------------------------------


def ensure_space(db: Session, folder: str) -> Space:
    known: dict[str, Space] = db.info.setdefault("spaces", {})
    space = known.get(folder)
    if space is not None:
        return space
    space = db.scalar(select(Space).where(Space.folder == folder))
    if space is None:
        space = Space(folder=folder)
        db.add(space)
        db.flush()
        logger.info("Space registered id=%s", space.id)
    known[folder] = space
    return space


def add_version(
    db: Session,
    file: File,
    data: bytes,
    *,
    source: str,
    author: str | None = None,
    session: str | None = None,
    bundle_seconds: int = 0,
) -> Version | None:
    """A new version of a note, unless it equals the newest. Saves of one session close together fold into one."""
    newest = db.scalar(
        select(Version)
        .where(Version.file_id == file.id)
        .order_by(Version.updated_at.desc(), Version.id.desc())
        .limit(1)
    )
    hashed = digest(data)
    if newest is not None and newest.hash == hashed:
        return None
    now = utcnow()
    if (
        newest is not None
        and session
        and bundle_seconds
        and newest.session == session
        and newest.source == source
        and (now - newest.updated_at).total_seconds() <= bundle_seconds
    ):
        newest.content = zlib.compress(data, 6)
        newest.hash = hashed
        newest.size = len(data)
        newest.updated_at = now
        newest.path = file.path
        return newest
    version = Version(
        file_id=file.id, path=file.path, created_at=now, updated_at=now, source=source, author=author,
        session=session, hash=hashed, size=len(data), content=zlib.compress(data, 6),
    )
    db.add(version)
    return version


def _clear_note_index(db: Session, file_id: int) -> None:
    db.execute(delete(Link).where(Link.source_id == file_id))
    db.execute(delete(Tag).where(Tag.file_id == file_id))
    db.execute(delete(Task).where(Task.file_id == file_id))
    midword.forget(db, file_id)
    db.execute(text(f"DELETE FROM {FTS_TABLE} WHERE rowid = :id"), {"id": file_id})  # noqa: S608


def _index_content(
    db: Session, file: File, data: bytes, names: Names | None, *, fresh: bool = False, analysis: Analysis | None = None
) -> None:
    """Links, tags and search text of one note, replacing what was there. ``names`` None: links stay unresolved
    for now (a bulk scan resolves them all at the end). Rows go in with plain inserts, not through the ORM: for
    a scan of a whole vault the difference is minutes. ``analysis``: worked out already (a PDF's text)."""
    if not fresh:
        _clear_note_index(db, file.id)
    analysis = analysis or analyse(file.path, data)
    file.title = analysis.title
    file.front = analysis.front
    file.features = analysis.features
    _insert_content(db, file.id, file.space_id, file.path, analysis, names)


@dataclass
class _Rows:
    """The rows of several notes, written with one statement per table."""

    tags: list[dict[str, object]] = field(default_factory=list)
    links: list[dict[str, object]] = field(default_factory=list)
    search: list[dict[str, object]] = field(default_factory=list)
    tasks: list[dict[str, object]] = field(default_factory=list)

    def add(self, file_id: int, space_id: int, rel: str, analysis: Analysis, names: Names | None) -> None:
        self.tags += [
            {"file_id": file_id, "tag_key": key, "tag": tag, "pos": pos} for pos, (key, tag) in enumerate(analysis.tags)
        ]
        for kind, target, subpath, key, line in analysis.links:
            found, found_space = resolve_full(kind, target, rel, names) if names is not None else (None, None)
            self.links.append({
                "source_id": file_id, "space_id": space_id, "kind": kind, "target": target, "subpath": subpath,
                "target_key": key, "line": line, "target_id": found, "target_space_id": found_space,
                "via": via_of(kind, target, rel),
            })
        if analysis.body is not None:
            self.search.append({"id": file_id, "title": analysis.title, "body": analysis.body})
        self.tasks += [task_row(file_id, space_id, task) for task in analysis.tasks]

    def write(self, db: Session) -> None:
        connection = db.connection()
        if self.tags:
            connection.execute(insert(Tag), self.tags)
        if self.links:
            connection.execute(insert(Link), self.links)
        if self.search:
            connection.execute(
                text(f"INSERT INTO {FTS_TABLE}(rowid, title, body) VALUES (:id, :title, :body)"),  # noqa: S608
                self.search,
            )
            midword.add(connection, self.search)
        if self.tasks:
            connection.execute(insert(Task), self.tasks)


def task_row(file_id: int, space_id: int, task: tasks_service.Task) -> dict[str, object]:
    return {
        "file_id": file_id, "space_id": space_id, "line": task.line, "raw": task.raw, "status": task.status,
        "mark": task.mark[:4], "text": task.text, "due": task.due, "scheduled": task.scheduled, "start": task.start,
        "completed": task.completed, "priority": task.priority, "recurrence": task.recurrence,
        "tags": " ".join(task.tags)[:1000],
        "tag_keys": (" " + " ".join(paths.fold(tag) for tag in task.tags) + " ")[:1000] if task.tags else "",
    }


def _insert_content(
    db: Session, file_id: int, space_id: int, rel: str, analysis: Analysis, names: Names | None
) -> None:
    rows = _Rows()
    rows.add(file_id, space_id, rel, analysis, names)
    rows.write(db)


def bulk_add(db: Session, items: list[Prepared]) -> list[tuple[int, int, str, str]]:
    """New files, prepared elsewhere, in one go: plain inserts, links left unresolved for the caller.
    Returns (id, space_id, name_key, rel) for each."""
    _changed()
    if not items:
        return []
    now = utcnow()
    rows = []
    for item in items:
        space = ensure_space(db, paths.space_of(item.rel))
        rows.append({
            "space_id": space.id, "path": item.rel, "path_key": paths.fold(item.rel), "name_key": name_key(item.rel),
            "is_note": paths.is_note(item.rel), "title": item.analysis.title, "size": item.size,
            "mtime_ns": item.mtime_ns, "hash": item.hash, "front": item.analysis.front,
            "features": item.analysis.features, "indexed_at": now,
        })
    connection = db.connection()
    ids = connection.execute(insert(File).returning(File.id, sort_by_parameter_order=True), rows).scalars().all()
    versions = []
    content = _Rows()
    for file_id, row, item in zip(ids, rows, items, strict=True):
        content.add(file_id, row["space_id"], item.rel, item.analysis, None)
        if item.compressed is not None:
            versions.append({
                "file_id": file_id, "path": item.rel, "created_at": now, "updated_at": now, "source": INITIAL,
                "author": None, "session": None, "hash": item.hash, "size": item.size, "content": item.compressed,
            })
    content.write(db)
    if versions:
        connection.execute(insert(Version), versions)
    from . import graphstore  # the graph imports the index's models; imported here, when first needed

    for space_id in {row["space_id"] for row in rows}:
        graphstore.touch(space_id)
        renamed(space_id)
    return [(file_id, row["space_id"], row["name_key"], row["path"]) for file_id, row in zip(ids, rows, strict=True)]


def record(
    db: Session,
    rel: str,
    data: bytes,
    stat: os.stat_result,
    *,
    source: str,
    author: str | None = None,
    session: str | None = None,
    bundle_seconds: int = 0,
    file: File | None = None,
    names: Names | None = None,
    resolve_links: bool = True,
    known_new: bool = False,
    prepared: Prepared | None = None,
) -> File:
    """Bring the row of one file in line with ``data``, which is what is on disk now. Returns the row.

    ``resolve_links`` False leaves the note's links unresolved; the caller resolves a whole space at the end.
    ``known_new``: the caller knows there is no row yet, which saves the lookup. ``prepared``: the file was read
    and hashed already (a large attachment is never held in memory whole); ``data`` is then not looked at."""
    _changed()
    if prepared is None and not paths.is_note(rel) and not data:
        # A file that is not a note, handed over without its bytes: read and hash it here, piece by piece.
        prepared = prepare(str(paths.vault_root()), rel)
    space = ensure_space(db, paths.space_of(rel))
    if file is None and not known_new:
        file = db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))
    fresh = file is None
    if file is None:
        file = File(space_id=space.id, path=rel)
        db.add(file)
    file.space_id = space.id
    file.path = rel
    file.path_key = paths.fold(rel)
    file.name_key = name_key(rel)
    file.is_note = paths.is_note(rel)
    file.size = stat.st_size
    file.mtime_ns = stat.st_mtime_ns
    file.hash = prepared.hash if prepared is not None else digest(data)
    file.indexed_at = utcnow()
    db.flush()
    if names is None and resolve_links:
        names = Names(db, space.id, preload=False)
    analysis = prepared.analysis if prepared is not None else None
    _index_content(db, file, data, names if resolve_links else None, fresh=fresh, analysis=analysis)
    if file.is_note:
        if fresh:
            now = utcnow()
            db.connection().execute(
                insert(Version),
                [{
                    "file_id": file.id, "path": rel, "created_at": now, "updated_at": now, "source": source,
                    "author": author, "session": session, "hash": file.hash, "size": len(data),
                    "content": zlib.compress(data, 6),
                }],
            )
        else:
            add_version(db, file, data, source=source, author=author, session=session, bundle_seconds=bundle_seconds)
    return file


def forget(db: Session, file: File, *, how: str, by: str | None = None, group: str | None = None) -> None:
    """A file is gone: into the trash with it. Its links, tags and search text go, its versions stay."""
    _changed()
    _clear_note_index(db, file.id)
    db.execute(delete(Lock).where(Lock.file_id == file.id))
    file.deleted_at = utcnow()
    file.deleted_how = how
    file.deleted_by = by
    file.trash_group = group


def reresolve(
    db: Session, space_id: int, keys: Iterable[str] | None, *, sources: set[int] | None = None,
    names: Names | None = None,
) -> int:
    """Look at every link again whose target has one of these names, and at every link of these notes;
    ``keys`` None: at every link of the space. Links of other spaces written with this space's name in front
    (``[[Space/Note]]``) are looked at the same way. ``names``: the space's names, loaded already. Returns how many
    changed their target."""
    wanted = None if keys is None else {key for key in keys if key}
    sources = sources or set()
    if wanted is not None and not wanted and not sources:
        return 0
    big = wanted is None or len(wanted) + len(sources) > SMALL_CHANGE
    names = names or Names(db, space_id, preload=big)
    base = select(Link.id, Link.kind, Link.target, Link.target_id, Link.target_space_id, File.path).join(
        File, File.id == Link.source_id
    )
    own = base.where(Link.space_id == space_id)
    folder = names.folder
    across = base.where(Link.via == paths.fold(folder)[:255], Link.space_id != space_id) if folder else None
    rows: dict[int, tuple[str, str, int | None, int | None, str]] = {}
    if wanted is None:
        queries = [own] + ([across] if across is not None else [])
    else:
        queries = [own.where(Link.target_key.in_(part)) for part in _chunks(sorted(wanted), 500)]
        if across is not None:
            queries += [across.where(Link.target_key.in_(part)) for part in _chunks(sorted(wanted), 500)]
        queries += [own.where(Link.source_id.in_(part)) for part in _chunks(sorted(sources), 500)]
    for query in queries:
        for link_id, kind, target, current, current_space, source in db.execute(query):
            rows[link_id] = (kind, target, current, current_space, source)
    changes: list[dict[str, int | None]] = []
    for link_id, (kind, target, current, current_space, source) in rows.items():
        found, found_space = resolve_full(kind, target, source, names)
        if found != current or found_space != current_space:
            changes.append({"link_id": link_id, "found": found, "found_space": found_space})
    if changes:
        statement = update(Link).where(Link.id == bindparam("link_id")).values(
            target_id=bindparam("found"), target_space_id=bindparam("found_space")
        )
        db.connection().execute(statement, changes)
    return len(changes)


_renames_lock = threading.Lock()
_renames: dict[int, int] = defaultdict(int)
#: What a link can be resolved by: a file that comes, goes or moves changes the names of its space; a save does not.
_NAME_FIELDS = ("path", "path_key", "name_key", "space_id", "deleted_at")


def renamed(space_id: int) -> None:
    with _renames_lock:
        _renames[space_id] += 1


def renames(space_id: int) -> int:
    """How often the names of a space changed since the start: ``relink`` loads them again only then."""
    return _renames[space_id]


@event.listens_for(Session, "after_flush")
def _count_renames(session: Session, _context: object) -> None:
    for item in (*session.new, *session.deleted):
        if isinstance(item, File) and item.space_id is not None:
            renamed(item.space_id)
    for item in session.dirty:
        if not isinstance(item, File):
            continue
        state = inspect(item)
        for name in _NAME_FIELDS:
            history = state.attrs[name].history
            if history.has_changes():
                for space_id in {item.space_id, *(value for value in history.deleted if name == "space_id")}:
                    if space_id is not None:
                        renamed(space_id)
                break


def relink(space_id: int, keys: set[str], sources: set[int], *, progress: bool = True) -> int:
    """``reresolve`` for a big scan, part by part, each part under ``guard`` and in a transaction of its own: saving
    waits for one part at most, and nobody waits for SQLite's write lock for long. The names of the space are loaded
    once and again only when a file of the space came, went or moved in between (``renames``): measured on Windows
    with 100,000 notes, loading them again for every save made a part hold the lock 2.3 s. ``progress`` False: not
    part of a scan, the scan's count is left alone (a move ends with this)."""
    parts: list[tuple[list[str], set[int]]] = [(part, set()) for part in _chunks(sorted(keys), RELINK_PART)]
    parts += [([], set(part)) for part in _chunks(sorted(sources), RELINK_PART)]
    names: Names | None = None
    marker = -1
    changed = 0
    for part_keys, part_sources in parts:
        with guard, SessionLocal() as db:
            now = renames(space_id)
            if names is None or now != marker:
                names = Names(db, space_id, preload=True)
                marker = now
            changed += reresolve(db, space_id, part_keys, sources=part_sources, names=names)
            db.commit()
        if progress:
            status.done += len(part_keys) + len(part_sources)
    return changed


# --- Walking the vault ---------------------------------------------------------------------------------------------


def _walk(directory: Path, root: Path) -> Iterator[tuple[str, os.stat_result]]:
    try:
        entries = list(os.scandir(directory))
    except OSError as exc:
        logger.warning("Cannot read a folder in the vault: %s", exc.strerror)
        return
    for entry in entries:
        if paths.is_hidden(entry.name):
            continue
        try:
            if entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
                continue
            if entry.is_dir(follow_symlinks=False):
                yield from _walk(Path(entry.path), root)
            elif entry.is_file(follow_symlinks=False):
                yield paths.relative(Path(entry.path), root=root), entry.stat(follow_symlinks=False)
        except OSError:
            continue


def spaces_on_disk(root: Path) -> list[str]:
    found = []
    try:
        entries = list(os.scandir(root))
    except OSError:
        return []
    for entry in entries:
        if paths.is_hidden(entry.name) or entry.is_symlink():
            continue
        if entry.is_dir(follow_symlinks=False):
            found.append(paths.relative(Path(entry.path), root=root))
    return sorted(found)


def _read(root: Path, rel: str) -> tuple[bytes, os.stat_result] | None:
    path = root.joinpath(*rel.split("/"))
    try:
        with open(path, "rb") as handle:
            data = handle.read()
            stat = os.fstat(handle.fileno())
        return data, stat
    except OSError:
        return None


#: From this many files on, a scan reads and parses in worker processes; below, starting them costs more than it saves.
POOL_MIN = 1000
POOL_MAX = 4


def _workers(count: int) -> int:
    if count < POOL_MIN:
        return 1
    return max(1, min(POOL_MAX, (os.cpu_count() or 2) - 1))


def _chunks[T](items: list[T], size: int) -> Iterator[list[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def scan(
    *, root: Path | None = None, only: set[str] | None = None, confirm_deletions: bool = False, wait: bool = True
) -> ScanStats:
    """Bring the index in line with the disk. ``only``: vault-relative paths the watcher saw; else everything.
    Another scan running: waits for it, or with ``wait`` False raises ``ScanRunning``."""
    root = root or paths.vault_root()
    if not scan_lock.acquire(blocking=wait):
        raise ScanRunning
    try:
        return _scan_alone(root, only, confirm_deletions)
    finally:
        scan_lock.release()


def _scan_alone(root: Path, only: set[str] | None, confirm_deletions: bool) -> ScanStats:
    stats = ScanStats()
    began = time.monotonic()
    if not root.is_dir():
        logger.warning("The vault folder is missing, nothing indexed")
        return stats
    with SessionLocal() as db:
        status.first = db.scalar(select(File.id).limit(1)) is None
    status.running = True
    status.phase = "walking"
    status.done = 0
    status.total = 0
    try:
        _scan(root, only, stats, confirm_deletions)
    finally:
        stats.seconds = round(time.monotonic() - began, 3)
        status.running = False
        status.phase = ""
        status.first = False
        if only is None:
            status.last = stats
            status.last_at = utcnow()
    level = logging.INFO if stats.touched or stats.held_back or stats.errors else logging.DEBUG
    logger.log(
        level,
        "Index scan files=%s added=%s changed=%s moved=%s revived=%s removed=%s held_back=%s errors=%s seconds=%s",
        stats.files, stats.added, stats.changed, stats.moved, stats.revived, stats.removed, stats.held_back,
        stats.errors, stats.seconds,
    )
    return stats


def _scan(root: Path, only: set[str] | None, stats: ScanStats, confirm_deletions: bool = False) -> None:
    on_disk: dict[str, os.stat_result] = {}
    if only is None:
        space_folders = spaces_on_disk(root)
        # The spaces first: walking a big vault takes a while, and meanwhile the sidebar shows them already.
        with guard, SessionLocal() as db:
            for folder in space_folders:
                ensure_space(db, folder)
            db.commit()
        for folder in space_folders:
            for rel, stat in _walk(root / folder, root):
                on_disk[rel] = stat
    else:
        space_folders = sorted({paths.space_of(rel) for rel in only if "/" in rel})
        for rel in only:
            if "/" not in rel:
                continue
            try:
                full = paths.resolve(rel, root=root)
                stat = full.stat()
            except (OSError, paths.PathError):
                continue
            if full.is_file() and not full.is_symlink():
                on_disk[rel] = stat
    stats.files = len(on_disk)
    stats.spaces = space_folders

    with guard, SessionLocal() as db:
        for folder in space_folders:
            if (root / folder).is_dir():
                ensure_space(db, folder)
        db.commit()
        query = select(File.id, File.path, File.size, File.mtime_ns, File.hash, File.space_id).where(
            File.deleted_at.is_(None)
        )
        if only is not None and len(only) <= 500:
            query = query.where(File.path.in_(list(only)))
        known = {row.path: row for row in db.execute(query) if only is None or row.path in only}
        spaces = {space.id: space.folder for space in db.scalars(select(Space))}

    candidates = [
        rel for rel, stat in on_disk.items()
        if rel not in known or known[rel].size != stat.st_size or known[rel].mtime_ns != stat.st_mtime_ns
    ]
    gone = [rel for rel in known if rel not in on_disk]

    # The brake: a space that loses most of its files at once is probably not mounted or mid-sync.
    held: dict[str, int] = {}
    # Confirmed by a person (the files were deleted on purpose): the brake stays off for this one scan.
    if only is None and gone and not confirm_deletions:
        with SessionLocal() as db:
            rows = db.execute(
                select(File.space_id, func.count()).where(File.deleted_at.is_(None)).group_by(File.space_id)
            )
            per_space = {space_id: count for space_id, count in rows}
        losing: dict[int, int] = {}
        for rel in gone:
            losing[known[rel].space_id] = losing.get(known[rel].space_id, 0) + 1
        for space_id, count in losing.items():
            if count > MASS_DELETION_MIN and count * 2 > per_space.get(space_id, 0):
                held[spaces.get(space_id, "?")] = count
        if held:
            gone = [rel for rel in gone if spaces.get(known[rel].space_id) not in held]
            stats.held_back = sum(held.values())
            logger.warning(
                "Index scan held back deleting files=%s spaces=%s: most of a space vanished at once",
                stats.held_back, len(held),
            )
    if only is None:
        status.held_back = held

    status.phase = "indexing"
    status.total = len(candidates)
    status.done = 0
    changed_keys: dict[int, set[str]] = {}
    arrived: dict[str, list[str]] = {}  # hash -> new paths, for moves
    # Many files: their links are resolved in one go per space at the end, from a table in memory.
    bulk = len(candidates) > SMALL_CHANGE
    unlinked: dict[int, set[int]] = {}
    # Paths that went away from the outside earlier: one of them coming back takes its old row.
    new_paths = [rel for rel in candidates if rel not in known]
    with SessionLocal() as db:
        query = select(File.path).where(File.deleted_at.is_not(None), File.deleted_how == EXTERNAL)
        if len(new_paths) <= 500:
            query = query.where(File.path.in_(new_paths))
        trashed = set(db.scalars(query)) & set(new_paths)

    # Reading and taking apart runs beside the database work: in processes for a big scan (parsing is Python and
    # holds the interpreter lock), in threads for a small one (opening a file waits on the disk, and on Windows on
    # the virus scanner, measured at 5 to 10 ms for every file it has not seen).
    workers = _workers(len(candidates))
    executor: Executor = (
        ProcessPoolExecutor(max_workers=workers) if workers > 1 else ThreadPoolExecutor(max_workers=READERS)
    )
    work = partial(prepare, str(root))
    touched: dict[int, set[int]] = {}  # space -> notes whose links are still unresolved
    try:
        chunks = list(_chunks(sorted(candidates), BATCH))
        pending = executor.map(work, chunks[0], chunksize=16) if chunks else iter(())
        for position, chunk in enumerate(chunks):
            try:
                results = list(pending)
            except BrokenProcessPool:
                # A worker died (out of memory, killed): the rest of the scan reads in threads, slower but sure.
                logger.warning("Index workers stopped, the scan goes on in threads")
                executor.shutdown(wait=False, cancel_futures=True)
                executor = ThreadPoolExecutor(max_workers=READERS)
                results = list(executor.map(work, chunk))
            # The next chunk is read while this one is written.
            if position + 1 < len(chunks):
                pending = executor.map(work, chunks[position + 1], chunksize=16)
            fresh: list[Prepared] = []
            with guard, SessionLocal() as db:
                for rel, item in zip(chunk, results, strict=True):
                    if item is None:
                        stats.errors += 1
                        continue
                    row = known.get(rel)
                    if row is not None and row.hash == item.hash:
                        db.execute(
                            update(File).where(File.id == row.id).values(size=item.size, mtime_ns=item.mtime_ns)
                        )
                        continue
                    if row is None and rel not in trashed:
                        fresh.append(item)
                        continue
                    if paths.is_note(rel):
                        read = _read(root, rel)
                        if read is None:
                            stats.errors += 1
                            continue
                        data, stat = read
                        ready = None
                    else:
                        # Read already (a PDF for its text, anything else hashed piece by piece): only its state.
                        try:
                            stat = os.stat(root.joinpath(*rel.split("/")))
                        except OSError:
                            stats.errors += 1
                            continue
                        data, ready = b"", item
                    if row is not None:
                        file = record(db, rel, data, stat, source=EXTERNAL, file=db.get(File, row.id),
                                      resolve_links=not bulk, prepared=ready)
                        stats.changed += 1
                    else:
                        file = record(db, rel, data, stat, source=EXTERNAL, file=_revive(db, rel),
                                      resolve_links=not bulk, prepared=ready)
                        stats.revived += 1
                        changed_keys.setdefault(file.space_id, set()).add(file.name_key)
                    if bulk:
                        touched.setdefault(file.space_id, set()).add(file.id)
                if fresh:
                    # The app may have recorded the same new files meanwhile (a note made while this read): known now.
                    taken = set(db.scalars(select(File.path).where(
                        File.deleted_at.is_(None), File.path.in_([item.rel for item in fresh])
                    )))
                    fresh = [item for item in fresh if item.rel not in taken]
                for file_id, space_id, key, _rel in bulk_add(db, fresh):
                    stats.added += 1
                    changed_keys.setdefault(space_id, set()).add(key)
                    touched.setdefault(space_id, set()).add(file_id)
                for item in fresh:
                    arrived.setdefault(item.hash, []).append(item.rel)
                db.commit()
            status.done += len(chunk)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
    for space_id, ids in touched.items():
        unlinked.setdefault(space_id, set()).update(ids)

    if gone:
        status.phase = "removing"
        # A move only when it is unambiguous: exactly one file of this content vanished and exactly one appeared,
        # in the same space. Two empty daily notes, or two notes from one template, are not one note that moved.
        vanished: dict[tuple[str, str], int] = {}
        for rel in gone:
            key = (known[rel].hash, paths.space_of(rel))
            vanished[key] = vanished.get(key, 0) + 1
        status.total = len(gone)
        status.done = 0
        for part in _chunks(gone, BATCH):
            with guard, SessionLocal() as db:
                for rel in part:
                    row = known[rel]
                    file = db.get(File, row.id)
                    if file is None or file.deleted_at is not None or file.path != rel:
                        continue  # changed meanwhile (a save moved or deleted it): no longer this scan's
                    twins = [
                        new for new in arrived.get(row.hash, [])
                        if paths.space_of(new) == paths.space_of(rel)
                    ]
                    changed_keys.setdefault(file.space_id, set()).add(file.name_key)
                    if len(twins) == 1 and vanished[(row.hash, paths.space_of(rel))] == 1:
                        # Moved: the new row takes over the old one's history, the old row keeps the id.
                        new_rel = twins.pop(0)
                        arrived[row.hash].remove(new_rel)
                        if _merge_move(db, file, new_rel):
                            stats.moved += 1
                            stats.added -= 1
                            continue
                    forget(db, file, how=EXTERNAL)
                    stats.removed += 1
                db.commit()
            status.done += len(part)

    if changed_keys or unlinked:
        status.phase = "linking"
        spaces_to_link = sorted(set(unlinked) | set(changed_keys))
        status.total = sum(len(changed_keys.get(s, ())) + len(unlinked.get(s, ())) for s in spaces_to_link)
        status.done = 0
        for space_id in spaces_to_link:
            keys = changed_keys.get(space_id, set())
            sources = unlinked.get(space_id, set())
            if len(keys) + len(sources) > SMALL_CHANGE:
                relink(space_id, keys, sources)
                continue
            with guard, SessionLocal() as db:
                reresolve(db, space_id, keys, sources=sources)
                db.commit()


def _revive(db: Session, rel: str) -> File | None:
    """A path that vanished from the outside and is back: the old row, so history and backlinks return with it."""
    file = db.scalar(
        select(File)
        .where(File.path == rel, File.deleted_at.is_not(None), File.deleted_how == EXTERNAL)
        .order_by(File.deleted_at.desc())
        .limit(1)
    )
    if file is None:
        return None
    file.deleted_at = None
    file.deleted_how = None
    file.deleted_by = None
    file.trash_group = None
    db.flush()
    return file


def _merge_move(db: Session, old: File, new_rel: str) -> bool:
    """``old`` moved to ``new_rel``, where the scan has just made a fresh row: fold the fresh row into the old one.
    False when that row is gone meanwhile (moved or deleted again between two parts of the scan)."""
    fresh = db.scalar(select(File).where(File.path == new_rel, File.deleted_at.is_(None)))
    if fresh is None:
        return False
    fresh_id = fresh.id
    _clear_note_index(db, fresh_id)
    db.execute(delete(Version).where(Version.file_id == fresh_id))
    db.execute(update(Link).where(Link.target_id == fresh_id).values(target_id=old.id))
    db.delete(fresh)
    db.flush()
    old.path = new_rel
    old.path_key = paths.fold(new_rel)
    old.name_key = name_key(new_rel)
    old.space_id = ensure_space(db, paths.space_of(new_rel)).id
    if not paths.is_note(new_rel):
        # Same content (that is how the move was recognised): only its place and state change, it is not hashed again
        # while every save waits for this lock.
        full = paths.vault_root().joinpath(*new_rel.split("/"))
        if full.exists():
            stat = full.stat()
            old.size, old.mtime_ns, old.is_note = stat.st_size, stat.st_mtime_ns, False
            old.title = paths.stem(new_rel)
            old.indexed_at = utcnow()
            # A PDF's text stays searchable; its title in the search follows the new name.
            midword.retitle(db, old.id, old.title)
            db.execute(
                text(f"UPDATE {FTS_TABLE} SET title = :title WHERE rowid = :id"),  # noqa: S608
                {"title": old.title, "id": old.id},
            )
        return True
    data = _read(paths.vault_root(), new_rel)
    if data is not None:
        record(db, new_rel, data[0], data[1], source=RENAME, file=old)
    return True


#: Set once the tasks of a database indexed before M6 were filled in.
TASKS_FILLED = "tasks_filled"


def fill_tasks() -> int:
    """Once, for a database indexed before tasks were (M6): the tasks of every note that has any, from its newest
    version, which is what the file holds (a scan reads unchanged files never again). In parts, each under
    ``guard``; a note indexed meanwhile has its tasks already. Interrupted (a restart), it goes on next time: done
    is noted only at the end. Returns how many notes got theirs."""
    with SessionLocal() as db:
        if db.get(Setting, TASKS_FILLED) is not None:
            return 0
        # Every note that has tasks and no rows yet; notes indexed meanwhile (or before a restart) are skipped below.
        # Not "any task row at all": one note saved before this ran would end the filling for the whole vault.
        ids = list(db.scalars(
            select(File.id).where(
                File.is_note.is_(True), File.deleted_at.is_(None),
                func.coalesce(func.json_extract(File.features, "$.tasks"), 0) > 0,
            ).order_by(File.id)
        ))
    filled = 0
    for part in _chunks(ids, BATCH):
        with guard, SessionLocal() as db:
            rows = _Rows()
            having = set(db.scalars(select(Task.file_id).where(Task.file_id.in_(part)).distinct()))
            for file in db.scalars(select(File).where(File.id.in_(part), File.deleted_at.is_(None))):
                if file.id in having:
                    continue
                newest = db.scalar(
                    select(Version.content).where(Version.file_id == file.id)
                    .order_by(Version.updated_at.desc(), Version.id.desc()).limit(1)
                )
                if newest is None:
                    continue
                rows.tasks += [task_row(file.id, file.space_id, task) for task in
                               analyse(file.path, zlib.decompress(newest)).tasks]
                filled += 1
            rows.write(db)
            db.commit()
    with SessionLocal() as db:
        db.merge(Setting(key=TASKS_FILLED, value=True))
        db.commit()
    if filled:
        logger.info("Tasks filled in for notes indexed before notes=%s", filled)
    return filled


#: Set once the links of a database indexed before links could cross spaces know where they could cross.
VIA_FILLED = "links_via_filled"
VIA_PART = 2000


def fill_via() -> int:
    """Once, for a database indexed before links could lead into another space: every link with a path gets its
    ``via``, and those that lead nowhere in their own space but into another one get their target there. In parts
    by id, each under ``guard``; done is noted only at the end. Returns how many links found a target."""
    with SessionLocal() as db:
        if db.get(Setting, VIA_FILLED) is not None:
            return 0
        top = db.scalar(select(func.max(Link.id))) or 0
    found = 0
    for start in range(0, top + 1, VIA_PART):
        with guard, SessionLocal() as db:
            rows = db.execute(
                select(Link.id, Link.kind, Link.target, Link.target_id, File.path, File.space_id)
                .join(File, File.id == Link.source_id)
                .where(Link.id >= start, Link.id < start + VIA_PART, Link.target.like("%/%"), Link.via.is_(None))
            ).all()
            # Names of any space: each link finds those of its own space and of the one it names in the same family.
            names: Names | None = None
            changes: list[dict[str, object]] = []
            for link_id, kind, target, current, source, space_id in rows:
                via = via_of(kind, target, source)
                if via is None:
                    continue
                change: dict[str, object] = {"link_id": link_id, "via": via, "found": current, "found_space": None}
                if current is None:
                    names = names or Names(db, space_id, preload=False)
                    hit, hit_space = resolve_full(kind, target, source, names)
                    if hit is not None:
                        change.update(found=hit, found_space=hit_space)
                        found += 1
                changes.append(change)
            if changes:
                db.connection().execute(
                    update(Link).where(Link.id == bindparam("link_id")).values(
                        via=bindparam("via"), target_id=bindparam("found"), target_space_id=bindparam("found_space")
                    ),
                    changes,
                )
            db.commit()
    with SessionLocal() as db:
        db.merge(Setting(key=VIA_FILLED, value=True))
        db.commit()
    if found:
        logger.info("Links into other spaces found for links indexed before links=%s", found)
    return found


def refresh(rels: Iterable[str]) -> ScanStats:
    """The watcher's way in: only these paths. A folder among them means everything below it."""
    root = paths.vault_root()
    wanted: set[str] = set()
    folders: list[str] = []
    for rel in rels:
        try:
            clean = paths.parse(rel)
        except paths.PathError:
            continue
        full = root.joinpath(*clean.split("/"))
        wanted.add(clean)
        if full.is_dir():
            folders.append(clean)
            for found, _stat in _walk(full, root):
                wanted.add(found)
        elif not full.exists():
            # Gone: a file, or a folder moved away in one piece (then only the folder has an event).
            folders.append(clean)
    if folders:
        with SessionLocal() as db:
            for folder in folders:
                wanted.update(
                    db.scalars(
                        select(File.path).where(
                            File.deleted_at.is_(None), File.path > folder + "/", File.path < folder + "0"
                        )
                    )
                )
    if not wanted:
        return ScanStats()
    return scan(root=root, only=wanted)
