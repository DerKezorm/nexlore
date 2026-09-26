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
import time
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

from sqlalchemy import delete, func, select
from sqlalchemy import text as sql
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import FTS_TABLE, File, Link, Lock, TrashBlob, Version, utcnow
from . import index, mdparse, paths, settings_service

logger = logging.getLogger("nexlore.vault")

#: A lock not renewed for this long runs out; the editor renews it well before.
LOCK_SECONDS = 90
#: Saves of one session within this time become one version.
BUNDLE_SECONDS = 600
TRASH_DAYS = 30
TEMPORARY_PREFIX = ".nexlore-"


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


def _taken(full: Path) -> bool:
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


def conflict_name(rel: str, now: datetime) -> str:
    name = posixpath.basename(rel)
    base, suffix = os.path.splitext(name)
    return f"{base} (conflict {now.strftime('%Y-%m-%d %H%M%S')}){suffix}"


def save(rel: str, data: bytes, *, base_hash: str, actor: Actor) -> Saved:
    """Write a note the client had loaded as ``base_hash``. Changed in between: into a conflict copy instead.

    Somebody else holding the note's lock does not refuse the text either: a tab that lost its lock (it ran out, the
    heartbeat failed) still has words nobody saved, often in a last request as the tab closes. They go into a
    conflict copy; the note itself stays with the lock holder.
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
        if current is not None and (locked_out or index.digest(current) != base_hash):
            # Local time in the name: it is read by people, next to the files' own times (TZ in the container).
            copy_name = paths.unique_name(full.parent, conflict_name(rel, datetime.now().astimezone()))
            copy_rel = posixpath.join(posixpath.dirname(rel), copy_name)
            stat = atomic_write(full.parent / copy_name, data)
            copy = index.record(db, copy_rel, data, stat, source=index.APP, author=actor.name, session=actor.client)
            # What is on disk now goes into the history too, before the watcher gets to it (if it did change).
            if index.digest(current) != base_hash:
                index.record(db, rel, current, full.stat(), source=index.EXTERNAL, file=file)
            index.reresolve(db, copy.space_id, [copy.name_key])
            db.commit()
            logger.info(
                "Save conflict, copy written file_id=%s copy_id=%s reason=%s",
                file.id, copy.id, "locked" if locked_out else "changed",
            )
            db.expunge(file)
            return Saved(file=file, conflict=copy_rel)
        stat = atomic_write(full, data)
        index.record(
            db, rel, data, stat, source=index.APP, author=actor.name, session=actor.client,
            bundle_seconds=BUNDLE_SECONDS, file=file,
        )
        db.commit()
        db.refresh(file)
        db.expunge(file)
    logger.debug("Note saved path=%s bytes=%s", rel, len(data))
    return Saved(file=file)


def create_note(folder: str, title: str, data: bytes, *, actor: Actor) -> File:
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
        file = index.record(db, rel, data, stat, source=index.APP, author=actor.name, session=actor.client)
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
    if _taken(target):
        raise VaultError("exists", "a file or folder of that name exists", 409)
    target.mkdir()
    return f"{parent}/{name}"


def create_space(name: str) -> str:
    name = _check_name(name)
    root = paths.vault_root()
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    if _taken(target):
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


def delete_path(rel: str, *, actor: Actor) -> int:
    """Into the trash with a file or a folder. Returns how many files went."""
    rel = _parse(rel)
    full = _full(rel)
    group = str(uuid.uuid4())
    with index.guard, SessionLocal() as db:
        if full.is_dir():
            files = below(db, rel)
        else:
            files = [_file(db, rel)]
        _refuse_foreign_lock(db, files, actor)
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
            for file in files:
                file_full = paths.vault_root().joinpath(*file.path.split("/"))
                if file_full.exists():
                    file_full.unlink()
            if full.is_dir():
                _remove_empty_folders(full)
            if space_id is not None:
                index.reresolve(db, space_id, keys)
            db.commit()
        except BaseException:
            # Not in the trash after all: the files moved there go back where they were.
            db.rollback()
            for file in moved:
                back = paths.vault_root().joinpath(*file.path.split("/"))
                if trash_file(file.id).exists() and not back.exists():
                    _move(trash_file(file.id), back)
            raise
    logger.info("Moved to the trash files=%s", len(files))
    return len(files)


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


def trash() -> list[TrashEntry]:
    entries: dict[str, TrashEntry] = {}
    with SessionLocal() as db:
        rows = db.execute(
            select(File.id, File.path, File.deleted_at, File.deleted_how, File.deleted_by, File.trash_group)
            .where(File.deleted_at.is_not(None))
            .order_by(File.deleted_at.desc())
        ).all()
    grouped: dict[str, list[str]] = {}
    for file_id, path, deleted_at, how, by, group in rows:
        key = f"g-{group}" if group else f"f-{file_id}"
        grouped.setdefault(key, []).append(path)
        if key not in entries:
            entries[key] = TrashEntry(key, path, 0, deleted_at, how or index.EXTERNAL, by)
        entries[key].files += 1
    for key, members in grouped.items():
        if len(members) > 1:
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
            data = None if waiting.is_file() else _newest_content(db, file)
            if data is None and not waiting.is_file():
                logger.warning("Trash entry without content, skipped file_id=%s", file.id)
                continue
            target = paths.vault_root().joinpath(*file.path.split("/"))
            rel = file.path
            if live(db, rel) is not None or _taken(target):
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
    for file in files:
        db.delete(file)
    db.commit()
    for file_id in ids:
        trash_file(file_id).unlink(missing_ok=True)


def purge_trash(entry_id: str) -> int:
    with index.guard, SessionLocal() as db:
        files = _trash_members(db, entry_id)
        _forget_for_good(db, files)
    logger.info("Trash entry removed for good files=%s", len(files))
    return len(files)


def purge_expired(now: datetime | None = None) -> int:
    limit = (now or utcnow()) - timedelta(days=TRASH_DAYS)
    with index.guard, SessionLocal() as db:
        files = list(db.scalars(select(File).where(File.deleted_at.is_not(None), File.deleted_at < limit)))
        _forget_for_good(db, files)
    if files:
        logger.info("Trash emptied of old entries files=%s", len(files))
    return len(files)


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
    with index.guard, SessionLocal() as db:
        many = db.execute(
            select(Version.file_id).group_by(Version.file_id).having(func.count() > 1)
        ).scalars().all()
        for file_id in many:
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


def _link_text(link: mdparse.LinkRef, target_rel: str, source_rel: str, names: index.Names, target_id: int) -> str:
    """How ``link`` should now spell its target, in the style it was written in."""
    space = paths.space_of(target_rel)
    within = target_rel[len(space) + 1 :]
    keep_suffix = link.target.lower().endswith(paths.NOTE_SUFFIX)
    if link.kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED):
        if link.target.startswith("/"):
            new = "/" + within
        else:
            new = posixpath.relpath(target_rel, posixpath.dirname(source_rel))
        if link.encoded or (not link.angle and any(char in new for char in " ()<>")):
            new = quote(new, safe="/")
        return new
    if link.target.startswith(("./", "../")):
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


def _still_right(link: mdparse.LinkRef, source_rel: str, names: index.Names, target_id: int) -> bool:
    """Whether a link still finds its file. A relative Markdown link must do so as a path, not by the name
    fallback: other programs (GitHub, VS Code) read it strictly."""
    relative = link.kind in (mdparse.MARKDOWN, mdparse.MARKDOWN_EMBED) and not link.target.startswith("/")
    if relative or link.target.startswith(("./", "../")):
        space = paths.space_of(source_rel)
        joined = index.inside(space, f"{posixpath.dirname(source_rel)}/{link.target}")
        return index.by_path(names, joined) == target_id
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
    if not case_only and (full_destination.exists() or _taken(full_destination)):
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

        # Which notes must be rewritten: those linking here, and the moved notes themselves.
        sources = set(
            db.scalars(select(Link.source_id).where(Link.target_id.in_(moved_ids)).distinct())
        ) | {file.id for file in files if file.is_note}
        before = index.Names(db, space_id, preload=len(sources) > index.SMALL_CHANGE)
        plans: dict[int, tuple[bytes, list[tuple[mdparse.LinkRef, int]]]] = {}
        for source_id in sources:
            note = db.get(File, source_id)
            if note is None or note.deleted_at is not None or not note.is_note:
                continue
            note_full = paths.vault_root().joinpath(*note.path.split("/"))
            try:
                data = note_full.read_bytes()
            except OSError:
                continue
            content = index.decode(data)
            wanted = []
            for link in mdparse.parse(content).links:
                target_id = index.resolve(link.kind, link.target, note.path, before)
                if target_id is None:
                    continue
                if target_id in moved_ids or source_id in moved_ids:
                    wanted.append((link, target_id))
            if wanted:
                plans[source_id] = (data, wanted)

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

        # Rewrite the links, now that every file is at its new place.
        after = index.Names(db, space_id, preload=len(plans) > index.SMALL_CHANGE)
        rewritten_ids: set[int] = set()
        for source_id, (data, wanted) in plans.items():
            note = db.get(File, source_id)
            assert note is not None
            content = index.decode(data)
            pieces: list[str] = []
            position = 0
            changes = 0
            for link, target_id in wanted:
                target = db.get(File, target_id)
                if target is None:
                    continue
                # Still pointing at the right file from the new place: leave the link as written.
                if _still_right(link, note.path, after, target_id):
                    continue
                text = _link_text(link, target.path, note.path, after, target_id)
                pieces.append(content[position : link.target_start])
                pieces.append(text)
                position = link.target_end
                changes += 1
            if not changes:
                continue
            pieces.append(content[position:])
            new_data = "".join(pieces).encode("utf-8")
            if data.startswith(b"\xef\xbb\xbf"):
                new_data = b"\xef\xbb\xbf" + new_data
            note_full = paths.vault_root().joinpath(*note.path.split("/"))
            stat = atomic_write(note_full, new_data)
            index.record(db, note.path, new_data, stat, source=index.RENAME, author=actor.name, file=note,
                         names=after)
            rewritten_ids.add(source_id)

        # The moved files themselves: new stat, their own links resolved from the new place.
        keys = _old_keys(files, source, destination)
        for file in files:
            keys.add(file.name_key)
            if file.id in rewritten_ids:
                continue
            file_full = paths.vault_root().joinpath(*file.path.split("/"))
            if not file.is_note:
                # Same content in a new place: its row, hash and search text stay; the name it is found by follows.
                try:
                    file.mtime_ns = file_full.stat().st_mtime_ns
                except OSError:
                    continue
                file.title = paths.stem(file.path)
                db.execute(
                    sql(f"UPDATE {FTS_TABLE} SET title = :title WHERE rowid = :id"),  # noqa: S608
                    {"title": file.title, "id": file.id},
                )
                continue
            try:
                data = file_full.read_bytes()
            except OSError:
                continue
            index.record(db, file.path, data, file_full.stat(), source=index.RENAME, author=actor.name, file=file,
                         names=after)
        index.reresolve(db, space_id, keys)
        db.commit()
    logger.info("Moved files=%s notes_rewritten=%s", len(files), len(rewritten_ids))
    return Moved(path=destination, files=len(files), rewritten=len(rewritten_ids))


def _carried(db: Session, note: File, new_folder: str) -> list[tuple[File, str]]:
    """The attachments that go along when ``note`` moves to ``new_folder``: those in the attachment folder beside it
    that no other note links. Each with its new path, in the attachment folder beside the note's new place."""
    folder_name = str(settings_service.get(db, "attachment_folder") or "Anhänge")
    old_folder = posixpath.join(posixpath.dirname(note.path), folder_name)
    target_folder = posixpath.join(new_folder, folder_name)
    linked = select(Link.target_id).where(Link.source_id == note.id, Link.target_id.is_not(None))
    candidates = db.scalars(
        select(File).where(
            File.id.in_(linked), File.deleted_at.is_(None), File.is_note.is_(False),
            File.path > old_folder + "/", File.path < old_folder + "0",
        )
    ).all()
    source_file = File.__table__.alias("source")
    result: list[tuple[File, str]] = []
    taken: set[str] = set()
    directory = paths.vault_root().joinpath(*target_folder.split("/"))
    for attachment in candidates:
        if "/" in attachment.path[len(old_folder) + 1 :]:
            continue  # in a folder below: not simply "beside the note"
        others = db.scalar(
            select(func.count())
            .select_from(Link)
            .join(source_file, source_file.c.id == Link.source_id)
            .where(Link.target_id == attachment.id, Link.source_id != note.id, source_file.c.deleted_at.is_(None))
        )
        if others:
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
