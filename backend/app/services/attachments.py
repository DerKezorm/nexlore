"""Attachments: files uploaded to a note, and everything that comes with keeping them.

**Where they go.** Into a folder ``Attachments`` next to the note (the operator may name it otherwise, ``Anhänge``
for instance), and the note links them with an ordinary relative Markdown link, the way GitHub, VS Code and
Obsidian read it. A picture pasted from the
clipboard has no name worth keeping: it is called after the note with a number (``Shopping 1.png``), or after the
pattern the operator chose (``pasted_name``: ``{note}``, ``{date}``, ``{time}``, ``{n}``, ``{n:3}``). Any other file
keeps its name, made safe for Windows, macOS and Linux, with a number when the name is taken, unless the operator
chose a pattern for those too (``uploaded_name``, with ``{filename}``). A ``/`` in either pattern makes folders below
the attachment folder: ``{note}/{filename}`` keeps each note's files in a folder of its own.

**On the way in.** The body is streamed into a hidden file in the target folder and counted while it arrives, against
the limit per file and the space left for the account; nothing large is held in memory. Then:

1. the kind is read from the content, never from the name;
2. place and device come out of photos and videos (``media.strip``, unless the operator turned it off);
3. a file whose content the space holds already is not stored twice: the one there is linked instead;
4. a HEIC photo gets a WebP beside it, and the note links the WebP (browsers other than Safari cannot show HEIC);
   the HEIC stays as the original.

**Space per account.** What an account uploaded counts against its space, in the vault and in the trash, until it is
gone for good. Files that came from elsewhere (the disk, an import) belong to nobody and count for nobody.
"""

from __future__ import annotations

import logging
import os
import posixpath
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import File
from . import index, mdparse, media, paths, settings_service, vault
from .prepare import hash_file, prepare
from .vault import TEMPORARY_PREFIX, Actor, VaultError

logger = logging.getLogger("nexlore.attachments")

MB = 1024 * 1024
#: Endings for what a pasted picture turns out to be.
ENDINGS = {"jpeg": ".jpg", "png": ".png", "gif": ".gif", "webp": ".webp", "heic": ".heic", "avif": ".avif",
           "bmp": ".bmp", "pdf": ".pdf", "mp4": ".mp4", "mov": ".mov"}
_ENDING = re.compile(r"^\.[A-Za-z0-9]{1,10}$")
#: How pasted pictures are named unless the operator chose otherwise: ``Shopping 1.png``.
PASTED_DEFAULT = "{note} {n}"
#: How uploaded files are named unless the operator chose otherwise: as they came.
UPLOADED_DEFAULT = "{filename}"
#: The placeholders of those patterns: the note's name, the uploaded file's name, the day and time of the upload, and
#: a running number (with ``{n:3}`` at least three digits: ``007``). A ``/`` makes folders below the attachment folder.
_PLACEHOLDER = re.compile(r"\{(note|filename|date|time|n)(?::([1-9]))?\}")
PATTERN_CHARS = 120


@dataclass
class Limits:
    per_file: int
    #: 0: no limit.
    quota: int
    used: int

    @property
    def left(self) -> int | None:
        return None if not self.quota else max(0, self.quota - self.used)


@dataclass
class Plan:
    """Where an upload goes, worked out before a byte is read."""

    space_id: int
    space: str
    #: Vault-relative folder the file lands in.
    folder: str
    directory: Path
    #: The note it is uploaded for, if any: links are written relative to it.
    note: str | None
    name: str
    pasted: bool
    limits: Limits
    strip: bool
    #: How the file is named when it belongs to a note: ``pasted_name`` for a pasted picture, else ``uploaded_name``.
    pattern: str = UPLOADED_DEFAULT


@dataclass
class Uploaded:
    #: What to link: the WebP for a HEIC photo, else the file itself.
    path: str
    size: int
    kind: str | None
    #: The file was there already (same content in the same space); nothing new was stored.
    duplicate: bool
    #: What came out of it: ``location``, ``device``, ``metadata``, or ``unchecked`` when that could not be checked.
    removed: list[str] = field(default_factory=list)
    #: The HEIC itself, when a WebP was made for it.
    original: str | None = None
    #: The link text for the note it was uploaded for (relative, escaped where Markdown needs it).
    link: str = ""


def folder_name() -> str:
    with SessionLocal() as db:
        return str(settings_service.get(db, "attachment_folder") or "Attachments")


def used_by(db: Session, account: str) -> int:
    """Bytes the account uploaded that are still kept: in the vault and in the trash."""
    return int(db.scalar(select(func.coalesce(func.sum(File.size), 0)).where(File.owner == account)) or 0)


