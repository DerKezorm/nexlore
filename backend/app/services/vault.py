"""Changing the vault: writing notes, folders, locks, the trash, versions.

Every change goes to the disk first and to the index right after, both under ``index.guard``. The rule that runs
through all of it: **nothing is ever overwritten without a copy.** A save against a file that changed in the
meantime writes a conflict copy next to it; a deleted note goes to the trash with its versions; a restored version
leaves the state before it as a version of its own.

Writes are atomic: a hidden temporary file in the same folder, flushed to disk, then renamed over the target. A crash
leaves either the old file or the new one, never half of each, and the watcher does not see the temporary file.
"""

from __future__ import annotations

import logging
import os
import posixpath
import shutil
import threading
import time
import uuid
import zlib
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy import text as sql
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import FTS_TABLE, File, Link, Lock, MoveJob, MoveJobNote, Share, Space, TrashBlob, Version, utcnow
from . import favorites, index, looks, mdparse, paths, settings_service

logger = logging.getLogger("nexlore.vault")

#: A lock not renewed for this long runs out; the editor renews it well before.
LOCK_SECONDS = 90
#: Saves of one session within this time become one version.
BUNDLE_SECONDS = 600
TRASH_DAYS = 30
TEMPORARY_PREFIX = ".nexlore-"
#: Start of the trash group of a note deleted together with its own files (see ``trash``).
NOTE_GROUP = "note-"


class VaultError(Exception):
    def __init__(self, code: str, text: str, status: int = 400, **values: object) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status
        self.values = values


@dataclass
class Actor:
    """Who changes something: the account (until M4 a stand-in) and the browser tab it came from."""

    name: str
    client: str


# --- Low-level file work --------------------------------------------------------------------------------------------


def atomic_write(target: Path, data: bytes) -> os.stat_result:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f"{TEMPORARY_PREFIX}{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(6):
            try:
                os.replace(temporary, target)
                break
            except PermissionError:
                # Windows: somebody (a virus scanner, Obsidian) has the target open for a moment.
                if attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        if temporary.exists():
            temporary.unlink()
    return target.stat()


def _full(rel: str) -> Path:
    try:
        return paths.resolve(rel)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc


def _parse(rel: str) -> str:
    try:
        clean = paths.parse(rel)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc
    if "/" not in clean:
        raise VaultError("path_invalid", "a path must lie inside a space")
    return clean


def _check_name(name: str) -> str:
    try:
        return paths.check_name(name)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc


def live(db: Session, rel: str) -> File | None:
    return db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))


def live_by_key(db: Session, rel: str) -> File | None:
    """The file at this path compared the way Windows compares: case does not count."""
    return db.scalar(select(File).where(File.path_key == paths.fold(rel), File.deleted_at.is_(None)).limit(1))


def _file(db: Session, rel: str) -> File:
    file = live(db, rel)
    if file is None:
        raise VaultError("not_found", "no such file", 404)
    return file


def taken(full: Path) -> bool:
    """Whether a name is taken in its folder, compared without case."""
    if not full.parent.is_dir():
        return False
    wanted = paths.fold(full.name)
    return any(paths.fold(entry) == wanted for entry in os.listdir(full.parent))


def read(rel: str) -> tuple[File, bytes]:
    rel = _parse(rel)
    with SessionLocal() as db:
        file = _file(db, rel)
        db.expunge(file)
    try:
        data = _full(rel).read_bytes()
    except FileNotFoundError as exc:
        raise VaultError("not_found", "the file is gone from the disk", 404) from exc
    return file, data


# --- Locks ---------------------------------------------------------------------------------------------------------


def _valid_lock(db: Session, file_id: int, now: datetime | None = None) -> Lock | None:
    lock = db.get(Lock, file_id)
    if lock is None or lock.expires_at <= (now or utcnow()):
        return None
    return lock


def lock_state(db: Session, file_id: int) -> Lock | None:
    return _valid_lock(db, file_id)


def acquire(rel: str, actor: Actor) -> Lock:
    """Take or renew the lock on a note. Somebody else holding it: ``locked``, with who."""
    rel = _parse(rel)
    with index.guard, SessionLocal() as db:
        file = _file(db, rel)
        now = utcnow()
        lock = db.get(Lock, file.id)
        if lock is not None and lock.expires_at > now and lock.holder != actor.client:
            raise VaultError("locked", "somebody else is editing this note", 423, holder=lock.holder_name)
        if lock is None:
            lock = Lock(file_id=file.id, holder=actor.client, holder_name=actor.name, acquired_at=now)
            db.add(lock)
        elif lock.holder != actor.client or lock.expires_at <= now:
            lock.acquired_at = now
        lock.holder = actor.client
        lock.holder_name = actor.name
        lock.expires_at = now + timedelta(seconds=LOCK_SECONDS)
        db.commit()
        db.refresh(lock)
        db.expunge(lock)
        return lock


def release(rel: str, actor: Actor) -> None:
    rel = _parse(rel)
    with index.guard, SessionLocal() as db:
        file = live(db, rel)
        if file is None:
            return
        db.execute(delete(Lock).where(Lock.file_id == file.id, Lock.holder == actor.client))
        db.commit()


def _refuse_foreign_lock(db: Session, files: list[File], actor: Actor) -> None:
    now = utcnow()
    for file in files:
        lock = _valid_lock(db, file.id, now)
        if lock is not None and lock.holder != actor.client:
            raise VaultError("locked", "somebody else is editing this note", 423, holder=lock.holder_name,
                             path=file.path)


