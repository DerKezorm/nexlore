"""
Renaming a tag in every note that carries it, as the Tag Wrangler plugin does in Obsidian: ``#project`` becomes
``#work`` and ``#project/garden`` becomes ``#work/garden``, in the text and in the front matter's ``tags`` (a list,
a flow list or one line of words). Only the tag's letters change; quotes, a ``#`` in front, the rest of the line and
every other byte stay.

Written only in spaces the account may write in, never into a note someone is editing (its lock): those are counted
and left, so nobody's typing turns into a conflict copy. Notes go in parts, each part briefly under the index lock.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from sqlalchemy import ColumnElement, or_, select

from ..db import SessionLocal
from ..models import File, Tag
from . import index, mdparse, paths
from .vault import _valid_lock, atomic_write

logger = logging.getLogger("nexlore.tags")

#: What a tag may be after renaming: letters, digits, _, - and / between parts; not only digits.
TAG_NAME = re.compile(r"^[\w-]+(?:/[\w-]+)*$")
PART = 100

_KEY = re.compile(r"^(tags?)[ \t]*:(.*)$")
_ITEM_HEAD = re.compile(r"^[ \t]*-[ \t]+")


def _item(line: str) -> tuple[str, str, str] | None:
    """A list item of the front matter as (dash with its blanks, value, blanks at the end). Split by hand: the
    pattern before tried every blank in the line as the end, and a line of 80,000 blanks took 50 s (review before
    1.0.0)."""
    head = _ITEM_HEAD.match(line)
    if head is None:
        return None
    rest = line[head.end():]
    value = rest.rstrip(" \t")
    return head.group(0), value, rest[len(value):]
_TOKEN = re.compile(r"""(["']?)(#?)([\w/-]+)(\1)""")


@dataclass
class Renamed:
    changed: int = 0
    #: Notes with the tag that someone is editing now: left as they are.
    locked: int = 0
    #: Notes with the tag in spaces the account may only read.
    read_only: int = 0


def valid(name: str) -> bool:
    return bool(TAG_NAME.match(name)) and not name.replace("/", "").isdigit() and len(name) <= 255


def _renamed(tag: str, old_key: str, new: str) -> str | None:
    key = paths.fold(tag)
    if key == old_key:
        return new
    if key.startswith(old_key + "/"):
        return new + tag[len(old_key) :]
    return None


def _swap_tokens(value: str, old_key: str, new: str) -> str:
    """Tags in a flow list or a line of words: each token alone, its quotes and ``#`` kept."""

    def swap(match: re.Match[str]) -> str:
        quote, hash_sign, tag, _ = match.groups()
        replaced = _renamed(tag, old_key, new)
        return match.group(0) if replaced is None else f"{quote}{hash_sign}{replaced}{quote}"

    return _TOKEN.sub(swap, value)


def _front(block: str, old_key: str, new: str) -> str:
    """The front matter's ``tags:`` (or ``tag:``) with the tag renamed, line by line."""
    lines = block.split("\n")
    out: list[str] = []
    inside = False
    for line in lines:
        key = _KEY.match(line)
        if key:
            inside = True
            out.append(f"{key.group(1)}:" + _swap_tokens(key.group(2), old_key, new))
            continue
        if inside:
            item = _item(line.rstrip("\r"))
            if item and (line.startswith((" ", "\t", "-"))):
                ending = "\r" if line.endswith("\r") else ""
                out.append(item[0] + _swap_tokens(item[1], old_key, new) + item[2] + ending)
                continue
            if line.strip() and not line.startswith((" ", "\t")):
                inside = False
        out.append(line)
    return "\n".join(out)


def rename_in(content: str, old: str, new: str) -> str:
    """The note with every ``old`` tag (and every tag below it) renamed to ``new``."""
    old_key = paths.fold(old)
    parsed = mdparse.parse(content)
    pieces: list[str] = []
    position = parsed.body_start
    if parsed.body_start:
        pieces.append(_front(content[: parsed.body_start], old_key, new))
    else:
        position = 0
    for start, end in parsed.tag_spans:
        replaced = _renamed(content[start:end], old_key, new)
        if replaced is None:
            continue
        pieces.append(content[position:start])
        pieces.append(replaced)
        position = end
    pieces.append(content[position:])
    return "".join(pieces)


def with_tag(key: str) -> ColumnElement[bool]:
    """A tag row of the tag ``key`` (folded) or of one below it."""
    below = key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"
    return or_(Tag.tag_key == key, Tag.tag_key.like(below, escape="\\"))


def rename(old: str, new: str, *, writable: set[int], readable: set[int], author: str) -> Renamed:
    old_key = paths.fold(old)
    result = Renamed()
    with SessionLocal() as db:
        rows = db.execute(
            select(File.id, File.space_id)
            .join(Tag, Tag.file_id == File.id)
            .where(with_tag(old_key), File.deleted_at.is_(None), File.is_note.is_(True), File.space_id.in_(readable))
            .distinct()
        ).all()
    ids = [file_id for file_id, space_id in rows if space_id in writable]
    result.read_only = len(rows) - len(ids)
    for start in range(0, len(ids), PART):
        with index.guard, SessionLocal() as db:
            for file_id in ids[start : start + PART]:
                note = db.get(File, file_id)
                if note is None or note.deleted_at is not None:
                    continue
                if _valid_lock(db, note.id) is not None:
                    result.locked += 1
                    continue
                full = paths.vault_root().joinpath(*note.path.split("/"))
                try:
                    data = full.read_bytes()
                except OSError:
                    continue
                try:
                    content = data.decode("utf-8-sig")
                except UnicodeDecodeError:
                    # Not UTF-8: written back it would lose its bytes; the scan reads it as it is.
                    continue
                changed = rename_in(content, old, new)
                if changed == content:
                    continue
                new_data = changed.encode("utf-8")
                if data.startswith(b"\xef\xbb\xbf"):
                    new_data = b"\xef\xbb\xbf" + new_data
                stat = atomic_write(full, new_data)
                index.record(db, note.path, new_data, stat, source=index.RENAME, author=author, file=note)
                result.changed += 1
            db.commit()
    logger.info("Tag renamed changed=%s locked=%s read_only=%s", result.changed, result.locked, result.read_only)
    return result
