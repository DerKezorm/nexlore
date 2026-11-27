"""What goes into a backup of nexlore and how it comes back: the hooks of the shared module ``sicherung``
(``app/vendor/nexsicherung``, bauplaene/sicherung 1.0.1). The module runs everything around them (names, list,
schedule, keeping, upload, download, the copy before a restore, staging and the start).

The archive keeps nexlore's format, so every backup made before the module stays readable and restorable:

* **The database is copied with SQLite's backup API**, never as a file: it runs in WAL mode. The copy is taken under
  ``index.guard`` together with a snapshot of the trash folder, so the archive's trash is the one its database knows;
  the vault's files are copied after, without holding up saves. Whatever changed in between, the scan after a restore
  brings the index back in line with the files; history and trash are in the database copy.
* **Everything in the vault goes in**, hidden folders too: ``.obsidian/`` belongs to the vault that was backed up.
  Only nexlore's own temporary files stay out (``.nexlore-*``).
* **The manifest** (``nexlore-backup.json``, written last) lists every file of the vault and of the trash with its
  size and sha256, so the check before a restore can tell a damaged archive from a good one, and say what a restore
  would change.
* **A restore swaps the vault's content, not the folder:** the vault may be a folder Obsidian or Syncthing also use,
  even a mount. Then the database (every session ends), the key and the trash. All or nothing.

The archive is not encrypted: it lies in the data folder next to the database it copies. Downloading it asks for the
operator's password once more (the module).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sqlite3
import time
import zipfile
from pathlib import Path
from typing import Any

from .. import private
from ..config import get_settings
from ..vendor import nexsicherung
from ..vendor.nexsicherung import Checked, Described, Part, Schedule, tools
from ..vendor.nexsicherung.errors import BackupError
from . import index, paths, settings_service

logger = logging.getLogger("nexlore.backups")

MANIFEST = "nexlore-backup.json"
DATABASE_ENTRY = "database/nexlore.db"
VAULT_PREFIX = "vault/"
TRASH_PREFIX = "trash/"
#: The server's key: without it the sealed secrets of the database (providers, the mail password, second factors) are
#: lost after a restore on a new server.
SECRET_ENTRY = "secret.key"
#: A file waiting in the trash folder: its row id. Nothing else is packed or unpacked from there.
TRASH_NAME = re.compile(r"^\d{1,18}$")
#: Limits of what a check or a restore unpacks: the database and each file (the size in an archive may lie).
DATABASE_MAX = 64 * 1024**3
MEMBER_MAX = 64 * 1024**3
#: How many damaged members and how many examples of each change the check names (as before the module).
DAMAGED_SHOWN = 20
EXAMPLES_SHOWN = 10

#: The schedule as nexlore kept it before the module (``backup_schedule``, ``backup_keep``; their defaults in
#: ``settings_service.DEFAULTS``), with the time of day the module adds (``backup_time``): the night's hour nexlore
#: used before (3 to 6) is 03:00.
DEFAULT_EVERY = "daily"
DEFAULT_TIME = "03:00"
DEFAULT_KEEP = 7

#: Where the settings page shows the backups (the operator's notification links there).
STORAGE_PAGE = "/settings/storage"


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
    with index.guard:
        tools.copy_database(get_settings().database_path, target)
        _snapshot_trash(trash)


def _manifest(archive: zipfile.ZipFile) -> dict[str, Any]:
    try:
        raw = json.loads(tools.read_small(archive, MANIFEST, limit=256 * 1024 * 1024).decode("utf-8"))
    except (KeyError, ValueError, *tools.DAMAGE) as exc:
        raise BackupError("backup_invalid", "the archive has no readable manifest") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("vault", {}), dict) \
            or not isinstance(raw.get("trash", {}), dict):
        raise BackupError("backup_invalid", "the manifest has the wrong shape")
    return raw


def _safe_vault(name: str) -> str | None:
    """The vault-relative path of an archive member, or None when it is not a plain path inside the vault (the rules
    of before: no empty part, no ``.`` or ``..``, no backslash, no drive, no control character)."""
    rel = tools.safe_member(name, VAULT_PREFIX)
    if rel is None:
        return None
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts) or ":" in parts[0]:
        return None
    return rel


def write_archive(target: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """The archive as nexlore made it before the module and as ``pack`` makes it now. Returns the manifest written."""
    settings = get_settings()
    database = target.with_name(target.name + ".db")
    trash = target.with_name(target.name + ".trash")
    manifest = {**manifest, "notes": 0, "files": 0, "bytes": 0, "vault": {}, "trash": {}}
    try:
        # Only the owner's before a byte is in it: the archive holds the key and everything else.
        private.new_file(database)
        _database_copy(database, trash)
        private.tighten(trash)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(database, DATABASE_ENTRY)
            key = settings.data_dir / "secret.key"
            if key.is_file():
                archive.write(key, SECRET_ENTRY)
            for rel, full in _vault_files(paths.vault_root()):
                try:
                    size = full.stat().st_size
                    archive.write(full, VAULT_PREFIX + rel)
                    manifest["vault"][rel] = [size, tools.sha256_file(full)]
                except OSError as exc:
                    logger.warning("A file could not be backed up and was left out: %s", exc.strerror)
                    continue
                manifest["files"] += 1
                manifest["bytes"] += size
                manifest["notes"] += int(rel.lower().endswith(paths.NOTE_SUFFIX))
            for full in sorted(trash.iterdir()):
                try:
                    archive.write(full, TRASH_PREFIX + full.name)
                    manifest["trash"][full.name] = [full.stat().st_size, tools.sha256_file(full)]
                except OSError as exc:
                    logger.warning("A file in the trash could not be backed up and was left out: %s", exc.strerror)
            # Last: an archive without its manifest is recognisably incomplete.
            archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False))
    finally:
        database.unlink(missing_ok=True)
        shutil.rmtree(trash, ignore_errors=True)
    logger.info("Backup written kind=%s files=%s bytes=%s", manifest.get("kind"), manifest["files"], manifest["bytes"])
    return manifest


def _member_damaged(archive: zipfile.ZipFile, member: zipfile.ZipInfo | None, size: Any, digest: Any) -> bool:
    if member is None or member.file_size != size:
        return True
    try:
        return tools.sha256_member(archive, member, limit=MEMBER_MAX) != (size, digest)
    except (BackupError, *tools.DAMAGE):
        return True


def _end_restored_sessions(database: Path) -> None:
    """Sign-ins stored in the backup would come back to life, even ones ended since: everybody signs in anew."""
    connection = sqlite3.connect(database)
    try:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'").fetchone():
            connection.execute("DELETE FROM auth_sessions")
            connection.commit()
    finally:
        connection.close()


def _size_of(root: Path, deadline: float) -> tuple[int, bool]:
    """The bytes under ``root`` (links not followed), and whether counting finished before ``deadline``."""
    total = 0
    for directory, subdirs, files in os.walk(root, followlinks=False):
        if time.monotonic() > deadline:
            return total, False
        subdirs[:] = [name for name in subdirs if not os.path.islink(os.path.join(directory, name))]
        for name in files:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except OSError:
                continue
    return total, True


class NexloreHooks(nexsicherung.AppHooks):
    # --- What goes in

    def pack(self, target: Path, *, kind: str, note: str, created: str) -> None:
        from .. import __version__

        write_archive(target, {"version": __version__, "created": created, "kind": kind, "note": note})

    def describe(self, path: Path) -> Described:
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
                if DATABASE_ENTRY not in archive.namelist():
                    raise BackupError("backup_invalid", "the archive holds no database")
        except zipfile.BadZipFile as exc:
            raise BackupError("backup_invalid", "not a ZIP archive") from exc
        return Described(
            created=str(manifest.get("created") or "") or None, kind=str(manifest.get("kind") or "manual"),
            note=str(manifest.get("note") or ""), version=str(manifest.get("version") or ""),
            facts={"notes": int(manifest.get("notes") or 0), "files": int(manifest.get("files") or 0)},
        )

    def check(self, path: Path, *, viewer: Any = None, archive_password: str | None = None) -> Checked:
        """The trial run: is the archive whole, and what would a restore change in the vault?"""
        scratch = nexsicherung.archives.scratch("check")
        try:
            with zipfile.ZipFile(path) as archive:
                manifest = _manifest(archive)
                vault: dict[str, list[Any]] = manifest.get("vault", {})
                trash: dict[str, list[Any]] = manifest.get("trash", {})
                members = {info.filename: info for info in archive.infolist()}
                try:
                    database_ok = DATABASE_ENTRY in members and tools.read_database(
                        archive, DATABASE_ENTRY, scratch, limit=DATABASE_MAX)
                except BackupError:
                    database_ok = False
                damaged: list[str] = []
                for rel, (size, digest) in vault.items():
                    member = members.get(VAULT_PREFIX + rel)
                    if member is not None and _safe_vault(member.filename) != rel:
                        member = None
                    if _member_damaged(archive, member, size, digest):
                        damaged.append(rel)
                for name_in_trash, (size, digest) in trash.items():
                    member = members.get(TRASH_PREFIX + name_in_trash) if TRASH_NAME.match(name_in_trash) else None
                    if _member_damaged(archive, member, size, digest):
                        damaged.append(TRASH_PREFIX + name_in_trash)
                damaged += [
                    info.filename for info in archive.infolist()
                    if info.filename.startswith(VAULT_PREFIX) and not info.is_dir()
                    and _safe_vault(info.filename) not in vault
                ]
        except zipfile.BadZipFile as exc:
            raise BackupError("backup_invalid", "not a ZIP archive") from exc
        finally:
            try:
                scratch.unlink(missing_ok=True)
            except OSError:
                # Still held for a moment: a hidden name the module tidies away later.
                pass
        current = dict(_vault_files(paths.vault_root()))
        add = [rel for rel in vault if rel not in current]
        remove = [rel for rel in current if rel not in vault]
        change = [
            rel for rel, full in current.items()
            if rel in vault and (full.stat().st_size != vault[rel][0] or tools.sha256_file(full) != vault[rel][1])
        ]
        details = {
            "would_add": len(add), "would_change": len(change), "would_remove": len(remove),
            "examples": {"add": sorted(add)[:EXAMPLES_SHOWN], "change": sorted(change)[:EXAMPLES_SHOWN],
                         "remove": sorted(remove)[:EXAMPLES_SHOWN]},
        }
        return Checked(database_ok=database_ok, files_ok=not damaged, damaged=sorted(damaged)[:DAMAGED_SHOWN],
                       details=details)

    # --- How it comes back, at the next start

    def unpack(self, path: Path, pending: Path, *, archive_password: str | None = None) -> None:
        with zipfile.ZipFile(path) as archive:
            manifest = _manifest(archive)
            tools.extract(archive, DATABASE_ENTRY, pending / "nexlore.db", limit=DATABASE_MAX)
            if SECRET_ENTRY in archive.namelist():
                (pending / "secret.key").write_bytes(tools.read_small(archive, SECRET_ENTRY, limit=4096))
            (pending / "vault").mkdir()
            for rel in manifest.get("vault", {}):
                if _safe_vault(VAULT_PREFIX + rel) != rel:
                    raise BackupError("backup_damaged", "a file name leaves the vault")
                target = pending / "vault" / Path(*rel.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                tools.extract(archive, VAULT_PREFIX + rel, target, limit=MEMBER_MAX)
            (pending / "trash").mkdir()
            for name_in_trash in manifest.get("trash", {}):
                if not TRASH_NAME.fullmatch(name_in_trash):
                    raise BackupError("backup_damaged", "a file name leaves the trash")
                tools.extract(archive, TRASH_PREFIX + name_in_trash, pending / "trash" / name_in_trash,
                              limit=MEMBER_MAX)

    def tidy(self) -> None:
        """The rest of an earlier restore, left in the vault (review P7.4): the vault may be shared with Obsidian."""
        root = paths.vault_root()
        if not root.is_dir():
            return
        for leftover in root.glob(".nexlore-replaced-*"):
            if leftover.is_dir() and not leftover.is_symlink() and not tools.remove_tree(leftover):
                logger.warning("A folder set aside by a restore could not be removed yet: %s", leftover.name)

    def apply(self, pending: Path) -> None:
        """The vault's content is swapped (the old one set aside in the vault until the end), then the database (its
        WAL left behind would be read into the restored one, every session ends), the key and the trash. All or
        nothing: on a failure the vault, the database, the key and the trash from before are put back."""
        settings = get_settings()
        root = paths.vault_root()
        root.mkdir(parents=True, exist_ok=True)
        target = settings.database_path
        key = settings.data_dir / "secret.key"
        trash = paths.trash_root()
        stamp = time.time_ns()
        aside = root / f".nexlore-replaced-{stamp}"
        database_aside = target.with_name(f"{target.name}.replaced-{stamp}")
        key_aside = key.with_name(f"{key.name}.replaced-{stamp}")
        trash_aside = trash.with_name(f"{trash.name}.replaced-{stamp}")
        aside.mkdir()
        # What went aside and what came in from the backup: on a failure exactly that goes back.
        set_aside: list[str] = []
        brought: list[str] = []
        database_moved = key_moved = trash_moved = trash_brought = False
        try:
            for entry in list(root.iterdir()):
                if entry.name == aside.name or entry.name.startswith(".nexlore-"):
                    continue
                os.rename(entry, aside / entry.name)
                set_aside.append(entry.name)
            for entry in list((pending / "vault").iterdir()):
                shutil.move(str(entry), str(root / entry.name))
                brought.append(entry.name)
            for suffix in ("-wal", "-shm", "-journal"):
                target.with_name(target.name + suffix).unlink(missing_ok=True)
            if target.exists():
                os.replace(target, database_aside)
                database_moved = True
            shutil.copyfile(pending / "nexlore.db", target)
            _end_restored_sessions(target)
            if (pending / "secret.key").is_file():
                if key.exists():
                    os.replace(key, key_aside)
                    key_moved = True
                shutil.copyfile(pending / "secret.key", key)
                private.tighten(key)
            # The trash goes with the database that knows its files (an archive from before M3 has none: empty).
            if trash.exists():
                os.replace(trash, trash_aside)
                trash_moved = True
            if (pending / "trash").is_dir():
                shutil.move(str(pending / "trash"), str(trash))
                trash_brought = True
        except Exception:
            logger.exception("Restoring the backup failed, the previous state is put back")
            if trash_brought and trash.exists():
                tools.remove_tree(trash)
            if trash_moved:
                os.replace(trash_aside, trash)
            if key_moved:
                os.replace(key_aside, key)
            if database_moved:
                os.replace(database_aside, target)
            for name in brought:
                shutil.move(str(root / name), str(pending / "vault" / name))
            for name in set_aside:
                os.rename(aside / name, root / name)
            aside.rmdir()
            raise
        if database_moved:
            database_aside.unlink(missing_ok=True)
        if key_moved:
            key_aside.unlink(missing_ok=True)
        if trash_moved:
            tools.remove_tree(trash_aside)
        if not tools.remove_tree(aside):
            logger.warning("A folder set aside by a restore could not be removed yet: %s", aside.name)
        logger.info("Backup restored")

    # --- The schedule, under nexlore's own keys

    def load_schedule(self) -> Schedule:
        from ..db import SessionLocal

        with SessionLocal() as db:
            every = settings_service.get(db, "backup_schedule")
            at = settings_service.get(db, "backup_time")
            keep = settings_service.get(db, "backup_keep")
        return Schedule(
            every=every if every in nexsicherung.EVERY else DEFAULT_EVERY,
            time=at if isinstance(at, str) and nexsicherung.model.TIME.match(at) else DEFAULT_TIME,
            keep=keep if isinstance(keep, int) and nexsicherung.model.KEEP_MIN <= keep <= nexsicherung.model.KEEP_MAX
            else DEFAULT_KEEP,
        )

    def save_schedule(self, schedule: Schedule) -> None:
        from ..db import SessionLocal

        with SessionLocal() as db:
            settings_service.save(db, {"backup_schedule": schedule.every, "backup_time": schedule.time,
                                       "backup_keep": schedule.keep})

    # --- The storage: the vault is a part of its own, and may lie outside the data folder

    def parts(self) -> list[Part] | None:
        config = nexsicherung.current()
        root = paths.vault_root()
        found = nexsicherung.space.measure(config.data_dir, config.parts, config.database_names(), config.backups)
        if root.parent == config.data_dir:
            return found
        size, whole = _size_of(root, time.monotonic() + nexsicherung.space.COUNT_SECONDS)
        return [*found[:1], Part("vault", size, "", whole), *found[1:]]

    def places(self) -> dict[str, Path]:
        return {"vault": paths.vault_root()}

    # --- Telling the operators

    def tell(self, event: str, details: dict[str, Any]) -> None:
        from . import notify

        if event in ("backup_failed", "restore_failed"):
            notify.operators(notify.words(event), STORAGE_PAGE, 5)


def configure() -> NexloreHooks:
    """The module set up for nexlore: its folders, version and hooks. At the start, before ``apply_pending``; done on
    import too, so the tests find it configured."""
    from .. import __version__

    settings = get_settings()
    vault = settings.vault_dir
    hooks = NexloreHooks()
    nexsicherung.configure(nexsicherung.AppConfig(
        app_name="nexlore", data_dir=settings.data_dir, version=__version__, hooks=hooks,
        database_path=settings.database_path,
        # The vault is a part of its own; outside the data folder ``parts`` measures it there.
        parts={"vault": (vault.name,) if vault is not None and vault.parent == settings.data_dir else (),
               "trash": ("trash",)},
    ))
    return hooks