# --- Saving --------------------------------------------------------------------------------------------------------


@dataclass
class Saved:
    file: File
    #: Set when the note had changed on disk: the save went into this copy instead.
    conflict: str | None = None
    changed: bool = True


def _is_utf8(data: bytes) -> bool:
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def conflict_name(rel: str, now: datetime) -> str:
    name = posixpath.basename(rel)
    base, suffix = os.path.splitext(name)
    return f"{base} (conflict {now.strftime('%Y-%m-%d %H%M%S')}){suffix}"


def save(rel: str, data: bytes, *, base_hash: str, actor: Actor, source: str = index.APP) -> Saved:
    """Write a note the client had loaded as ``base_hash``. Changed in between: into a conflict copy instead.

    Somebody else holding the note's lock does not refuse the text either: a tab that lost its lock (it ran out, the
    heartbeat failed) still has words nobody saved, often in a last request as the tab closes. They go into a
    conflict copy; the note itself stays with the lock holder. So does a text for a note that is not UTF-8 on disk:
    it was read with its bytes replaced, and writing it back would lose them.
    """
    rel = _parse(rel)
    if not paths.is_note(rel):
        raise VaultError("not_a_note", "only notes are saved this way")
    full = _full(rel)
    with index.guard, SessionLocal() as db:
        file = _file(db, rel)
        foreign = _valid_lock(db, file.id, utcnow())
        locked_out = foreign is not None and foreign.holder != actor.client
        try:
            current = full.read_bytes()
        except FileNotFoundError:
            current = None
        # First: the file already holds exactly this text (a save sent twice, the second with the old base). That
        # is no conflict, nothing to write.
        if current is not None and index.digest(current) == index.digest(data):
            db.expunge(file)
            return Saved(file=file, changed=False)
        not_text = current is not None and not _is_utf8(current)
        if current is not None and (locked_out or not_text or index.digest(current) != base_hash):
            # Local time in the name: it is read by people, next to the files' own times (TZ in the container).
            copy_name = paths.unique_name(full.parent, conflict_name(rel, datetime.now().astimezone()))
            copy_rel = posixpath.join(posixpath.dirname(rel), copy_name)
            stat = atomic_write(full.parent / copy_name, data)
            copy = index.record(db, copy_rel, data, stat, source=source, author=actor.name, session=actor.client)
            # What is on disk now goes into the history too, before the watcher gets to it (if it did change).
            if index.digest(current) != base_hash:
                index.record(db, rel, current, full.stat(), source=index.EXTERNAL, file=file)
            index.reresolve(db, copy.space_id, [copy.name_key])
            db.commit()
            logger.info(
                "Save conflict, copy written file_id=%s copy_id=%s reason=%s",
                file.id, copy.id, "locked" if locked_out else "not utf-8" if not_text else "changed",
            )
            db.expunge(file)
            return Saved(file=file, conflict=copy_rel)
        stat = atomic_write(full, data)
        index.record(
            db, rel, data, stat, source=source, author=actor.name, session=actor.client,
            bundle_seconds=BUNDLE_SECONDS, file=file,
        )
        db.commit()
        db.refresh(file)
        db.expunge(file)
    logger.debug("Note saved path=%s bytes=%s", rel, len(data))
    return Saved(file=file)


def create_note(folder: str, title: str, data: bytes, *, actor: Actor, source: str = index.APP) -> File:
    """A new note in ``folder`` (a space or a folder in it). The file name comes from the title, made safe."""
    folder = _parse(folder) if "/" in folder else _parse_space(folder)
    directory = _full(folder)
    if not directory.is_dir():
        raise VaultError("not_found", "no such folder", 404)
    name = paths.safe_name(title)
    with index.guard, SessionLocal() as db:
        name = paths.unique_name(directory, name)
        rel = f"{folder}/{name}"
        if paths.stem(name) != title.strip() and title.strip() and not data.startswith(b"---"):
            # The title held what a file name cannot: it lives on in the front matter.
            data = _front_title(title.strip()) + data
        stat = atomic_write(directory / name, data)
        file = index.record(db, rel, data, stat, source=source, author=actor.name, session=actor.client)
        index.reresolve(db, file.space_id, [file.name_key])
        db.commit()
        db.refresh(file)
        db.expunge(file)
    logger.info("Note created file_id=%s", file.id)
    return file


def _front_title(title: str) -> bytes:
    escaped = title.replace("\\", "\\\\").replace('"', '\\"')
    return f'---\ntitle: "{escaped}"\n---\n'.encode()


def _parse_space(folder: str) -> str:
    try:
        clean = paths.parse(folder)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc
    if "/" in clean:
        raise VaultError("path_invalid", "not a space")
    return clean


def create_folder(parent: str, name: str) -> str:
    parent = _parse(parent) if "/" in parent else _parse_space(parent)
    name = _check_name(name)
    directory = _full(parent)
    if not directory.is_dir():
        raise VaultError("not_found", "no such folder", 404)
    target = directory / name
    if taken(target):
        raise VaultError("exists", "a file or folder of that name exists", 409)
    target.mkdir()
    return f"{parent}/{name}"


