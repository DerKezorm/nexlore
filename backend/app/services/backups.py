"""Backups of the whole of nexlore: the vault's files and the database, in one ZIP.

Built after nextrmnl's backup service:

* **The database is copied with SQLite's backup API**, never as a file: it runs in WAL mode, and a file copy misses
  what still sits in the ``-wal`` side file. The copy is taken under ``index.guard`` and takes a moment; the vault's
  files are copied after, without holding up saves. Whatever changed in between, the scan after a restore brings the
  index back in line with the files; history and trash are in the database copy.
* **Everything in the vault goes in**, hidden folders too: ``.obsidian/`` belongs to the vault that was backed up.
  Only nexlore's own temporary files stay out. So do the files waiting in the trash (``trash/``, deleted
  attachments; notes wait in the database's versions).
* **The manifest lists every file with its size and sha256**, so the check before a restore can tell a damaged
  archive from a good one, and say what a restore would change.
* **Only automatic copies are pruned** (``scheduled`` and ``update``); one made by hand stays until deleted.
* **A restore happens at the next start.** ``stage_restore`` checks the archive, makes an ``update`` copy of the
  current state (the way back), unpacks into ``backups/restore-pending/`` and ends the process; Docker starts it
  again and ``apply_pending`` swaps the files before anything opens the database. A pending folder without its
  manifest is a half-written one and is thrown away, never applied.

The archive is not encrypted: it lies in the data folder next to the database it copies. Download with a password
and the settings in the interface come with M4.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import sqlite3
import threading
import time
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import __version__
from ..config import get_settings
from . import index, paths, settings_service

logger = logging.getLogger("nexlore.backups")

FOLDER_NAME = "backups"
MANIFEST = "nexlore-backup.json"
DATABASE_ENTRY = "database/nexlore.db"
VAULT_PREFIX = "vault/"
TRASH_PREFIX = "trash/"
#: The key the server encrypts its own secrets with (OIDC client secret, mail password): without it a restore on
#: another machine would bring those back unreadable. Whoever holds a backup holds the database anyway.
SECRET_ENTRY = "secret.key"
#: Files in the trash folder are named by their row id.
TRASH_NAME = re.compile(r"^\d{1,18}$")
PENDING = "restore-pending"
MANUAL = "manual"
SCHEDULED = "scheduled"
UPDATE = "update"
AUTOMATIC_KINDS = (SCHEDULED, UPDATE)
SCHEDULES = ("off", "daily", "weekly")
INTERVALS = {"daily": 1, "weekly": 7}
NIGHT = range(3, 6)
CATCH_UP_DAYS = 1
INTERVAL_SECONDS = 3600
NAME = re.compile(r"^nexlore-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.zip$")
SQLITE_HEADER = b"SQLite format 3\x00"
_CHUNK = 1024 * 1024
_lock = threading.Lock()


class BackupError(Exception):
    def __init__(self, code: str, text: str) -> None:
        super().__init__(text)
        self.code = code
        self.text = text


@dataclass
class Manifest:
    version: str
    created: str
    kind: str
    note: str = ""
    notes: int = 0
    files: int = 0
    bytes: int = 0
    #: vault-relative path -> [size, sha256]
    vault: dict[str, list[Any]] = field(default_factory=dict)
    #: name in the trash folder -> [size, sha256]
    trash: dict[str, list[Any]] = field(default_factory=dict)


@dataclass
class Entry:
    name: str
    size: int
    created: str
    kind: str
    note: str
    notes: int
    files: int
    version: str


@dataclass
class Brief:
    """What a restore of an archive would do: its data, and how the vault would change."""

    name: str
    version: str
    created: str
    kind: str
    notes: int
    files: int
    database_ok: bool
    files_ok: bool
    damaged: list[str]
    would_add: int
    would_change: int
    would_remove: int
    examples: dict[str, list[str]]

    @property
    def usable(self) -> bool:
        return self.database_ok and self.files_ok


def folder() -> Path:
    return get_settings().data_dir / FOLDER_NAME


def pending_folder() -> Path:
    return folder() / PENDING


def path_of(name: str) -> Path:
    if not NAME.match(name):
        raise BackupError("not_found", "no such backup")
    path = folder() / name
    if not path.is_file():
        raise BackupError("not_found", "no such backup")
    return path


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%d-%H%M%S")


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _vault_files(root: Path) -> list[tuple[str, Path]]:
    """Every file in the vault, hidden ones included, but no links and none of nexlore's temporary files."""
    found: list[tuple[str, Path]] = []
    if not root.is_dir():
        return found
    for directory, subdirs, files in os.walk(root, followlinks=False):
        subdirs[:] = sorted(
            name for name in subdirs
            if not name.startswith(".nexlore-") and not os.path.islink(os.path.join(directory, name))
        )
        for name in sorted(files):
            full = Path(directory) / name
            if name.startswith(".nexlore-") or full.is_symlink():
                continue
            found.append((full.relative_to(root).as_posix(), full))
    return found


