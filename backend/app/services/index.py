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
"""

from __future__ import annotations

import hashlib
import logging
import os
import posixpath
import threading
import time
import zlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import FTS_TABLE, File, Link, Lock, Space, Tag, Version, utcnow
from . import mdparse, paths

logger = logging.getLogger("nexlore.index")

guard = threading.RLock()

#: A note larger than this is kept and versioned, but not read for links, tags and search.
MAX_NOTE_BYTES = 5 * 1024 * 1024
BATCH = 400
MASS_DELETION_MIN = 50
#: Up to this many changed names, links are re-resolved one query at a time; above, from a table in memory.
SMALL_CHANGE = 64

INITIAL = "initial"
APP = "app"
EXTERNAL = "external"
RENAME = "rename"
RESTORE = "restore"
IMPORT = "import"


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
    last: ScanStats | None = None
    last_at: datetime | None = None
    held_back: dict[str, int] = field(default_factory=dict)


status = Status()


# --- Names and link resolution -------------------------------------------------------------------------------------


def name_key(rel: str) -> str:
    return paths.fold(paths.stem(rel))


def target_key(target: str) -> str:
    last = target.rstrip("/").rsplit("/", 1)[-1]
    if last.lower().endswith(paths.NOTE_SUFFIX):
        last = last[: -len(paths.NOTE_SUFFIX)]
    return paths.fold(last)


class Names:
    """Answers "which file is called so" for one space. Loaded whole for big changes, asked row by row for small."""

    def __init__(self, db: Session, space_id: int, *, preload: bool) -> None:
        self.db = db
        self.space_id = space_id
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


def _pick(candidates: list[tuple[int, str]], source: str) -> int | None:
    """Several files of one name: the one next to the note, else the one nearest the top, else alphabetical."""
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][0]
    folder = paths.fold(posixpath.dirname(source))
    beside = [item for item in candidates if paths.fold(posixpath.dirname(item[1])) == folder]
    if beside:
        return beside[0][0]
    return min(candidates, key=lambda item: (item[1].count("/"), paths.fold(item[1])))[0]


def resolve(kind: str, target: str, source: str, names: Names) -> int | None:
    """The file a link points at, the way Obsidian finds it, within the space of ``source``."""
    space = paths.space_of(source)
    folder = posixpath.dirname(source)
    text_target = target.strip()
    if not text_target:
        return None
    rooted = text_target.startswith("/")
    text_target = text_target.lstrip("/")
    if kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED):
        found = None if rooted else by_path(names, inside(space, f"{folder}/{text_target}"))
        found = found or by_path(names, inside(space, f"{space}/{text_target}"))
        if found is None and "/" not in text_target:
            found = _pick(names.by_name(target_key(text_target)), source)
        return found
    if text_target.startswith(("./", "../")):
        return by_path(names, inside(space, f"{folder}/{text_target}"))
    if "/" in text_target:
        found = by_path(names, inside(space, f"{space}/{text_target}"))
        if found is not None:
            return found
        tail = "/" + paths.fold(text_target)
        matching = [
            item for item in names.by_name(target_key(text_target))
            if paths.fold(item[1]).endswith((tail, tail + paths.NOTE_SUFFIX))
        ]
        return _pick(matching, source)
    return _pick(names.by_name(target_key(text_target)), source)


# --- Reading and recording files -----------------------------------------------------------------------------------


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode(data: bytes) -> str:
    return data.decode("utf-8-sig", errors="replace")


def ensure_space(db: Session, folder: str) -> Space:
    space = db.scalar(select(Space).where(Space.folder == folder))
    if space is None:
        space = Space(folder=folder)
        db.add(space)
        db.flush()
        logger.info("Space registered id=%s", space.id)
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
    db.execute(text(f"DELETE FROM {FTS_TABLE} WHERE rowid = :id"), {"id": file_id})  # noqa: S608


def _index_content(db: Session, file: File, data: bytes, names: Names | None) -> None:
    """Links, tags and search text of one note, replacing what was there."""
    _clear_note_index(db, file.id)
    file.front = None
    file.features = None
    file.title = paths.stem(file.path)
    if not file.is_note:
        return
    if len(data) > MAX_NOTE_BYTES:
        file.features = {"too_large": 1}
        return
    content = decode(data)
    parsed = mdparse.parse(content)
    file.front = _jsonable(parsed.front) if parsed.front else None
    features = dict(parsed.features)
    if "�" in content and b"\xef\xbf\xbd" not in data:
        features["not_utf8"] = 1
    file.features = features or None
    if parsed.title:
        file.title = parsed.title[:1024]
    seen: set[tuple[str, str]] = set()
    for tag in parsed.tags:
        key = paths.fold(tag)[:255]
        if (key, "") in seen:
            continue
        seen.add((key, ""))
        db.add(Tag(file_id=file.id, tag_key=key, tag=tag[:255]))
    for link in parsed.links:
        target_id = resolve(link.kind, link.target, file.path, names) if names is not None else None
        db.add(
            Link(
                source_id=file.id, space_id=file.space_id, kind=link.kind, target=link.target[:1024],
                subpath=link.subpath[:1024], target_key=target_key(link.target)[:255], target_id=target_id,
                line=link.line,
            )
        )
    db.execute(
        text(f"INSERT INTO {FTS_TABLE}(rowid, title, body) VALUES (:id, :title, :body)"),  # noqa: S608
        {"id": file.id, "title": file.title, "body": parsed.body},
    )


def _jsonable(value: object) -> object:
    """Front matter as JSON can hold it: YAML dates become text."""
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    if value is None or isinstance(value, bool | int | float | str):
        return value
    return str(value)


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
) -> File:
    """Bring the row of one file in line with ``data``, which is what is on disk now. Returns the row."""
    space = ensure_space(db, paths.space_of(rel))
    if file is None:
        file = db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))
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
    file.hash = digest(data)
    file.indexed_at = utcnow()
    db.flush()
    if names is None:
        names = Names(db, space.id, preload=False)
    _index_content(db, file, data, names)
    if file.is_note:
        add_version(db, file, data, source=source, author=author, session=session, bundle_seconds=bundle_seconds)
    return file


def forget(db: Session, file: File, *, how: str, by: str | None = None, group: str | None = None) -> None:
    """A file is gone: into the trash with it. Its links, tags and search text go, its versions stay."""
    _clear_note_index(db, file.id)
    db.execute(delete(Lock).where(Lock.file_id == file.id))
    file.deleted_at = utcnow()
    file.deleted_how = how
    file.deleted_by = by
    file.trash_group = group


def reresolve(db: Session, space_id: int, keys: Iterable[str]) -> int:
    """Look at every link again whose target has one of these names. Returns how many changed their target."""
    wanted = {key for key in keys if key}
    if not wanted:
        return 0
    big = len(wanted) > SMALL_CHANGE
    names = Names(db, space_id, preload=big)
    query = select(Link.id, Link.kind, Link.target, Link.target_id, File.path).join(File, File.id == Link.source_id)
    query = query.where(Link.space_id == space_id)
    if not big:
        query = query.where(Link.target_key.in_(wanted))
    changed = 0
    for link_id, kind, target, current, source in db.execute(query).all():
        if big and target_key(target) not in wanted:
            continue
        found = resolve(kind, target, source, names)
        if found != current:
            db.execute(update(Link).where(Link.id == link_id).values(target_id=found))
            changed += 1
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


def _chunks(items: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def scan(*, root: Path | None = None, only: set[str] | None = None) -> ScanStats:
    """Bring the index in line with the disk. ``only``: vault-relative paths the watcher saw; else everything."""
    root = root or paths.vault_root()
    stats = ScanStats()
    began = time.monotonic()
    if not root.is_dir():
        logger.warning("The vault folder is missing, nothing indexed")
        return stats
    status.running = True
    status.phase = "walking"
    try:
        _scan(root, only, stats)
    finally:
        stats.seconds = round(time.monotonic() - began, 3)
        status.running = False
        status.phase = ""
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


def _scan(root: Path, only: set[str] | None, stats: ScanStats) -> None:
    on_disk: dict[str, os.stat_result] = {}
    if only is None:
        space_folders = spaces_on_disk(root)
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
    if only is None and gone:
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
    status.held_back = held

    status.phase = "indexing"
    status.total = len(candidates)
    status.done = 0
    changed_keys: dict[int, set[str]] = {}
    arrived: dict[str, list[str]] = {}  # hash -> new paths, for moves

    for chunk in _chunks(sorted(candidates), BATCH):
        with guard, SessionLocal() as db:
            for rel in chunk:
                read = _read(root, rel)
                if read is None:
                    stats.errors += 1
                    continue
                data, stat = read
                row = known.get(rel)
                if row is not None and row.hash == digest(data):
                    db.execute(
                        update(File).where(File.id == row.id).values(size=stat.st_size, mtime_ns=stat.st_mtime_ns)
                    )
                    continue
                if row is not None:
                    file = db.get(File, row.id)
                    record(db, rel, data, stat, source=EXTERNAL, file=file)
                    stats.changed += 1
                    continue
                file = _revive(db, rel)
                if file is not None:
                    stats.revived += 1
                else:
                    arrived.setdefault(digest(data), []).append(rel)
                source = EXTERNAL if file is not None else INITIAL
                file = record(db, rel, data, stat, source=source, file=file)
                stats.added += 0 if source == EXTERNAL else 1
                changed_keys.setdefault(file.space_id, set()).add(file.name_key)
            db.commit()
        status.done += len(chunk)

    if gone:
        status.phase = "removing"
        with guard, SessionLocal() as db:
            for rel in gone:
                row = known[rel]
                file = db.get(File, row.id)
                if file is None:
                    continue
                twins = [
                    new for new in arrived.get(row.hash, [])
                    if paths.space_of(new) == paths.space_of(rel)
                ]
                changed_keys.setdefault(file.space_id, set()).add(file.name_key)
                if twins:
                    # Moved: the new row takes over the old one's history, the old row keeps the id.
                    new_rel = twins.pop(0)
                    arrived[row.hash].remove(new_rel)
                    _merge_move(db, file, new_rel)
                    stats.moved += 1
                    stats.added -= 1
                    continue
                forget(db, file, how=EXTERNAL)
                stats.removed += 1
            db.commit()

    if changed_keys:
        status.phase = "linking"
        with guard, SessionLocal() as db:
            for space_id, keys in changed_keys.items():
                reresolve(db, space_id, keys)
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


def _merge_move(db: Session, old: File, new_rel: str) -> None:
    """``old`` moved to ``new_rel``, where the scan has just made a fresh row: fold the fresh row into the old one."""
    fresh = db.scalar(select(File).where(File.path == new_rel, File.deleted_at.is_(None)))
    if fresh is None:
        return
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
    data = _read(paths.vault_root(), new_rel)
    if data is not None:
        record(db, new_rel, data[0], data[1], source=RENAME, file=old)


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