def create_space(name: str) -> str:
    name = _check_name(name)
    root = paths.vault_root()
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    if taken(target):
        raise VaultError("exists", "a space of that name exists", 409)
    target.mkdir()
    with index.guard, SessionLocal() as db:
        index.ensure_space(db, name)
        db.commit()
    return name


# --- Folder listing ------------------------------------------------------------------------------------------------


def below(db: Session, folder: str) -> list[File]:
    """Live files anywhere below a folder, by the path index (``/`` sorts right before ``0``)."""
    return list(
        db.scalars(
            select(File).where(File.deleted_at.is_(None), File.path > folder + "/", File.path < folder + "0")
        )
    )


# --- Deleting and the trash ----------------------------------------------------------------------------------------


def trash_file(file_id: int) -> Path:
    return paths.trash_root() / str(file_id)


def _move(source: Path, target: Path) -> None:
    """Rename where possible; across file systems (the vault on a share, the data folder local) a copy."""
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(source, target)
    except OSError:
        shutil.move(str(source), str(target))


def _keep_current(db: Session, file: File, full: Path) -> bool:
    """Make sure what is on disk right now is kept: the newest version for a note; any other file moves into the
    trash folder whole, however large (a video is never read into memory for this). True when the file was moved
    away already."""
    if file.is_note:
        try:
            data = full.read_bytes()
        except FileNotFoundError:
            return False
        index.add_version(db, file, data, source=index.EXTERNAL if index.digest(data) != file.hash else index.APP)
        return False
    if not full.exists():
        return False
    _move(full, trash_file(file.id))
    return True


def delete_path(rel: str, *, actor: Actor, along: Iterable[str] = ()) -> int:
    """Into the trash with a file, a folder or a whole space. Returns how many files went. ``along``: files only
    this note uses that go with it, in the same trash entry (they come back together); one that another note links
    meanwhile stays. A space keeps its row and its members: restoring from the trash brings it back as it was."""
    rel = _parse(rel) if "/" in rel.strip("/") else _parse_space(rel)
    full = _full(rel)
    group = str(uuid.uuid4())
    if along:
        # A note with its own files: the trash shows it as that note, not as the folder they share.
        group = NOTE_GROUP + group[len(NOTE_GROUP) :]
    with index.guard, SessionLocal() as db:
        if full.is_dir():
            files = below(db, rel)
            # Its symbol and colour go with it (the space's own too, when the whole space goes).
            space = db.scalar(select(Space).where(Space.folder == paths.space_of(rel)))
            if space is not None:
                looks.gone(db, space.id, rel.partition("/")[2])
        else:
            files = [_file(db, rel)]
            wanted = set(along)
            if wanted and files[0].is_note:
                files += [file for file in _its_own(db, files[0]) if file.path in wanted]
        _refuse_foreign_lock(db, files, actor)
        # Favorites of it, and of what lies in it, go too.
        favorites.gone(db, rel)
        keys: set[str] = set()
        space_id = None
        moved: list[File] = []
        try:
            for file in files:
                file_full = paths.vault_root().joinpath(*file.path.split("/"))
                if _keep_current(db, file, file_full):
                    moved.append(file)
                index.forget(db, file, how=index.APP, by=actor.name, group=group)
                keys.add(file.name_key)
                space_id = file.space_id
            db.flush()
            if space_id is not None:
                index.reresolve(db, space_id, keys)
            # The trash is written before a single note leaves the disk: whatever fails after, every note has its
            # newest text in a version and can come back.
            db.commit()
        except BaseException:
            # Not in the trash after all: the files moved there go back where they were.
            db.rollback()
            for file in moved:
                back = paths.vault_root().joinpath(*file.path.split("/"))
                if trash_file(file.id).exists() and not back.exists():
                    _move(trash_file(file.id), back)
            raise
        left: list[str] = []
        for file in files:
            file_full = paths.vault_root().joinpath(*file.path.split("/"))
            if file_full.exists() and not _unlink(file_full):
                # Still on the disk (held open elsewhere): the next scan finds it and indexes it again.
                left.append(file.path)
        if full.is_dir():
            _remove_empty_folders(full)
    if left:
        logger.warning("Files in the trash could not leave the disk, they stay files=%s", len(left))
    logger.info("Moved to the trash files=%s", len(files))
    return len(files)


def _unlink(path: Path) -> bool:
    """Remove a file, waiting a moment where Windows holds it open (a virus scanner, Obsidian)."""
    for attempt in range(6):
        try:
            path.unlink(missing_ok=True)
            return True
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
        except OSError:
            return False
    return False


def _remove_empty_folders(top: Path) -> None:
    """Folders left empty after a delete go; one that still holds something (hidden files of another program)
    stays."""
    for directory, _subdirs, _files in sorted(os.walk(top), key=lambda item: -len(item[0])):
        try:
            os.rmdir(directory)
        except OSError:
            continue


@dataclass
class TrashEntry:
    id: str
    path: str
    files: int
    deleted_at: datetime
    how: str
    by: str | None