def _trash_files() -> list[tuple[str, Path]]:
    folder_path = paths.trash_root()
    if not folder_path.is_dir():
        return []
    return sorted(
        (entry.name, entry) for entry in folder_path.iterdir()
        if TRASH_NAME.match(entry.name) and entry.is_file() and not entry.is_symlink()
    )


def _snapshot_trash(target: Path) -> None:
    """The trash folder as it is this instant: hard links (instant, no copy) where the file system allows them."""
    target.mkdir(parents=True, exist_ok=True)
    for name_in_trash, full in _trash_files():
        try:
            os.link(full, target / name_in_trash)
        except OSError:
            shutil.copy2(full, target / name_in_trash)


def _database_copy(target: Path, trash: Path) -> None:
    """The database and the trash folder in one instant, so the archive's trash matches the database that knows it."""
    source = sqlite3.connect(get_settings().database_path)
    destination = sqlite3.connect(target)
    try:
        with index.guard:
            source.backup(destination)
            _snapshot_trash(trash)
        destination.execute("PRAGMA journal_mode=DELETE")
        destination.commit()
    finally:
        destination.close()
        source.close()


def create(*, kind: str = MANUAL, note: str = "") -> Path:
    """A new backup archive. Returns its path."""
    base = folder()
    base.mkdir(parents=True, exist_ok=True)
    moment = datetime.now(UTC)
    name = f"nexlore-{_stamp(moment)}.zip"
    number = 2
    while (base / name).exists():
        name = f"nexlore-{_stamp(moment)}-{number}.zip"
        number += 1
    partial = base / f".{name}.part"
    database = base / f".{name}.db"
    trash = base / f".{name}.trash"
    root = paths.vault_root()
    try:
        _database_copy(database, trash)
        manifest = Manifest(version=__version__, created=moment.isoformat(timespec="seconds"), kind=kind, note=note)
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(database, DATABASE_ENTRY)
            key = get_settings().data_dir / "secret.key"
            if key.is_file():
                archive.write(key, SECRET_ENTRY)
            for rel, full in _vault_files(root):
                try:
                    size = full.stat().st_size
                    archive.write(full, VAULT_PREFIX + rel)
                    manifest.vault[rel] = [size, _hash_file(full)]
                except OSError as exc:
                    logger.warning("A file could not be backed up and was left out: %s", exc.strerror)
                    continue
                manifest.files += 1
                manifest.bytes += size
                manifest.notes += int(rel.lower().endswith(paths.NOTE_SUFFIX))
            for full in sorted(trash.iterdir()):
                name_in_trash = full.name
                try:
                    archive.write(full, TRASH_PREFIX + name_in_trash)
                    manifest.trash[name_in_trash] = [full.stat().st_size, _hash_file(full)]
                except OSError as exc:
                    logger.warning("A file in the trash could not be backed up and was left out: %s", exc.strerror)
            # Last: an archive without its manifest is recognisably incomplete.
            archive.writestr(MANIFEST, json.dumps(asdict(manifest), ensure_ascii=False))
        os.replace(partial, base / name)
    finally:
        partial.unlink(missing_ok=True)
        database.unlink(missing_ok=True)
        shutil.rmtree(trash, ignore_errors=True)
    logger.info("Backup made kind=%s files=%s bytes=%s", kind, manifest.files, manifest.bytes)
    return base / name


