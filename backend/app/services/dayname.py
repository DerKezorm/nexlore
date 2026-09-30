"""
How a space names its daily notes: a pattern as Obsidian's daily notes write it, ``YYYY-MM-DD`` unless the managers
chose another (``DD.MM.YYYY``, ``YYYY/MM/YYYY-MM-DD`` with a folder per month). Only the numbers of a date count:
``YYYY``, ``YY``, ``MM``, ``M``, ``DD``, ``D``; anything in ``[brackets]`` is written as it stands. Names of days and
months would change with the language and are refused, so a daily note keeps its name.

The same rules live in ``frontend/src/lib/dayname.ts``.
"""

from __future__ import annotations

import re
from datetime import date

DEFAULT = "YYYY-MM-DD"
MAX_CHARS = 60

_TOKEN = re.compile(r"\[[^\]]*\]|YYYY|YY|MM|M|DD|D|[A-Za-z]|.", re.DOTALL)
#: What may stand between the numbers: separators, spaces and a folder step.
_LITERAL = re.compile(r"[-_. /,]")
_NUMBERS = {
    "YYYY": r"(\d{4})", "YY": r"(\d{2})", "MM": r"(\d{2})", "M": r"(\d{1,2})", "DD": r"(\d{2})", "D": r"(\d{1,2})",
}
#: Names of months and days (``MMMM``, ``ddd``) and longer runs: they would read as numbers written twice.
_WORDS = re.compile(r"M{3,}|D{3,}|Y{5,}")


class FormatError(ValueError):
    pass


def _tokens(pattern: str) -> list[str]:
    return _TOKEN.findall(pattern)


def check(pattern: str) -> str:
    """The pattern as stored; a ``FormatError`` when it cannot name every day of its own."""
    pattern = pattern.strip()
    if not pattern:
        return DEFAULT
    if len(pattern) > MAX_CHARS:
        raise FormatError("too long")
    if _WORDS.search(re.sub(r"\[[^\]]*\]", "", pattern)):
        raise FormatError("names of months and days change with the language")
    seen: dict[str, int] = {"Y": 0, "M": 0, "D": 0}
    for token in _tokens(pattern):
        if token.startswith("["):
            continue
        if token in _NUMBERS:
            seen[token[0]] += 1
            continue
        if not _LITERAL.fullmatch(token):
            raise FormatError(f"{token!r} is not a part of a date nexlore writes")
    if 0 in seen.values():
        raise FormatError("year, month and day")
    if pattern.startswith("/") or pattern.endswith("/") or "//" in pattern:
        raise FormatError("a folder step needs a name on both sides")
    return pattern


def name(pattern: str, day: str) -> str:
    """The name of the daily note of ``day`` (``2026-10-02``), without ``.md``; may hold folders (``2026/10/…``)."""
    when = date.fromisoformat(day)
    out = []
    for token in _tokens(pattern or DEFAULT):
        if token.startswith("["):
            out.append(token[1:-1])
        elif token == "YYYY":
            out.append(f"{when.year:04d}")
        elif token == "YY":
            out.append(f"{when.year % 100:02d}")
        elif token == "MM":
            out.append(f"{when.month:02d}")
        elif token == "M":
            out.append(str(when.month))
        elif token == "DD":
            out.append(f"{when.day:02d}")
        elif token == "D":
            out.append(str(when.day))
        else:
            out.append(token)
    return "".join(out)


def day_of(pattern: str, stem: str) -> str | None:
    """The day a name stands for (``02.10.2026`` → ``2026-10-02``), or None when it is not one in this pattern. A part
    named twice (``YYYY/MM/YYYY-MM-DD``) must say the same both times."""
    parts, tokens = [], []
    for token in _tokens(pattern or DEFAULT):
        if token.startswith("["):
            parts.append(re.escape(token[1:-1]))
        elif token in _NUMBERS:
            parts.append(_NUMBERS[token])
            tokens.append(token)
        else:
            parts.append(re.escape(token))
    found = re.fullmatch("".join(parts), stem, re.IGNORECASE)
    if not found:
        return None
    values: dict[str, set[int]] = {"Y": set(), "M": set(), "D": set()}
    for token, text in zip(tokens, found.groups(), strict=True):
        number = int(text)
        values[token[0]].add(2000 + number if token == "YY" else number)
    if any(len(found_values) != 1 for found_values in values.values()):
        return None
    try:
        return date(values["Y"].pop(), values["M"].pop(), values["D"].pop()).isoformat()
    except ValueError:
        return None


#: What a daily note is often called elsewhere: tried in this order when looking for daily notes nexlore missed.
KNOWN = ("YYYY-MM-DD", "DD.MM.YYYY", "D.M.YYYY", "DD-MM-YYYY", "YYYY.MM.DD", "YYYYMMDD", "MM-DD-YYYY", "YYYY_MM_DD")
