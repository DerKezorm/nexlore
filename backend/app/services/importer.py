"""Bringing an Obsidian vault in, and the report on what nexlore makes of it.

Two ways in:

* **In place**: the vault folder lies (or is mounted) at the top of nexlore's vault, and Obsidian keeps working on
  it. That is a space like any other; ``report`` tells what nexlore found.
* **As an archive**: a ZIP of the vault is unpacked into a new space. Checked before a byte is written: no entry may
  leave the space, no link entries, limits on size, count and compression ratio (a ZIP bomb stops at the check). A
  single folder around everything, as Obsidian's own export and most zip tools make, is taken off.

``.obsidian/`` and every other hidden folder come along untouched and are never read for anything but the list of
community plugins in the report. Plugin syntax (Dataview, Templater, Excalidraw) stays exactly as it is; the report
names the notes that use it, because nexlore shows it as code rather than running it.
"""

from __future__ import annotations

import json
import logging
import os
import posixpath
import shutil
import stat
import uuid
import zipfile
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from ..db import SessionLocal
from ..models import File, Link, Space
from . import index, paths
from .vault import VaultError

logger = logging.getLogger("nexlore.import")

MAX_ENTRIES = 200_000
MAX_FILE_BYTES = 1024**3
MAX_TOTAL_BYTES = 4 * 1024**3
#: Uncompressed to compressed; above this for anything larger than a megabyte, the archive is refused as a bomb.
MAX_RATIO = 200
#: How many examples of each finding the report lists; the count is always complete.
EXAMPLES = 20

#: Report keys for plugin syntax, from the parser's feature counts.
PLUGIN_FEATURES = {
    "dataview": "Dataview blocks",
    "dataviewjs": "DataviewJS blocks",
    "dataview_inline": "Dataview inline queries",
    "dataview_fields": "Dataview fields (key:: value)",
    "tasks_queries": "Tasks plugin queries",
    "query": "Search queries",
    "templater": "Templater commands",
    "excalidraw": "Excalidraw drawings",
}
OBSIDIAN_FEATURES = ("callouts", "embeds", "comments", "highlights", "math_blocks", "mermaid", "tasks_open")


@dataclass
class Finding:
    count: int = 0
    examples: list[str] = field(default_factory=list)

    def add(self, example: str) -> None:
        self.count += 1
        if len(self.examples) < EXAMPLES:
            self.examples.append(example)