def trash(space_ids: set[int] | None = None) -> list[TrashEntry]:
    """What is in the trash; with ``space_ids`` only what lies in those spaces."""
    entries: dict[str, TrashEntry] = {}
    query = (
        select(File.id, File.path, File.deleted_at, File.deleted_how, File.deleted_by, File.trash_group)
        .where(File.deleted_at.is_not(None))
        .order_by(File.deleted_at.desc())
    )
    if space_ids is not None:
        query = query.where(File.space_id.in_(space_ids))
    with SessionLocal() as db:
        rows = db.execute(query).all()
    grouped: dict[str, list[str]] = {}
    for file_id, path, deleted_at, how, by, group in rows:
        key = f"g-{group}" if group else f"f-{file_id}"
        grouped.setdefault(key, []).append(path)
        if key not in entries:
            entries[key] = TrashEntry(key, path, 0, deleted_at, how or index.EXTERNAL, by)
        entries[key].files += 1
    for key, members in grouped.items():
        notes = [member for member in members if paths.is_note(member)]
        if key.startswith("g-" + NOTE_GROUP) and len(notes) == 1:
            entries[key].path = notes[0]
        elif len(members) > 1:
            entries[key].path = posixpath.commonpath(members)
    return list(entries.values())


def _trash_members(db: Session, entry_id: str) -> list[File]:
    kind, _, value = entry_id.partition("-")
    if kind == "g":
        query = select(File).where(File.trash_group == value, File.deleted_at.is_not(None))
    elif kind == "f" and value.isdigit():
        query = select(File).where(File.id == int(value), File.deleted_at.is_not(None))
    else:
        raise VaultError("not_found", "no such trash entry", 404)
    files = list(db.scalars(query))
    if not files:
        raise VaultError("not_found", "no such trash entry", 404)
    return files


def trash_path(entry_id: str) -> str:
    """A path of a trash entry, to tell which space it lies in (a group never spans two)."""
    with SessionLocal() as db:
        return _trash_members(db, entry_id)[0].path


def _newest_content(db: Session, file: File) -> bytes | None:
    """What a trashed note, or a small file kept in the database before M3, holds."""
    if file.is_note:
        version = db.scalar(
            select(Version).where(Version.file_id == file.id).order_by(Version.updated_at.desc(), Version.id.desc())
        )
        return zlib.decompress(version.content) if version else None
    blob = db.get(TrashBlob, file.id)
    return zlib.decompress(blob.content) if blob else None


def restore_trash(entry_id: str, *, actor: Actor) -> list[str]:
    """Bring a trash entry back. A place taken in the meantime: the file comes back under a new name beside it."""
    restored: list[str] = []
    with index.guard, SessionLocal() as db:
        files = _trash_members(db, entry_id)
        keys: dict[int, set[str]] = {}
        for file in files:
            waiting = trash_file(file.id)
            # A note comes back from its newest version, never from a file in the trash folder: one left there by a
            # file gone for good (Windows held it) can carry the same id, and would come back as this note.
            from_file = not file.is_note and waiting.is_file()
            data = None if from_file else _newest_content(db, file)
            if data is None and not from_file:
                logger.warning("Trash entry without content, skipped file_id=%s", file.id)
                continue
            target = paths.vault_root().joinpath(*file.path.split("/"))
            rel = file.path
            if live(db, rel) is not None or taken(target):
                name = paths.unique_name(target.parent, target.name)
                rel = posixpath.join(posixpath.dirname(rel), name)
                target = target.parent / name
            file.path = rel
            file.path_key = paths.fold(rel)
            file.name_key = index.name_key(rel)
            file.deleted_at = None
            file.deleted_how = None
            file.deleted_by = None
            file.trash_group = None
            db.flush()
            if data is None:
                _move(waiting, target)
                index.record(db, rel, b"", target.stat(), source=index.RESTORE, author=actor.name, file=file)
            else:
                stat = atomic_write(target, data)
                index.record(db, rel, data, stat, source=index.RESTORE, author=actor.name, file=file)
            db.execute(delete(TrashBlob).where(TrashBlob.file_id == file.id))
            keys.setdefault(file.space_id, set()).add(file.name_key)
            restored.append(rel)
        for space_id, names in keys.items():
            index.reresolve(db, space_id, names)
        db.commit()
    logger.info("Restored from the trash files=%s", len(restored))
    return restored


def _forget_for_good(db: Session, files: list[File]) -> None:
    ids = [file.id for file in files]
    # The database empties the links' target itself (SET NULL); the space of a target in another space goes with it.
    for part in range(0, len(ids), 500):
        db.execute(update(Link).where(Link.target_id.in_(ids[part : part + 500])).values(target_space_id=None))
    for file in files:
        db.delete(file)
    db.commit()
    for file_id in ids:
        if not _unlink(trash_file(file_id)):
            logger.warning("A file could not be removed from the trash folder file_id=%s", file_id)


def purge_trash(entry_id: str) -> int:
    with index.guard, SessionLocal() as db:
        files = _trash_members(db, entry_id)
        _forget_for_good(db, files)
    logger.info("Trash entry removed for good files=%s", len(files))
    return len(files)


#: Housekeeping works in parts this big, each in a transaction of its own: nobody waits long for the write lock.
HOUSEKEEPING_PART = 200


def purge_expired(now: datetime | None = None) -> int:
    limit = (now or utcnow()) - timedelta(days=TRASH_DAYS)
    removed = 0
    while True:
        with index.guard, SessionLocal() as db:
            files = list(db.scalars(
                select(File).where(File.deleted_at.is_not(None), File.deleted_at < limit).limit(HOUSEKEEPING_PART)
            ))
            _forget_for_good(db, files)
        removed += len(files)
        if len(files) < HOUSEKEEPING_PART:
            break
    if removed:
        logger.info("Trash emptied of old entries files=%s", removed)
    return removed