def limits(account: str) -> Limits:
    with SessionLocal() as db:
        per_file = int(settings_service.get(db, "upload_max_mb") or 0) * MB
        quota = int(settings_service.get(db, "quota_mb") or 0) * MB
        return Limits(per_file=per_file, quota=quota, used=used_by(db, account))


def link_text(target: str, note: str) -> str:
    """How ``note`` links ``target``: relative to the note's folder, escaped where Markdown needs it, letters and
    umlauts as they are."""
    relative = posixpath.relpath(target, posixpath.dirname(note))
    return mdparse.escape_destination(relative)


def plan(*, note: str | None, folder: str | None, name: str, pasted: bool, actor: Actor) -> Plan:
    """Check an upload before it starts: where it goes, under what limits. ``note``: into that note's attachment
    folder; ``folder``: straight into that folder."""
    if (note is None) == (folder is None):
        raise VaultError("path_invalid", "name either a note or a folder")
    try:
        if note is not None:
            note = paths.parse(note)
            if not paths.is_note(note) or "/" not in note:
                raise VaultError("not_a_note", "attachments belong to a note")
            target_folder = posixpath.join(posixpath.dirname(note), paths.check_name(folder_name()))
        else:
            target_folder = paths.parse(folder or "")
        directory = paths.resolve(target_folder)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc
    space = paths.space_of(target_folder)
    with SessionLocal() as db:
        if note is not None and index_live(db, note) is None:
            raise VaultError("not_found", "no such note", 404)
        strip = bool(settings_service.get(db, "strip_location"))
        space_row = index.ensure_space(db, space)
        db.commit()
        space_id = space_row.id
    if not paths.resolve(space).is_dir():
        raise VaultError("not_found", "no such space", 404)
    if directory.exists() and not directory.is_dir():
        raise VaultError("exists", "a file of that name stands where the folder should be", 409)
    if note is None and not directory.is_dir():
        raise VaultError("not_found", "no such folder", 404)
    return Plan(
        space_id=space_id, space=space, folder=target_folder, directory=directory, note=note, name=name.strip(),
        pasted=pasted, limits=limits(actor.name), strip=strip,
        pattern=pasted_pattern() if pasted else uploaded_pattern(),
    )


def index_live(db: Session, rel: str) -> File | None:
    return db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))


def check_size(upload: Plan, size: int) -> None:
    """Refuse once ``size`` bytes are more than the limits allow."""
    if upload.limits.per_file and size > upload.limits.per_file:
        raise VaultError("too_large", "the file is larger than allowed", 413, limit=upload.limits.per_file)
    left = upload.limits.left
    if left is not None and size > left:
        raise VaultError("quota_exceeded", "no space left for this account", 413, left=left)


def temporary(upload: Plan) -> Path:
    upload.directory.mkdir(parents=True, exist_ok=True)
    return upload.directory / f"{TEMPORARY_PREFIX}{uuid.uuid4().hex}.upload"


def _ending(upload: Plan, kind: str | None) -> str:
    given = os.path.splitext(upload.name)[1]
    if upload.pasted or not given:
        return ENDINGS.get(kind or "", given if _ENDING.match(given) else ".bin")
    return given if _ENDING.match(given) else ".bin"


class PatternError(ValueError):
    pass


def check_pattern(pattern: str, *, uploaded: bool = False) -> str:
    """A name pattern as the operator typed it, or ``PatternError``: known placeholders only (``{filename}`` only for
    uploaded files, a pasted picture has no name of its own), ``/`` only between folders below the attachment
    folder, ``{n}`` only in the file's own name, and something that stays a name when it is filled in."""
    pattern = pattern.strip()
    if not pattern or len(pattern) > PATTERN_CHARS:
        raise PatternError("empty or too long")
    for found in _PLACEHOLDER.finditer(pattern):
        if found.group(2) and found.group(1) != "n":
            raise PatternError("only {n} takes a width")
        if found.group(1) == "filename" and not uploaded:
            raise PatternError("{filename} only for uploaded files")
    rest = _PLACEHOLDER.sub("", pattern)
    if "{" in rest or "}" in rest:
        raise PatternError("unknown placeholder")
    if "\\" in pattern:
        raise PatternError("folders are separated by /")
    parts = pattern.split("/")
    if any(found.group(1) == "n" for part in parts[:-1] for found in _PLACEHOLDER.finditer(part)):
        raise PatternError("{n} only in the file's name")
    # An empty part (``a//b``, a ``/`` at either end) or one of dots only (``..``) names nothing once filled in.
    if any(not _fill(part, "Note", "File", time.localtime(), 1).strip(" .") for part in parts):
        raise PatternError("an empty name, or a folder that climbs out")
    return pattern


