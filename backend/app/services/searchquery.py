"""What a search says, as Obsidian's search reads it: words, ``"phrases"``, ``-words`` left out, and operators.

``tag:garden`` (and the tags below it), ``path:Recipes`` (part of the path), ``space:Kitchen``, ``file:plan`` (part of
the file name), ``task:`` (notes with open tasks; the lines shown are the task lines), ``[status]`` and
``[status:open]`` (a property, and part of its value), ``changed:7d`` (changed within 7 days, also ``h`` and ``w``).
A minus before an operator leaves out what it finds (``-tag:draft``); ``OR`` between words finds either.
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
    #: The same, left out: ``-tag:draft``, ``-path:Archive``, ``-space:Kitchen``, ``-file:old``, ``-[status:done]``.
    not_tags: list[str] = field(default_factory=list)
    not_paths: list[str] = field(default_factory=list)
    not_spaces: list[str] = field(default_factory=list)
    not_files: list[str] = field(default_factory=list)
    not_properties: list[tuple[str, str | None]] = field(default_factory=list)
    #: Words of which one is enough: ``otter OR beaver`` (each group two or more words or phrases, as FTS5 strings).
    either: list[list[str]] = field(default_factory=list)
    tasks: bool = False
    #: Changed within this many seconds.
    changed: int | None = None

    @property
    def has_text(self) -> bool:
        return bool(self.words or self.phrases or self.either)

    @property
    def empty(self) -> bool:
        return not (self.has_text or self.without or self.tags or self.paths or self.spaces or self.files
                    or self.properties or self.tasks or self.changed or self.not_tags or self.not_paths
                    or self.not_spaces or self.not_files or self.not_properties)

    def fts(self) -> str | None:
        """The words and phrases as an FTS5 query (every word a prefix, every phrase as it stands); None without."""
        parts = [f'"{word}"*' for word in self.words] + [f'"{phrase}"' for phrase in self.phrases]
        parts += ["(" + " OR ".join(group) + ")" for group in self.either]
        if not parts:
            return None
        return " ".join(parts) + "".join(f' NOT "{word}"*' for word in self.without)

    def middle(self) -> list[list[str]]:
        """The words and phrases as groups for the search in the middle of words: every group must be found, of a group
        one term is enough (``either``)."""
        return [[term] for term in [*self.words, *self.phrases]] + [
            [term.strip('"*') for term in group] for group in self.either
        ]

    def fts_without(self) -> str | None:
        """The words left out, for a search without words: the notes to drop."""
        return " OR ".join(f'"{word}"*' for word in self.without) or None

    def terms(self) -> list[str]:
        """What a line has to show to be a place where the note was found (folded)."""
        alternatives = [term.strip('"*') for group in self.either for term in group]
        return [fold(term) for term in [*self.words, *self.phrases, *alternatives] if term]


def fold(text: str) -> str:
    """As FTS5 compares with ``remove_diacritics``: without accents, case folded."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()


def _clean(text: str) -> str:
    # A quote would end the FTS5 string; a NUL ends SQLite's.
    return text.replace('"', "").replace("\x00", "").strip()


def parse(raw: str) -> Query:
    query = Query()
    tokens = _TOKEN.findall(raw)[: MAX_TERMS * 2]
    # `a OR b OR c`: the words around each OR go into one group, of which one is enough.
    groups: list[list[str]] = []
    joined = [False] * len(tokens)
    for position, token in enumerate(tokens):
        if token == "OR" and 0 < position < len(tokens) - 1:
            joined[position] = True
    position = 0
    while position < len(tokens):
        token = tokens[position]
        if joined[position]:
            position += 1
            continue
        if position + 1 < len(tokens) and joined[position + 1] and _plain_term(token):
            group = [token]
            while position + 2 < len(tokens) and joined[position + 1] and _plain_term(tokens[position + 2]):
                group.append(tokens[position + 2])
                position += 2
            if len(group) > 1:
                groups.append(group)
                position += 1
                continue
        _take(query, token)
        position += 1
    for group in groups[:MAX_TERMS]:
        terms = [_fts_term(token) for token in group]
        terms = [term for term in terms if term]
        if len(terms) > 1:
            query.either.append(terms)
        elif terms:
            query.words.append(terms[0].strip('"*'))
    query.words = query.words[:MAX_TERMS]
    query.phrases = query.phrases[:MAX_TERMS]
    query.without = query.without[:MAX_TERMS]
    return query


def _plain_term(token: str) -> bool:
    """A word or a phrase, the kind OR joins (not an operator, nothing left out)."""
    return not token.startswith("-") and not token.startswith("[") and (token.startswith('"') or ":" not in token)


def _fts_term(token: str) -> str | None:
    if token.startswith('"'):
        phrase = _clean(token)
        return f'"{phrase}"' if phrase else None
    word = _clean(token)
    return f'"{word}"*' if word else None


def _take(query: Query, token: str) -> None:
    """One piece of the search into the query."""
    negative = token.startswith("-") and len(token) > 1
    body = token[1:] if negative else token
    if body.startswith('"'):
        phrase = _clean(body)
        if phrase:
            (query.without if negative else query.phrases).append(phrase)
        return
    if body.startswith("[") and body.endswith("]"):
        name, _, value = body[1:-1].partition(":")
        name = name.strip()
        if name:
            (query.not_properties if negative else query.properties).append((name, value.strip() or None))
        return
    key, colon, value = body.partition(":")
    key = key.lower()
    if colon:
        value = _clean(value)
        if key == "tag" and value:
            (query.not_tags if negative else query.tags).append(value.lstrip("#").strip("/"))
            return
        if key == "path" and value:
            (query.not_paths if negative else query.paths).append(value)
            return
        if key == "space" and value:
            (query.not_spaces if negative else query.spaces).append(value)
            return
        if key == "file" and value:
            (query.not_files if negative else query.files).append(value)
            return
    if colon and not negative:
        if key == "task":
            query.tasks = True
            if value:
                query.words.append(value)
            return
        if key == "changed":
            found = _CHANGED.match(value)
            if found:
                query.changed = int(found.group(1)) * {"h": 3600, "d": 86400, "w": 604800}[found.group(2)]
                return
    word = _clean(body)
    if word:
        (query.without if negative else query.words).append(word)