# --- Versions ------------------------------------------------------------------------------------------------------


def versions(rel: str) -> list[Version]:
    rel = _parse(rel)
    with SessionLocal() as db:
        file = _file(db, rel)
        rows = list(
            db.scalars(
                select(Version).where(Version.file_id == file.id).order_by(Version.updated_at.desc(), Version.id.desc())
            )
        )
        for row in rows:
            db.expunge(row)
    return rows


def version_content(version_id: int) -> tuple[Version, bytes]:
    with SessionLocal() as db:
        version = db.get(Version, version_id)
        if version is None:
            raise VaultError("not_found", "no such version", 404)
        db.expunge(version)
    return version, zlib.decompress(version.content)


def version_path(version_id: int) -> str:
    """Where the note of a version lies now, to tell which space it belongs to."""
    with SessionLocal() as db:
        version = db.get(Version, version_id)
        file = db.get(File, version.file_id) if version is not None else None
        if file is None:
            raise VaultError("not_found", "no such version", 404)
        return file.path


def restore_version(version_id: int, *, actor: Actor) -> File:
    """Put an old version back. The state before stays as a version, so this can be undone the same way."""
    with index.guard, SessionLocal() as db:
        version = db.get(Version, version_id)
        if version is None:
            raise VaultError("not_found", "no such version", 404)
        file = db.get(File, version.file_id)
        if file is None or file.deleted_at is not None:
            raise VaultError("not_found", "the note is in the trash; restore it from there first", 404)
        _refuse_foreign_lock(db, [file], actor)
        full = _full(file.path)
        _keep_current(db, file, full)
        data = zlib.decompress(version.content)
        stat = atomic_write(full, data)
        index.record(db, file.path, data, stat, source=index.RESTORE, author=actor.name, file=file)
        db.commit()
        db.refresh(file)
        db.expunge(file)
    logger.info("Version restored file_id=%s version_id=%s", file.id, version_id)
    return file


#: How many versions stay, by age: everything of the last day, then the newest per hour, per day, per week.
THINNING = ((timedelta(days=1), None), (timedelta(days=7), 3600), (timedelta(days=30), 86400), (None, 7 * 86400))


def thin(rows: list[tuple[int, datetime]], now: datetime) -> list[int]:
    """Of one note's versions (id, time), the ids to drop. The newest version always stays."""
    if not rows:
        return []
    # By time, then by id: of two versions with the same time the later made one counts as newer, as everywhere else.
    ordered = sorted(rows, key=lambda row: (row[1], row[0]), reverse=True)
    drop: list[int] = []
    kept_buckets: set[tuple[int, int]] = set()
    for version_id, when in ordered:
        age = now - when
        width = next(width for limit, width in THINNING if limit is None or age <= limit)
        if width is None:
            continue
        bucket = (width, int(when.timestamp()) // width)
        # The newest comes first, finds every bucket empty and so never goes; it fills its bucket like any other.
        if bucket in kept_buckets:
            drop.append(version_id)
        else:
            kept_buckets.add(bucket)
    return drop


def thin_all(now: datetime | None = None) -> int:
    now = now or utcnow()
    dropped = 0
    with SessionLocal() as db:
        many = db.execute(
            select(Version.file_id).group_by(Version.file_id).having(func.count() > 1)
        ).scalars().all()
    for start in range(0, len(many), HOUSEKEEPING_PART):
        with index.guard, SessionLocal() as db:
            for file_id in many[start : start + HOUSEKEEPING_PART]:
                rows = [(row.id, row.updated_at) for row in db.execute(
                    select(Version.id, Version.updated_at).where(Version.file_id == file_id)
                )]
                ids = thin(rows, now)
                if ids:
                    db.execute(delete(Version).where(Version.id.in_(ids)))
                    dropped += len(ids)
            db.commit()
    if dropped:
        logger.info("Old versions thinned out versions=%s", dropped)
    return dropped


# --- Moving and renaming, with links following ---------------------------------------------------------------------


@dataclass
class Moved:
    path: str
    files: int
    rewritten: int
    #: The space of every note whose links were rewritten: the count shown afterwards names only those the mover
    #: may read, or it would tell of spaces they do not know.
    rewritten_spaces: list[int] = field(default_factory=list)


def _link_text(link: mdparse.LinkRef, target_rel: str, source_rel: str, names: index.Names, target_id: int) -> str:
    """How ``link`` should now spell its target, in the style it was written in."""
    space = paths.space_of(target_rel)
    within = target_rel[len(space) + 1 :]
    keep_suffix = link.target.lower().endswith(paths.NOTE_SUFFIX)
    # Into another space: the link names that space in front, as it did before (links never change their space).
    across = space != paths.space_of(source_rel)
    if link.kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED):
        if link.target.startswith("/"):
            new = "/" + (target_rel if across else within)
        elif across and not link.target.startswith("."):
            new = target_rel
        else:
            new = posixpath.relpath(target_rel, posixpath.dirname(source_rel))
        if link.encoded or (not link.angle and any(char in new for char in " ()<>")):
            new = quote(new, safe="/")
        return new
    if across:
        written, _, rest = link.target.strip().lstrip("/").partition("/")
        prefix = written if paths.fold(written) == paths.fold(space) else space
        new = f"{prefix}/{within}"
        if "/" not in rest.strip("/"):
            # Written as ``[[Space/Name]]``: the name alone again, where it still leads there.
            short = f"{prefix}/{paths.stem(target_rel)}"
            if index.resolve(link.kind, short, source_rel, names) == target_id:
                new = short
    elif link.target.startswith(("./", "../")):
        new = posixpath.relpath(target_rel, posixpath.dirname(source_rel))
        if not new.startswith("."):
            new = "./" + new
    elif "/" not in link.target:
        short = paths.stem(target_rel)
        if index.resolve(link.kind, short, source_rel, names) == target_id:
            new = short
        else:
            new = within
    else:
        new = within
    if paths.is_note(new) and not keep_suffix:
        new = new[: -len(paths.NOTE_SUFFIX)]
    return new