def _fill(pattern: str, note: str, filename: str, moment: time.struct_time, number: int) -> str:
    def one(found: re.Match[str]) -> str:
        word = found.group(1)
        if word == "note":
            return note
        if word == "filename":
            return filename
        if word == "date":
            return time.strftime("%Y-%m-%d", moment)
        if word == "time":
            return time.strftime("%H-%M-%S", moment)
        return str(number).zfill(int(found.group(2) or 1))

    return _PLACEHOLDER.sub(one, pattern)


def _stored_pattern(key: str, default: str, *, uploaded: bool) -> str:
    with SessionLocal() as db:
        stored = str(settings_service.get(db, key) or "")
    try:
        return check_pattern(stored, uploaded=uploaded)
    except PatternError:
        return default


def pasted_pattern() -> str:
    return _stored_pattern("pasted_name", PASTED_DEFAULT, uploaded=False)


def uploaded_pattern() -> str:
    return _stored_pattern("uploaded_name", UPLOADED_DEFAULT, uploaded=True)


def _named(
    directory: Path, pattern: str, *, note: str, filename: str, ending: str, moment: time.struct_time
) -> tuple[str, str]:
    """Where in the attachment folder a file goes after the pattern, and its name: the folders before the last
    ``/`` (``Shopping`` for ``{note}/{filename}``, empty for none), and the name with the first free number for
    ``{n}``; a name without one gets a number of its own when it is taken (``2026-11-08 2.png``)."""
    *folders, last = pattern.split("/")
    below = [paths.safe_name(_fill(part, note, filename, moment, 1), "") for part in folders]
    target = directory.joinpath(*below)
    if not any(found.group(1) == "n" for found in _PLACEHOLDER.finditer(last)):
        return "/".join(below), _free_name(target, _fill(last, note, filename, moment, 1), ending, numbered=False)
    taken = {paths.fold(entry) for entry in os.listdir(target)} if target.is_dir() else set()
    number = 1
    while True:
        candidate = paths.safe_name(_fill(last, note, filename, moment, number), ending)
        if paths.fold(candidate) not in taken:
            return "/".join(below), candidate
        number += 1


def _free_name(directory: Path, base: str, ending: str, *, numbered: bool) -> str:
    """``base`` + ending, or with the first free number (always numbered for pasted pictures: ``Note 1.png``)."""
    taken = {paths.fold(entry) for entry in os.listdir(directory)} if directory.is_dir() else set()
    if not numbered:
        candidate = paths.safe_name(base, ending)
        if paths.fold(candidate) not in taken:
            return candidate
    number = 1 if numbered else 2
    while True:
        candidate = paths.safe_name(f"{base} {number}", ending)
        if paths.fold(candidate) not in taken:
            return candidate
        number += 1


def _place(source: Path, target: Path) -> None:
    for attempt in range(6):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            # Windows: a virus scanner looks at the fresh file for a moment.
            if attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))


def _record(db: Session, rel: str, actor: Actor) -> File:
    full = paths.vault_root().joinpath(*rel.split("/"))
    prepared = prepare(str(paths.vault_root()), rel)
    if prepared is None:
        raise VaultError("not_found", "the file is gone from the disk", 404)
    file = index.record(db, rel, b"", full.stat(), source=index.APP, author=actor.name, prepared=prepared)
    file.owner = actor.name
    return file


def _twin(db: Session, space_id: int, hashed: str, size: int) -> File | None:
    """A live file of the same content in the space, still on the disk."""
    for file in db.scalars(
        select(File).where(
            File.space_id == space_id, File.hash == hashed, File.size == size, File.deleted_at.is_(None),
            File.is_note.is_(False),
        ).order_by(File.id)
    ):
        full = paths.vault_root().joinpath(*file.path.split("/"))
        if full.is_file() and full.stat().st_size == size:
            return file
    return None


def _webp_beside(db: Session, original: File, made: Path | None, actor: Actor) -> File | None:
    """The WebP of a HEIC photo, next to it with the same name; made once. ``made``: converted already (outside the
    index lock, it takes a moment)."""
    rel = posixpath.splitext(original.path)[0] + ".webp"
    existing = index_live(db, rel)
    if existing is not None:
        return existing
    target = paths.vault_root().joinpath(*rel.split("/"))
    if made is None or not made.exists() or target.exists():
        return None
    _place(made, target)
    return _record(db, rel, actor)