@dataclass
class Report:
    space: str
    notes: int = 0
    other_files: int = 0
    bytes: int = 0
    links: int = 0
    unresolved_links: Finding = field(default_factory=Finding)
    #: Plugin syntax by kind: how many notes use it, some of them by path.
    plugins: dict[str, Finding] = field(default_factory=dict)
    #: Obsidian's own syntax nexlore understands, counted over all notes.
    obsidian: dict[str, int] = field(default_factory=dict)
    front_matter_errors: Finding = field(default_factory=Finding)
    not_utf8: Finding = field(default_factory=Finding)
    too_large: Finding = field(default_factory=Finding)
    #: Names that would not survive on another system (a colon, a trailing dot), found on disk.
    unportable_names: Finding = field(default_factory=Finding)
    #: Two names in one folder that differ only in case: on Windows and macOS only one of them can exist.
    case_collisions: Finding = field(default_factory=Finding)
    #: Names changed while unpacking because this system cannot hold them; links to them may need fixing.
    renamed_on_import: Finding = field(default_factory=Finding)
    hidden_skipped: int = 0
    obsidian_config: bool = False
    community_plugins: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _community_plugins(space_dir: Path) -> tuple[bool, list[str]]:
    config = space_dir / ".obsidian"
    if not config.is_dir() or config.is_symlink():
        return False, []
    try:
        listed = json.loads((config / "community-plugins.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True, []
    if not isinstance(listed, list):
        return True, []
    return True, sorted(item[:100] for item in listed if isinstance(item, str))[:200]


def report(space_name: str) -> Report:
    """What nexlore found in a space: counts, plugin syntax, problems, with examples."""
    try:
        folder = paths.parse(space_name)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc
    root = paths.vault_root()
    space_dir = root / folder
    if "/" in folder or not space_dir.is_dir():
        raise VaultError("not_found", "no such space", 404)
    result = Report(space=folder)
    result.obsidian_config, result.community_plugins = _community_plugins(space_dir)
    obsidian: Counter[str] = Counter()
    with SessionLocal() as db:
        space_id = db.scalar(select(Space.id).where(Space.folder == folder))
        rows = []
        if space_id is not None:
            rows = db.execute(
                select(File.id, File.path, File.is_note, File.size, File.features).where(
                    File.space_id == space_id, File.deleted_at.is_(None)
                ).order_by(File.path)
            ).all()
            result.links = db.scalar(select(func.count()).select_from(Link).where(Link.space_id == space_id)) or 0
            for target, source in db.execute(
                select(Link.target, File.path)
                .join(File, File.id == Link.source_id)
                .where(Link.space_id == space_id, Link.target_id.is_(None))
                .order_by(File.path, Link.line)
            ):
                result.unresolved_links.add(f"{source}: {target}")
    for _file_id, path, is_note, size, features in rows:
        result.bytes += size
        if not is_note:
            result.other_files += 1
            continue
        result.notes += 1
        features = features or {}
        for key, label in PLUGIN_FEATURES.items():
            if features.get(key):
                result.plugins.setdefault(label, Finding()).add(path)
        for key in OBSIDIAN_FEATURES:
            obsidian[key] += int(features.get(key, 0))
        if features.get("front_matter_errors"):
            result.front_matter_errors.add(path)
        if features.get("not_utf8"):
            result.not_utf8.add(path)
        if features.get("too_large"):
            result.too_large.add(path)
        if path.lower().endswith(".excalidraw.md") and not features.get("excalidraw"):
            result.plugins.setdefault(PLUGIN_FEATURES["excalidraw"], Finding()).add(path)
    result.obsidian = {key: value for key, value in obsidian.items() if value}
    _names(space_dir, root, result)
    return result


def _names(space_dir: Path, root: Path, result: Report) -> None:
    """Walk the disk once for what the index does not keep: unportable names, case twins, hidden entries."""
    for directory, subdirs, files in os.walk(space_dir):
        hidden = [name for name in subdirs if paths.is_hidden(name)]
        result.hidden_skipped += len(hidden) + sum(1 for name in files if paths.is_hidden(name))
        subdirs[:] = sorted(name for name in subdirs if not paths.is_hidden(name))
        seen: dict[str, str] = {}
        for name in sorted([*subdirs, *(name for name in files if not paths.is_hidden(name))]):
            rel = paths.relative(Path(directory) / name, root=root)
            if paths.portable_problem(name):
                result.unportable_names.add(rel)
            key = paths.fold(name)
            if key in seen:
                result.case_collisions.add(f"{posixpath.dirname(rel)}: {seen[key]} / {name}")
            seen[key] = name


# --- Archives -------------------------------------------------------------------------------------------------------


def _entry_parts(info: zipfile.ZipInfo) -> list[str] | None:
    """The parts of an archive entry's path, or None for one that must not be unpacked."""
    name = info.filename.replace("\\", "/")
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        return None
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    if any(ord(char) < 32 for part in parts for char in part):
        return None
    return parts


def _mac_leftover(parts: list[str]) -> bool:
    """What the Finder adds when it packs a folder: resource forks and folder settings, not part of the vault."""
    return parts[0] == "__MACOSX" or parts[-1] == ".DS_Store" or parts[-1].startswith("._")


def _is_link(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def _portable(part: str, report_: Report, whole: str) -> str:
    """A part as this system can hold it. Hidden parts stay as they are; they are not nexlore's."""
    if paths.is_hidden(part) or paths.portable_problem(part) is None:
        return part
    stem_, suffix = os.path.splitext(part)
    fixed = paths.safe_name(stem_, suffix) if suffix and len(suffix) <= 10 else paths.safe_name(part, "")
    report_.renamed_on_import.add(whole)
    return fixed


def check_archive(archive: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, list[str]]]:
    """Every entry to unpack with its parts, or ``VaultError`` for an archive that is refused as a whole."""
    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        raise VaultError("archive_too_many_files", "the archive holds too many files", 413)
    total = 0
    entries: list[tuple[zipfile.ZipInfo, list[str]]] = []
    for info in infos:
        parts = _entry_parts(info)
        if parts is None or _is_link(info):
            raise VaultError("archive_unsafe", "the archive holds an entry that would leave its folder", 400)
        if not parts or _mac_leftover(parts):
            continue
        if info.file_size > MAX_FILE_BYTES:
            raise VaultError("archive_too_large", "a file in the archive is too large", 413)
        if info.file_size > 1024**2 and info.compress_size and info.file_size / info.compress_size > MAX_RATIO:
            raise VaultError("archive_unsafe", "the archive is packed suspiciously tightly", 400)
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise VaultError("archive_too_large", "the archive is too large", 413)
        entries.append((info, parts))
    # One folder around everything (the vault's own name): take it off.
    tops = {parts[0] for info, parts in entries if not (info.is_dir() and len(parts) == 1)}
    single_top = len(tops) == 1 and all(len(parts) > 1 or info.is_dir() for info, parts in entries)
    if single_top and not paths.is_hidden(next(iter(tops))):
        entries = [(info, parts[1:]) for info, parts in entries if len(parts) > 1]
    return entries


def import_archive(archive_path: Path, space_name: str) -> Report:
    """Unpack a ZIP of an Obsidian vault into a new space, index it, and report."""
    try:
        name = paths.check_name(space_name.strip())
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc
    root = paths.vault_root()
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    if target.exists() or any(paths.fold(entry) == paths.fold(name) for entry in os.listdir(root)):
        raise VaultError("exists", "a space of that name exists", 409)
    try:
        archive = zipfile.ZipFile(archive_path)
    except zipfile.BadZipFile as exc:
        raise VaultError("archive_invalid", "not a ZIP archive", 400) from exc
    staging = root / f".nexlore-import-{uuid.uuid4().hex}"
    result = Report(space=name)
    written = 0
    try:
        with archive:
            entries = check_archive(archive)
            staging.mkdir()
            for info, parts in entries:
                whole = "/".join(parts)
                fixed = [_portable(part, result, whole) for part in parts]
                destination = staging.joinpath(*fixed)
                if not destination.resolve().is_relative_to(staging.resolve()):
                    raise VaultError("archive_unsafe", "the archive holds an entry that would leave its folder", 400)
                if info.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    # Two entries that land on one name (case, or a renamed part): keep both.
                    destination = destination.parent / paths.unique_name(destination.parent, destination.name)
                    result.renamed_on_import.add(whole)
                with archive.open(info) as source, open(destination, "wb") as sink:
                    copied = 0
                    while chunk := source.read(1024 * 1024):
                        copied += len(chunk)
                        written += len(chunk)
                        if copied > MAX_FILE_BYTES or written > MAX_TOTAL_BYTES:
                            raise VaultError("archive_too_large", "the archive is larger than it claims", 413)
                        sink.write(chunk)
        os.rename(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    logger.info("Archive unpacked into a new space files=%s bytes=%s", len(entries), written)
    with index.guard, SessionLocal() as db:
        index.ensure_space(db, name)
        db.commit()
    index.refresh([name])
    found = report(name)
    found.renamed_on_import = result.renamed_on_import
    return found
