"""
Mentions without a link, and the cleaning up of a space.

A note is mentioned where its name (or one of its ``aliases``) stands as a word in another note's text, outside
code, comments, formulas, links and tags. The full-text index names the notes to look in; each is then read and the
word found exactly (case does not matter, whole words only). "Link" turns one such place into ``[[Name]]``, or
``[[Name|as written]]`` where the words differ from the name, so the sentence reads the same. Never into a note
someone is editing (its lock), and only when the place still holds those words.

Cleaning up lists the notes of a space with no link in or out, and the links that lead nowhere.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import FTS_TABLE, File, Link
from . import index, mdparse, paths, vault
from .vault import _valid_lock, atomic_write

logger = logging.getLogger("nexlore.mentions")

#: Notes the full-text index may name for one note; each is read once.
MAX_NOTES = 200
#: Places given back for one note.
MAX_PLACES = 200
#: Shorter names would be found everywhere ("AI", "Q3").
MIN_NAME = 3
#: Words around a place, on each side.
AROUND = 80
#: Rows of each list when cleaning up.
MAX_ROWS = 500

_URL = re.compile(r"https?://\S+|www\.\S+")


@dataclass
class Place:
    path: str
    title: str
    line: int
    #: Where the words start in their line (characters) and the words as written.
    column: int
    words: str
    before: str
    after: str
    #: The wiki link that reaches the note from there (its name, or its path where the name leads elsewhere).
    link: str


class MentionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def names_of(file: File) -> list[str]:
    """The note's name and its aliases, long enough to look for, longest first (so "Garden plan" wins over
    "Garden" where both stand)."""
    name = file.path.rsplit("/", 1)[-1][:-3]
    found: dict[str, str] = {}
    for candidate in [name, *mdparse.aliases_of(file.front)]:
        words = candidate.strip()
        if len(words) >= MIN_NAME:
            found.setdefault(paths.fold(words), words)
    return sorted(found.values(), key=len, reverse=True)


def _pattern(names: list[str]) -> re.Pattern[str]:
    # Whole words: no letter, digit or _ right before or after, nor a # in front (a tag) or a / (a path).
    words = "|".join(re.escape(name) for name in names)
    return re.compile(rf"(?<![\w#/])(?:{words})(?!\w)", re.IGNORECASE)


def places_in(content: str, names: list[str]) -> list[tuple[int, int, int, str]]:
    """Every place a name stands as a plain word: (line from 1, column, offset in the file, words as written)."""
    if not names:
        return []
    prose = mdparse.parse(content).prose
    prose = _URL.sub(lambda match: " " * len(match.group(0)), prose)
    found = []
    for match in _pattern(names).finditer(prose):
        start = match.start()
        line_start = content.rfind("\n", 0, start) + 1
        found.append((content.count("\n", 0, start) + 1, start - line_start, start, content[start : match.end()]))
    return found


def _fts_phrase(name: str) -> str | None:
    words = [word.replace('"', "") for word in re.findall(r"\w+", name)]
    return '"' + " ".join(words) + '"' if words else None


def _candidates(db: Session, names: list[str], readable: set[int], skip: int) -> list[int]:
    phrases = [phrase for phrase in (_fts_phrase(name) for name in names) if phrase]
    if not phrases:
        return []
    rows = db.execute(
        text(
            f"SELECT f.id FROM {FTS_TABLE} JOIN files f ON f.id = {FTS_TABLE}.rowid "  # noqa: S608
            f"WHERE {FTS_TABLE} MATCH :query AND f.deleted_at IS NULL AND f.is_note = 1 AND f.id != :skip "
            "AND f.space_id IN (SELECT value FROM json_each(:spaces)) "
            f"ORDER BY bm25({FTS_TABLE}) LIMIT :limit"
        ),
        {
            "query": "{body} : (" + " OR ".join(phrases) + ")",
            "skip": skip,
            "spaces": json.dumps(sorted(readable)),
            "limit": MAX_NOTES,
        },
    ).all()
    return [row[0] for row in rows]


def link_text(db: Session, target: File, source_path: str, source_space: int) -> str:
    """What a wiki link in ``source_path`` needs to reach ``target``: the name alone where that leads there."""
    space_name, _, inside = target.path.partition("/")
    inside = inside[:-3]
    name = inside.rsplit("/", 1)[-1]
    if space_name != paths.space_of(source_path):
        name, inside = f"{space_name}/{name}", f"{space_name}/{inside}"
    names = index.Names(db, source_space, preload=False)
    return name if index.resolve("wiki", name, source_path, names) == target.id else inside


def _read(path: str) -> str | None:
    try:
        data = paths.vault_root().joinpath(*path.split("/")).read_bytes()
        return data.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None


def unlinked(path: str, readable: set[int]) -> tuple[list[Place], bool]:
    """The places other notes mention the note at ``path`` without a link; and whether there were more."""
    with SessionLocal() as db:
        target = vault.live(db, path)
        if target is None:
            return [], False
        names = names_of(target)
        places: list[Place] = []
        more = False
        for file_id in _candidates(db, names, readable, target.id):
            source = db.get(File, file_id)
            if source is None:
                continue
            content = _read(source.path)
            if content is None:
                continue
            found = places_in(content, names)
            if not found:
                continue
            link = link_text(db, target, source.path, source.space_id)
            lines = content.split("\n")
            for line, column, _, words in found:
                if len(places) >= MAX_PLACES:
                    more = True
                    break
                row = lines[line - 1].rstrip("\r")
                places.append(
                    Place(
                        path=source.path, title=source.title, line=line, column=column, words=words,
                        before=row[max(0, column - AROUND) : column],
                        after=row[column + len(words) : column + len(words) + AROUND],
                        link=link,
                    )
                )
        places.sort(key=lambda place: (paths.fold(place.title), place.path, place.line, place.column))
        return places, more


def wiki_for(link: str, words: str) -> str:
    """``[[link]]`` when the words are the name the link ends in, else ``[[link|words]]``."""
    name = link.rsplit("/", 1)[-1]
    return f"[[{link}]]" if words == name else f"[[{link}|{words}]]"


def link_place(
    source_path: str, target_path: str, line: int, column: int, words: str, *, author: str,
    as_source: str = index.APP,
) -> str:
    """Turns the words at that place into a link to the note; returns the link written."""
    with index.guard, SessionLocal() as db:
        source = vault.live(db, source_path)
        target = vault.live(db, target_path)
        if source is None or target is None or not source.is_note or not target.is_note:
            raise MentionError("not_found", "The note is not there any more.")
        if _valid_lock(db, source.id) is not None:
            raise MentionError("note_locked", "Someone is editing that note; link it there.")
        full = paths.vault_root().joinpath(*source.path.split("/"))
        try:
            data = full.read_bytes()
            content = data.decode("utf-8-sig")
        except (OSError, UnicodeDecodeError) as exc:
            raise MentionError("not_found", "The note cannot be read.") from exc
        # Only where the words still stand as a plain mention of this note.
        found = {(place[0], place[1]): place for place in places_in(content, names_of(target))}
        place = found.get((line, column))
        if place is None or place[3] != words:
            raise MentionError("mention_moved", "The note changed there; look again.")
        wiki = wiki_for(link_text(db, target, source.path, source.space_id), words)
        start = place[2]
        changed = content[:start] + wiki + content[start + len(words) :]
        new_data = changed.encode("utf-8")
        if data.startswith(b"\xef\xbb\xbf"):
            new_data = b"\xef\xbb\xbf" + new_data
        stat = atomic_write(full, new_data)
        index.record(db, source.path, new_data, stat, source=as_source, author=author, file=source)
        db.commit()
    logger.info("Mention linked")
    return wiki


# --- Cleaning up ------------------------------------------------------------------------------------------------


@dataclass
class Lonely:
    path: str
    title: str


@dataclass
class Broken:
    path: str
    title: str
    line: int
    target: str
    kind: str


def lonely_notes(space_id: int) -> tuple[list[Lonely], int]:
    """Notes of the space no link leads to or from (a link to a file counts too); how many there are."""
    with SessionLocal() as db:
        linked_out = select(Link.source_id).where(Link.target_id.is_not(None))
        linked_in = select(Link.target_id).where(Link.target_id.is_not(None), Link.source_id != Link.target_id)
        where = (
            File.space_id == space_id, File.deleted_at.is_(None), File.is_note.is_(True),
            File.id.not_in(linked_out), File.id.not_in(linked_in),
        )
        total = db.scalar(select(func.count()).select_from(File).where(*where)) or 0
        rows = db.execute(select(File.path, File.title).where(*where).order_by(File.path_key).limit(MAX_ROWS)).all()
    return [Lonely(path=path, title=title) for path, title in rows], total


def broken_links(space_id: int) -> tuple[list[Broken], int]:
    """Links in the notes of the space that lead to nothing there is; how many there are."""
    with SessionLocal() as db:
        where = (
            Link.space_id == space_id, Link.target_id.is_(None), File.deleted_at.is_(None), File.is_note.is_(True),
        )
        counted = select(func.count()).select_from(Link).join(File, File.id == Link.source_id).where(*where)
        total = db.scalar(counted) or 0
        rows = db.execute(
            select(File.path, File.title, Link.line, Link.target, Link.kind)
            .join(File, File.id == Link.source_id)
            .where(*where)
            .order_by(func.lower(Link.target), File.path_key, Link.line)
            .limit(MAX_ROWS)
        ).all()
    found = [Broken(path=p, title=t, line=n, target=target, kind=kind) for p, t, n, target, kind in rows]
    return found, total