def _manifest(archive: zipfile.ZipFile) -> Manifest:
    try:
        raw = json.loads(archive.read(MANIFEST).decode("utf-8"))
        return Manifest(**raw)
    except (KeyError, ValueError, TypeError) as exc:
        raise BackupError("backup_invalid", "the archive has no readable manifest") from exc


def entries() -> list[Entry]:
    base = folder()
    if not base.is_dir():
        return []
    found = []
    for path in base.iterdir():
        if not NAME.match(path.name):
            continue
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
        except (zipfile.BadZipFile, BackupError, OSError):
            continue
        found.append(
            Entry(path.name, path.stat().st_size, manifest.created, manifest.kind, manifest.note, manifest.notes,
                  manifest.files, manifest.version)
        )
    return sorted(found, key=lambda entry: entry.created, reverse=True)


def remove(name: str) -> None:
    path_of(name).unlink()
    logger.info("Backup deleted")


def prune(keep: int) -> int:
    automatic = [entry for entry in entries() if entry.kind in AUTOMATIC_KINDS]
    removed = 0
    for entry in automatic[max(keep, 1) :]:
        (folder() / entry.name).unlink(missing_ok=True)
        removed += 1
    if removed:
        logger.info("Old automatic backups removed count=%s", removed)
    return removed


# --- Checking and restoring -----------------------------------------------------------------------------------------


def _safe_member(name: str) -> str | None:
    """The vault-relative path of an archive member, or None when it is not a plain path inside the vault."""
    if not name.startswith(VAULT_PREFIX):
        return None
    rel = name[len(VAULT_PREFIX) :]
    parts = rel.split("/")
    if not rel or "\\" in rel or any(part in ("", ".", "..") for part in parts) or ":" in parts[0]:
        return None
    if any(ord(char) < 32 for char in rel):
        return None
    return rel


def check(name: str) -> Brief:
    """The trial run: is the archive whole, and what would a restore change in the vault?"""
    path = path_of(name)
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise BackupError("backup_invalid", "not a ZIP archive") from exc
    with archive:
        manifest = _manifest(archive)
        members = {info.filename: info for info in archive.infolist()}
        database_ok = False
        if DATABASE_ENTRY in members:
            scratch = folder() / f".check-{os.getpid()}-{time.time_ns()}.db"
            try:
                with archive.open(DATABASE_ENTRY) as source, open(scratch, "wb") as sink:
                    shutil.copyfileobj(source, sink, _CHUNK)
                if scratch.read_bytes()[:16] == SQLITE_HEADER:
                    connection = sqlite3.connect(scratch)
                    try:
                        database_ok = connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                    finally:
                        connection.close()
            except (sqlite3.DatabaseError, OSError):
                database_ok = False
            finally:
                scratch.unlink(missing_ok=True)
        damaged: list[str] = []
        for rel, (size, digest) in manifest.vault.items():
            member = members.get(VAULT_PREFIX + rel)
            if member is None or _safe_member(member.filename) != rel or member.file_size != size:
                damaged.append(rel)
                continue
            hasher = hashlib.sha256()
            with archive.open(member) as handle:
                while chunk := handle.read(_CHUNK):
                    hasher.update(chunk)
            if hasher.hexdigest() != digest:
                damaged.append(rel)
        for name_in_trash, (size, digest) in manifest.trash.items():
            member = members.get(TRASH_PREFIX + name_in_trash)
            if not TRASH_NAME.match(name_in_trash) or member is None or member.file_size != size:
                damaged.append(TRASH_PREFIX + name_in_trash)
                continue
            hasher = hashlib.sha256()
            with archive.open(member) as handle:
                while chunk := handle.read(_CHUNK):
                    hasher.update(chunk)
            if hasher.hexdigest() != digest:
                damaged.append(TRASH_PREFIX + name_in_trash)
        extra = [
            info.filename for info in archive.infolist()
            if info.filename.startswith(VAULT_PREFIX) and not info.is_dir()
            and _safe_member(info.filename) not in manifest.vault
        ]
        damaged.extend(extra)
    current = {rel: full for rel, full in _vault_files(paths.vault_root())}
    add = [rel for rel in manifest.vault if rel not in current]
    remove_ = [rel for rel in current if rel not in manifest.vault]
    change = [
        rel for rel, full in current.items()
        if rel in manifest.vault
        and (full.stat().st_size != manifest.vault[rel][0] or _hash_file(full) != manifest.vault[rel][1])
    ]
    return Brief(
        name=name, version=manifest.version, created=manifest.created, kind=manifest.kind, notes=manifest.notes,
        files=manifest.files, database_ok=database_ok, files_ok=not damaged, damaged=sorted(damaged)[:20],
        would_add=len(add), would_change=len(change), would_remove=len(remove_),
        examples={"add": sorted(add)[:10], "change": sorted(change)[:10], "remove": sorted(remove_)[:10]},
    )


