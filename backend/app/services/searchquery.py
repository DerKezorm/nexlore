"""What a search says, as Obsidian's search reads it: words, ``"phrases"``, ``-words`` left out, and operators.

``tag:garden`` (and the tags below it), ``path:Recipes`` (part of the path), ``space:Kitchen``, ``file:plan`` (part of
the file name), ``task:`` (notes with open tasks; the lines shown are the task lines), ``[status]`` and
``[status:open]`` (a property, and part of its value), ``changed:7d`` (changed within 7 days, also ``h`` and ``w``).
Anything else is a word. Nothing of it ever reaches SQL or FTS5 as syntax: words go in quoted, filters as values.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

#: A piece of the search: ``key:"two words"``, ``"a phrase"``, ``[property:value]`` or anything up to a blank.
_TOKEN = re.compile(r'-?[\w-]+:"[^"]*"|-?"[^"]*"|-?\[[^\]]*\]|\S+')
_CHANGED = re.compile(r"^(\d{1,4})([hdw])$")
MAX_TERMS = 12


@dataclass
class Query:
    words: list[str] = field(default_factory=list)
    phrases: list[str] = field(default_factory=list)
    without: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    spaces: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    properties: list[tuple[str, str | None]] = field(default_factory=list)
    tasks: bool = False
    #: Changed within this many seconds.
    changed: int | None = None

    @property
    def has_text(self) -> bool:
        return bool(self.words or self.phrases)

    @property
    def empty(self) -> bool:
        return not (self.has_text or self.without or self.tags or self.paths or self.spaces or self.files
                    or self.properties or self.tasks or self.changed)

    def fts(self) -> str | None:
        """The words and phrases as an FTS5 query (every word a prefix, every phrase as it stands); None without."""
        parts = [f'"{word}"*' for word in self.words] + [f'"{phrase}"' for phrase in self.phrases]
        if not parts:
            return None
        return " ".join(parts) + "".join(f' NOT "{word}"*' for word in self.without)

    def fts_without(self) -> str | None:
        """The words left out, for a search without words: the notes to drop."""
        return " OR ".join(f'"{word}"*' for word in self.without) or None

    def terms(self) -> list[str]:
        """What a line has to show to be a place where the note was found (folded)."""
        return [fold(term) for term in [*self.words, *self.phrases] if term]


def fold(text: str) -> str:
    """As FTS5 compares with ``remove_diacritics``: without accents, case folded."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()


def _clean(text: str) -> str:
    # A quote would end the FTS5 string; a NUL ends SQLite's.
    return text.replace('"', "").replace("\x00", "").strip()


def parse(raw: str) -> Query:
    query = Query()
    for token in _TOKEN.findall(raw)[: MAX_TERMS * 2]:
        negative = token.startswith("-") and len(token) > 1
        body = token[1:] if negative else token
        if body.startswith('"'):
            phrase = _clean(body)
            if phrase:
                (query.without if negative else query.phrases).append(phrase)
            continue
        if body.startswith("[") and body.endswith("]"):
            name, _, value = body[1:-1].partition(":")
            name = name.strip()
            if name and not negative:
                query.properties.append((name, value.strip() or None))
            continue
        key, colon, value = body.partition(":")
        key = key.lower()
        if colon and not negative:
            value = _clean(value)
            if key == "tag" and value:
                query.tags.append(value.lstrip("#").strip("/"))
                continue
            if key == "path" and value:
                query.paths.append(value)
                continue
            if key == "space" and value:
                query.spaces.append(value)
                continue
            if key == "file" and value:
                query.files.append(value)
                continue
            if key == "task":
                query.tasks = True
                if value:
                    query.words.append(value)
                continue
            if key == "changed":
                found = _CHANGED.match(value)
                if found:
                    query.changed = int(found.group(1)) * {"h": 3600, "d": 86400, "w": 604800}[found.group(2)]
                    continue
        word = _clean(body)
        if word:
            (query.without if negative else query.words).append(word)
    query.words = query.words[:MAX_TERMS]
    query.phrases = query.phrases[:MAX_TERMS]
    query.without = query.without[:MAX_TERMS]
    return query
