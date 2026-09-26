"""Reading a file and taking it apart: the part of indexing that needs no database.

For a big scan this runs in worker processes, one file after another, while the main process only writes rows. So
this module imports nothing that opens the database or reads settings; ``paths`` for names is fine (it asks the
settings only when a function needs the vault folder, and these do not).
"""

from __future__ import annotations

import hashlib
import os
import zlib
from dataclasses import dataclass, field
from typing import Any

from . import mdparse, paths

#: A note larger than this is kept and versioned, but not read for links, tags and search.
MAX_NOTE_BYTES = 5 * 1024 * 1024


def name_key(rel: str) -> str:
    return paths.fold(paths.stem(rel))


def target_key(target: str) -> str:
    last = target.rstrip("/").rsplit("/", 1)[-1]
    if last.lower().endswith(paths.NOTE_SUFFIX):
        last = last[: -len(paths.NOTE_SUFFIX)]
    return paths.fold(last)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode(data: bytes) -> str:
    return data.decode("utf-8-sig", errors="replace")


def jsonable(value: object) -> object:
    """Front matter as JSON can hold it: YAML dates become text."""
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [jsonable(item) for item in value]
    if value is None or isinstance(value, bool | int | float | str):
        return value
    return str(value)


@dataclass(slots=True)
class Analysis:
    """What the index keeps of one note."""

    title: str
    front: Any = None
    features: dict[str, int] | None = None
    #: (casefolded key, as written)
    tags: list[tuple[str, str]] = field(default_factory=list)
    #: (kind, target, subpath, target_key, line)
    links: list[tuple[str, str, str, str, int]] = field(default_factory=list)
    #: The text for the full-text search; None for anything that is not searched.
    body: str | None = None


def analyse(rel: str, data: bytes) -> Analysis:
    result = Analysis(title=paths.stem(rel))
    if not paths.is_note(rel):
        return result
    if len(data) > MAX_NOTE_BYTES:
        result.features = {"too_large": 1}
        return result
    content = decode(data)
    parsed = mdparse.parse(content)
    result.front = jsonable(parsed.front) if parsed.front else None
    features = dict(parsed.features)
    if "�" in content and b"\xef\xbf\xbd" not in data:
        features["not_utf8"] = 1
    result.features = features or None
    if parsed.title:
        result.title = parsed.title[:1024]
    tags: dict[str, str] = {}
    for tag in parsed.tags:
        tags.setdefault(paths.fold(tag)[:255], tag[:255])
    result.tags = list(tags.items())
    result.links = [
        (link.kind, link.target[:1024], link.subpath[:1024], target_key(link.target)[:255], link.line)
        for link in parsed.links
    ]
    result.body = parsed.body
    return result


@dataclass(slots=True)
class Prepared:
    rel: str
    size: int
    mtime_ns: int
    hash: str
    analysis: Analysis
    #: The content as a version stores it, for notes.
    compressed: bytes | None


def prepare(root: str, rel: str) -> Prepared | None:
    """Read and take apart one file. None when it cannot be read (gone in between, no permission)."""
    try:
        with open(os.path.join(root, *rel.split("/")), "rb") as handle:
            data = handle.read()
            stat = os.fstat(handle.fileno())
    except OSError:
        return None
    note = paths.is_note(rel)
    return Prepared(
        rel=rel, size=stat.st_size, mtime_ns=stat.st_mtime_ns, hash=digest(data), analysis=analyse(rel, data),
        compressed=zlib.compress(data, 6) if note else None,
    )