def stage_restore(name: str) -> Brief:
    """Check, keep the current state as a backup, and lay the archive out for the next start."""
    with _lock:
        brief = check(name)
        if not brief.usable:
            raise BackupError("backup_damaged", "the archive is damaged; nothing was changed")
        create(kind=UPDATE, note=f"before restoring {name}")
        pending = pending_folder()
        shutil.rmtree(pending, ignore_errors=True)
        pending.mkdir(parents=True)
        try:
            with zipfile.ZipFile(path_of(name)) as archive:
                manifest = _manifest(archive)
                with archive.open(DATABASE_ENTRY) as source, open(pending / "nexlore.db", "wb") as sink:
                    shutil.copyfileobj(source, sink, _CHUNK)
                if SECRET_ENTRY in archive.namelist():
                    (pending / "secret.key").write_bytes(archive.read(SECRET_ENTRY))
                for rel in manifest.vault:
                    target = pending / "vault" / Path(*rel.split("/"))
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(VAULT_PREFIX + rel) as source, open(target, "wb") as sink:
                        shutil.copyfileobj(source, sink, _CHUNK)
                (pending / "vault").mkdir(exist_ok=True)
                (pending / "trash").mkdir(exist_ok=True)
                for name_in_trash in manifest.trash:
                    with archive.open(TRASH_PREFIX + name_in_trash) as source, open(
                        pending / "trash" / name_in_trash, "wb"
                    ) as sink:
                        shutil.copyfileobj(source, sink, _CHUNK)
                # Last: the manifest says the pending folder is complete.
                (pending / MANIFEST).write_bytes(json.dumps(asdict(manifest), ensure_ascii=False).encode())
        except BaseException:
            shutil.rmtree(pending, ignore_errors=True)
            raise
    logger.info("Backup staged for the next start created=%s", brief.created)
    return brief


def _end_restored_sessions(database: Path) -> None:
    """Sign-ins stored in the backup would come back to life, even ones ended since: everybody signs in anew."""
    connection = sqlite3.connect(database)
    try:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'").fetchone():
            connection.execute("DELETE FROM auth_sessions")
            connection.commit()
    finally:
        connection.close()


def restart_soon(delay: float = 1.5) -> None:
    """End the process shortly, after the answer went out; Docker starts it again (``restart: unless-stopped``)."""

    def stop() -> None:
        time.sleep(delay)
        logger.info("nexlore stops to restore a backup")
        if os.name == "nt":
            os._exit(3)
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except OSError:
            os._exit(0)
        time.sleep(10)
        os._exit(0)

    threading.Thread(target=stop, name="restart-for-restore", daemon=True).start()