def _still_right(
    link: mdparse.LinkRef, source_rel: str, names: index.Names, target_id: int, target_rel: str
) -> bool:
    """Whether a link still finds its file. A relative Markdown link must do so as a path, not by the name
    fallback: other programs (GitHub, VS Code) read it strictly."""
    relative = link.kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED) and not link.target.startswith("/")
    space = paths.space_of(source_rel)
    if paths.space_of(target_rel) != space:
        across = index.crossing(link.kind, link.target, source_rel)
        other = names.home(space).named(across[0]) if across is not None else None
        folder = other.folder if other is not None else None
        if relative and link.target.startswith(".") and other is not None and folder is not None:
            # Climbing out of its space (``../Team/Note.md``): a path in that space, read just as strictly.
            return index.by_path(other, index.inside(folder, f"{folder}/{across[1]}")) == target_id
        return index.resolve(link.kind, link.target, source_rel, names) == target_id
    if relative or link.target.startswith(("./", "../")):
        joined = index.inside(space, f"{posixpath.dirname(source_rel)}/{link.target}")
        return index.by_path(names.home(space), joined) == target_id
    return index.resolve(link.kind, link.target, source_rel, names) == target_id


def move(source: str, destination: str, *, actor: Actor) -> Moved:
    """Move or rename a file or a folder within its space. Links to it, and relative links in it, follow."""
    source = _parse(source)
    destination = _parse(destination)
    if paths.space_of(source) != paths.space_of(destination):
        raise VaultError("move_across_spaces", "files move within their space only")
    if destination == source:
        raise VaultError("path_invalid", "source and destination are the same")
    for part in destination.split("/")[1:]:
        _check_name(part)
    full_source = _full(source)
    full_destination = _full(destination)
    if paths.fold(destination).startswith(paths.fold(source) + "/"):
        raise VaultError("path_invalid", "a folder cannot move into itself")
    case_only = paths.fold(source) == paths.fold(destination)
    if not case_only and (full_destination.exists() or taken(full_destination)):
        raise VaultError("exists", "a file or folder of that name exists", 409)
    is_folder = full_source.is_dir()
    if not is_folder and paths.is_note(source) != paths.is_note(destination):
        raise VaultError("path_invalid", "a note stays a note: keep the .md ending")

    with index.guard, SessionLocal() as db:
        files = below(db, source) if is_folder else [_file(db, source)]
        _refuse_foreign_lock(db, files, actor)
        new_path = {
            file.id: destination + file.path[len(source) :] if is_folder else destination for file in files
        }
        # A note moving to another folder takes the attachments only it uses along.
        carried: list[File] = []
        if not is_folder and files[0].is_note and posixpath.dirname(source) != posixpath.dirname(destination):
            for attachment, target in _carried(db, files[0], posixpath.dirname(destination)):
                carried.append(attachment)
                new_path[attachment.id] = target
            files = files + carried
        moved_ids = {file.id for file in files}
        space_id = files[0].space_id if files else index.ensure_space(db, paths.space_of(source)).id

        # Which links must be rewritten, read from the index before anything moves (afterwards the old names lead
        # nowhere): those pointing at a moved file, and every resolved link of a moved note.
        plan: dict[int, dict[tuple[str, str], int]] = {}
        for chunk in _chunks(sorted(moved_ids)):
            for source_id, kind, target, target_id in db.execute(
                select(Link.source_id, Link.kind, Link.target, Link.target_id).where(Link.target_id.in_(chunk))
            ):
                plan.setdefault(source_id, {})[(kind, target)] = target_id
        moved_notes = [file.id for file in files if file.is_note]
        for chunk in _chunks(moved_notes):
            for source_id, kind, target, target_id in db.execute(
                select(Link.source_id, Link.kind, Link.target, Link.target_id).where(
                    Link.source_id.in_(chunk), Link.target_id.is_not(None)
                )
            ):
                plan.setdefault(source_id, {})[(kind, target)] = target_id

        # The move on disk.
        full_destination.parent.mkdir(parents=True, exist_ok=True)
        if case_only:
            step = full_source.with_name(f"{TEMPORARY_PREFIX}{uuid.uuid4().hex}")
            os.rename(full_source, step)
            os.rename(step, full_destination)
        else:
            shutil.move(str(full_source), str(full_destination))
        for attachment in carried:
            old = paths.vault_root().joinpath(*attachment.path.split("/"))
            _move(old, paths.vault_root().joinpath(*new_path[attachment.id].split("/")))
            _remove_empty_folders(old.parent)
        for file in files:
            file.path = new_path[file.id]
            file.path_key = paths.fold(file.path)
            file.name_key = index.name_key(file.path)
        db.flush()
        # A folder's symbol and colour follow it, and those of the folders in it.
        if is_folder:
            looks.moved(db, space_id, source.partition("/")[2], destination.partition("/")[2])
        # Favorites follow, of a note as of a folder and what lies in it.
        favorites.moved(db, source, destination)
        # Public pages follow what they show.
        for share in db.scalars(select(Share).where(Share.space_id == space_id)):
            if share.path == source:
                share.path = destination
            elif share.path.startswith(source + "/"):
                share.path = destination + share.path[len(source) :]

        # Files other than notes: same content in a new place. Their row, hash and search text stay; the name they
        # are found by follows.
        keys = _old_keys(files, source, destination)
        for file in files:
            keys.add(file.name_key)
            if file.is_note:
                continue
            try:
                file.mtime_ns = paths.vault_root().joinpath(*file.path.split("/")).stat().st_mtime_ns
            except OSError:
                continue
            file.title = paths.stem(file.path)
            db.execute(
                sql(f"UPDATE {FTS_TABLE} SET title = :title WHERE rowid = :id"),  # noqa: S608
                {"title": file.title, "id": file.id},
            )

        # The links follow part by part (``_follow``), after this transaction: written down with it, so that a
        # server stopped half way carries on at its next start. The moved notes come first.
        job = MoveJob(space_id=space_id, author=actor.name, keys=sorted(keys))
        db.add(job)
        db.flush()
        order = moved_notes + sorted(note_id for note_id in plan if note_id not in moved_ids)
        rows = [
            {"job_id": job.id, "note_id": note_id, "position": position, "moved": note_id in moved_ids,
             "links": [[kind, target, target_id] for (kind, target), target_id in plan.get(note_id, {}).items()]}
            for position, note_id in enumerate(order)
        ]
        for chunk in _chunks(rows):
            db.execute(insert(MoveJobNote), chunk)
        job_id = job.id
        claimed = _claim(job_id)
        assert claimed, "a new move job is never worked on yet"
        try:
            db.commit()
        except BaseException:
            _release(job_id)
            raise
    rewritten_spaces: list[int] = []
    try:
        _follow(job_id, rewritten_spaces)
    except Exception:
        # The file has moved; what is left of its links follows before the next full scan (``resume_moves``).
        logger.exception("Rewriting the links of a move stopped half way job=%s", job_id)
    logger.info("Moved files=%s notes_rewritten=%s", len(files), len(rewritten_spaces))
    return Moved(path=destination, files=len(files), rewritten=len(rewritten_spaces),
                 rewritten_spaces=rewritten_spaces)