def finish(upload: Plan, received: Path, size: int, actor: Actor) -> Uploaded:
    """Everything after the last byte arrived: kind, metadata, duplicates, name, index. ``received`` is gone after.

    The slow parts (reading the metadata, hashing, turning a HEIC into WebP) run before the index lock; under it only
    what must be decided at once: the space left, a twin, the name, the rows."""
    webp: Path | None = None
    try:
        with open(received, "rb") as handle:
            kind = media.sniff(handle.read(64))
        removed = sorted(media.strip(received, kind)) if upload.strip else []
        hashed, _stat = hash_file(str(received))
        if kind == "heic":
            webp = upload.directory / f"{TEMPORARY_PREFIX}{uuid.uuid4().hex}.webp"
            if not media.to_webp(received, webp):
                webp = None
        with index.guard, SessionLocal() as db:
            twin = _twin(db, upload.space_id, hashed, size)
            if twin is not None:
                file, duplicate = twin, True
            else:
                # Two uploads of one account at the same time each saw the same space left: counted again here,
                # where uploads come one after another.
                quota = upload.limits.quota
                if quota and used_by(db, actor.name) + size > quota:
                    raise VaultError("quota_exceeded", "no space left for this account", 413, left=0)
                ending = _ending(upload, kind)
                base = os.path.splitext(upload.name)[0] or "Untitled"
                below = ""
                if upload.note:
                    below, name = _named(upload.directory, upload.pattern, note=paths.stem(upload.note),
                                         filename=base, ending=ending, moment=time.localtime())
                else:
                    name = _free_name(upload.directory, base, ending, numbered=upload.pasted)
                folder = f"{upload.folder}/{below}" if below else upload.folder
                target = paths.vault_root().joinpath(*folder.split("/"))
                target.mkdir(parents=True, exist_ok=True)
                _place(received, target / name)
                file = _record(db, f"{folder}/{name}", actor)
                index.reresolve(db, file.space_id, [file.name_key])
                duplicate = False
            linked, original = file, None
            if kind == "heic":
                made = _webp_beside(db, file, webp, actor)
                if made is not None:
                    linked, original = made, file.path
                    index.reresolve(db, made.space_id, [made.name_key])
            db.commit()
            result = Uploaded(
                path=linked.path, size=file.size, kind=kind, duplicate=duplicate, removed=removed, original=original,
                link=link_text(linked.path, upload.note) if upload.note else "",
            )
    finally:
        if received.exists():
            received.unlink()
        if webp is not None and webp.exists():
            webp.unlink()
    logger.info(
        "Attachment %s file_id=%s bytes=%s kind=%s removed=%s",
        "linked again" if result.duplicate else "stored", file.id, size, kind or "other", ",".join(removed) or "-",
    )
    return result


# --- A new name for the attachment folders -------------------------------------------------------------------------


@dataclass
class Renamed:
    #: Folders that carry the new name now.
    renamed: int = 0
    #: Folders left as they were: one of the new name stands beside them already, or the move failed.
    left: list[str] = field(default_factory=list)


def folders_named(name: str) -> list[str]:
    """Every folder in the vault called ``name`` (case aside), deepest first: renaming one never moves another's
    path away under it. Dot folders belong to other programs and are not looked into."""
    wanted = paths.fold(name)
    root = paths.vault_root()
    found: list[str] = []
    for top, folders, _files in os.walk(root):
        folders[:] = [folder for folder in folders if not paths.is_hidden(folder)]
        relative = Path(top).relative_to(root).as_posix()
        for folder in folders:
            if paths.fold(folder) == wanted and relative != ".":
                found.append(f"{relative}/{folder}")
    return sorted(found, key=lambda rel: (-rel.count("/"), rel))


def rename_folders(old: str, new: str, actor: Actor) -> Renamed:
    """Give the attachment folders already there the new name, one move each: the links in the notes follow, as on
    any rename. A folder with the new name beside it stays as it is (the two would have to be merged)."""
    result = Renamed()
    if old == new:
        return result
    for source in folders_named(old):
        destination = f"{posixpath.dirname(source)}/{new}"
        if source == destination:
            continue
        try:
            # Refused (``exists``) when a folder of the new name stands beside it.
            vault.move(source, destination, actor=actor)
        except VaultError as exc:
            logger.warning("Attachment folder not renamed code=%s", exc.code)
            result.left.append(source)
            continue
        result.renamed += 1
    logger.info("Attachment folders renamed renamed=%s left=%s", result.renamed, len(result.left))
    return result