def apply_pending() -> bool:
    """At the start, before anything opens the database: swap in a staged backup. Returns whether one was."""
    pending = pending_folder()
    if not pending.is_dir():
        return False
    if not (pending / MANIFEST).is_file() or not (pending / "nexlore.db").is_file():
        logger.warning("An incomplete restore was found and thrown away")
        shutil.rmtree(pending, ignore_errors=True)
        return False
    settings = get_settings()
    root = paths.vault_root()
    root.mkdir(parents=True, exist_ok=True)
    # The vault may be a folder Obsidian or Syncthing also use, even a mount: its content is swapped, not the folder.
    aside = root / f".nexlore-replaced-{time.time_ns()}"
    aside.mkdir()
    try:
        for entry in list(root.iterdir()):
            if entry.name == aside.name or entry.name.startswith(".nexlore-"):
                continue
            os.rename(entry, aside / entry.name)
        for entry in list((pending / "vault").iterdir()):
            shutil.move(str(entry), str(root / entry.name))
    except OSError:
        # Half swapped is the worst of both: put the old vault back and leave the pending folder for another try.
        logger.exception("Restoring the vault failed, the previous state is put back")
        for entry in list(root.iterdir()):
            if entry.name != aside.name and not entry.name.startswith(".nexlore-"):
                shutil.move(str(entry), str(pending / "vault" / entry.name))
        for entry in list(aside.iterdir()):
            os.rename(entry, root / entry.name)
        aside.rmdir()
        raise
    target = settings.database_path
    # Left behind, SQLite would read the old database's WAL into the restored one.
    for suffix in ("-wal", "-shm", "-journal"):
        target.with_name(target.name + suffix).unlink(missing_ok=True)
    shutil.copyfile(pending / "nexlore.db", target)
    _end_restored_sessions(target)
    if (pending / "secret.key").is_file():
        key = settings.data_dir / "secret.key"
        shutil.copyfile(pending / "secret.key", key)
        try:
            key.chmod(0o600)
        except OSError:
            pass
    # The trash goes with the database that knows its files (an archive from before M3 has none: empty trash).
    trash = paths.trash_root()
    shutil.rmtree(trash, ignore_errors=True)
    if (pending / "trash").is_dir():
        shutil.move(str(pending / "trash"), str(trash))
    manifest = json.loads((pending / MANIFEST).read_text(encoding="utf-8"))
    shutil.rmtree(pending, ignore_errors=True)
    shutil.rmtree(aside, ignore_errors=True)
    logger.info("Backup restored created=%s files=%s", manifest.get("created"), manifest.get("files"))
    return True


# --- Schedule -------------------------------------------------------------------------------------------------------


def schedule(db: Any) -> str:
    value = settings_service.get(db, "backup_schedule")
    return value if value in SCHEDULES else "off"


def keep(db: Any) -> int:
    value = settings_service.get(db, "backup_keep")
    return value if isinstance(value, int) and 1 <= value <= 365 else 7


def due(every: str, *, now: datetime | None = None) -> bool:
    """Whether a scheduled copy is due: in the night, or a day late at any hour for a server that sleeps at night."""
    if every not in INTERVALS:
        return False
    moment = now or datetime.now().astimezone()
    last = next((entry for entry in entries() if entry.kind == SCHEDULED), None)
    if last is None:
        return moment.hour in NIGHT
    try:
        previous = datetime.fromisoformat(last.created)
    except ValueError:
        return True
    days = (moment - previous).total_seconds() / 86400
    interval = INTERVALS[every] - 0.25
    return days >= interval and (moment.hour in NIGHT or days >= interval + CATCH_UP_DAYS)


def run_job() -> None:
    from ..db import SessionLocal

    with _lock:
        with SessionLocal() as db:
            every = schedule(db)
            count = keep(db)
        for leftover in folder().glob(".*") if folder().is_dir() else []:
            if leftover.is_file() and time.time() - leftover.stat().st_mtime > 6 * 3600:
                leftover.unlink(missing_ok=True)
        if due(every):
            create(kind=SCHEDULED)
            prune(count)


async def run_forever(stop: asyncio.Event) -> None:
    """The hourly look, first an hour after the start."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=INTERVAL_SECONDS)
            return
        except TimeoutError:
            pass
        try:
            await asyncio.to_thread(run_job)
        except Exception:
            logger.exception("Backup job failed")