# --- The links of a move, part by part -----------------------------------------------------------------------------

#: How many notes a move rewrites at a time, each part under ``index.guard`` and in a transaction of its own, so that
#: saving waits for one part at most. Measured on a test server with 100,000 notes: all 1,841 notes of one rename in one
#: go held the lock for 16 s.
MOVE_PART = 100
#: And for how long at most: on Windows, where a virus scanner looks at every file written, 100 notes held the lock
#: for 2.9 s. The part ends with the note that goes past this.
MOVE_PART_SECONDS = 0.3
#: How much of a link's target the index keeps (``prepare.analyse``): a move finds its links again by that.
TARGET_CHARS = 1024

_claimed: set[int] = set()
_claimed_lock = threading.Lock()


def _chunks[T](items: list[T], size: int = 500) -> Iterable[list[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _claim(job_id: int) -> bool:
    """Mark a job as being worked on; False when someone already works on it."""
    with _claimed_lock:
        if job_id in _claimed:
            return False
        _claimed.add(job_id)
        return True


def _release(job_id: int) -> None:
    with _claimed_lock:
        _claimed.discard(job_id)


def _follow(job_id: int, spaces: list[int]) -> None:
    """Rewrite the links of a move job, part by part, then resolve the old and new names once more and let the job
    go. ``spaces`` gets the space of every note rewritten. The job must be claimed; it is released at the end, also
    when a part fails (it is taken up again by ``resume_moves``). Between two parts a link not yet rewritten shows the
    old name and leads nowhere on its note page; the index keeps it pointing at its file until the end."""
    try:
        while True:
            done, part = _follow_part(job_id)
            spaces += part
            if done:
                break
        _finish(job_id)
    finally:
        _release(job_id)


def _follow_part(job_id: int) -> tuple[bool, list[int]]:
    with index.guard, SessionLocal() as db:
        job = db.get(MoveJob, job_id)
        if job is None:
            return True, []
        rows = db.scalars(
            select(MoveJobNote).where(MoveJobNote.job_id == job_id).order_by(MoveJobNote.position).limit(MOVE_PART)
        ).all()
        if not rows:
            return True, []
        # Row by row, always current: the names change between parts when someone else renames something.
        names = index.Names(db, job.space_id, preload=False)
        spaces = []
        done = []
        began = time.monotonic()
        for row in rows:
            space_id = _follow_note(db, row, names, job.author)
            if space_id is not None:
                spaces.append(space_id)
            done.append(row.note_id)
            if time.monotonic() - began >= MOVE_PART_SECONDS:
                break
        db.execute(delete(MoveJobNote).where(MoveJobNote.job_id == job_id, MoveJobNote.note_id.in_(done)))
        db.commit()
    return False, spaces


def _follow_note(db: Session, row: MoveJobNote, names: index.Names, author: str | None) -> int | None:
    """Rewrite the links of one note that pointed at a moved file, as the note reads now: someone may have changed it
    since the move, and a link is found again by how it was written. Returns the note's space when it was rewritten."""
    note = db.get(File, row.note_id)
    if note is None or note.deleted_at is not None or not note.is_note:
        return None
    note_full = paths.vault_root().joinpath(*note.path.split("/"))
    try:
        data = note_full.read_bytes()
    except OSError:
        return None
    wanted = {(kind, target): target_id for kind, target, target_id in row.links}
    content = index.decode(data)
    pieces: list[str] = []
    position = 0
    for link in mdparse.parse(content).links:
        target_id = wanted.get((link.kind, link.target[:TARGET_CHARS]))
        if target_id is None:
            continue
        # A target in the trash still has its path: the link follows it there and finds it again when it comes back.
        target = db.get(File, target_id)
        if target is None:
            continue
        # Still pointing at the right file from where it is now: leave the link as written.
        if _still_right(link, note.path, names, target_id, target.path):
            continue
        pieces.append(content[position : link.target_start])
        pieces.append(_link_text(link, target.path, note.path, names, target_id))
        position = link.target_end
    if pieces:
        pieces.append(content[position:])
        new_data = "".join(pieces).encode("utf-8")
        if data.startswith(b"\xef\xbb\xbf"):
            new_data = b"\xef\xbb\xbf" + new_data
        stat = atomic_write(note_full, new_data)
        index.record(db, note.path, new_data, stat, source=index.RENAME, author=author, file=note, names=names)
        return note.space_id
    # A moved note is read again at its new place (title, links from there). So is one that differs from its index:
    # a server stopped after writing it, before its part was committed.
    if row.moved or index.digest(data) != note.hash:
        index.record(db, note.path, data, note_full.stat(), source=index.RENAME, author=author, file=note, names=names)
    return None


def _finish(job_id: int) -> None:
    with SessionLocal() as db:
        job = db.get(MoveJob, job_id)
        if job is None:
            return
        space_id, keys = job.space_id, set(job.keys or [])
    # Now every link reads the new name: resolve both names once more (a link still written with the old one, in a
    # note that could not be read, leads nowhere; one written with the new one already finds it).
    index.relink(space_id, keys, set(), progress=False)
    with index.guard, SessionLocal() as db:
        db.execute(delete(MoveJob).where(MoveJob.id == job_id))
        db.commit()


def resume_moves() -> int:
    """Carry on with every move whose links are not all rewritten yet and nobody works on: a server stopped half
    way. Runs before each full scan. Returns how many jobs it finished."""
    with SessionLocal() as db:
        ids = list(db.scalars(select(MoveJob.id).order_by(MoveJob.id)))
    finished = 0
    for job_id in ids:
        if not _claim(job_id):
            continue
        logger.info("Carrying on with the links of an unfinished move job=%s", job_id)
        _follow(job_id, [])
        finished += 1
    return finished


def _its_own(db: Session, note: File) -> list[File]:
    """Files other than notes that ``note`` links and no other live note does, by path."""
    linked = select(Link.target_id).where(Link.source_id == note.id, Link.target_id.is_not(None))
    candidates = db.scalars(
        select(File).where(File.id.in_(linked), File.deleted_at.is_(None), File.is_note.is_(False)).order_by(File.path)
    ).all()
    source_file = File.__table__.alias("source")
    own = []
    for attachment in candidates:
        others = db.scalar(
            select(func.count())
            .select_from(Link)
            .join(source_file, source_file.c.id == Link.source_id)
            .where(Link.target_id == attachment.id, Link.source_id != note.id, source_file.c.deleted_at.is_(None))
        )
        if not others:
            own.append(attachment)
    return own


def its_own(rel: str) -> list[str]:
    """What only this note uses: offered to go along into the trash when the note is deleted."""
    rel = _parse(rel)
    with SessionLocal() as db:
        return [file.path for file in _its_own(db, _file(db, rel))]


def _carried(db: Session, note: File, new_folder: str) -> list[tuple[File, str]]:
    """The attachments that go along when ``note`` moves to ``new_folder``: those in the attachment folder beside it
    that no other note links. Each with its new path, in the attachment folder beside the note's new place."""
    folder_name = str(settings_service.get(db, "attachment_folder") or "Attachments")
    old_folder = posixpath.join(posixpath.dirname(note.path), folder_name)
    target_folder = posixpath.join(new_folder, folder_name)
    result: list[tuple[File, str]] = []
    taken: set[str] = set()
    directory = paths.vault_root().joinpath(*target_folder.split("/"))
    for attachment in _its_own(db, note):
        # Only what lies right in the attachment folder beside the note, not below it or elsewhere.
        if posixpath.dirname(attachment.path) != old_folder:
            continue
        name = paths.unique_name(directory, posixpath.basename(attachment.path), taken=taken)
        taken.add(name)
        result.append((attachment, f"{target_folder}/{name}"))
    return result


def _old_keys(files: list[File], source: str, destination: str) -> set[str]:
    """Names the moved files had before: links that pointed at those names are looked at again."""
    keys = set()
    for file in files:
        old = source + file.path[len(destination) :] if file.path.startswith(destination) else file.path
        keys.add(index.name_key(old))
    return keys
