"""What the managers of a space set for everybody in it (M6), and what follows from it: where daily notes live,
which notes are daily notes (the graph shows or hides them), where templates live.

Stored in ``Space.options`` (JSON); a key that was never set takes its default. The daily note's name is the date,
``YYYY-MM-DD.md`` as Obsidian writes it, unless the managers chose another pattern (``daily_format``, ``dayname``).
"""

from __future__ import annotations

import posixpath
import re

from ..models import Space
from . import dayname, paths

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
#: English like "Attachments": the folders a new space gets are named the same in every language.
#: ``theme``: the colours the notes of the space are shown in (a theme reference, ``routers/themes``); empty: none.
DEFAULTS: dict[str, str] = {
    "daily_folder": "Daily", "daily_template": "", "template_folder": "Templates", "theme": "",
    "daily_format": dayname.DEFAULT,
}


def options_of(space: Space) -> dict[str, str]:
    stored = space.options if isinstance(space.options, dict) else {}
    return {key: str(stored.get(key) or "") if key in stored else default for key, default in DEFAULTS.items()}


def daily_path(space_name: str, opts: dict[str, str], day: str) -> str:
    folder = opts["daily_folder"]
    name = dayname.name(opts.get("daily_format") or dayname.DEFAULT, day)
    return f"{space_name}/{folder}/{name}.md" if folder else f"{space_name}/{name}.md"


def daily_day(rel: str, opts: dict[str, str]) -> str | None:
    """The day a daily note stands for (``2026-10-02``), or None when the note is none: named in the space's pattern,
    in its daily folder (below it too, for a pattern without folders; anywhere in the space when the folder is set to
    none)."""
    if not paths.is_note(rel):
        return None
    pattern = opts.get("daily_format") or dayname.DEFAULT
    within = rel.split("/", 1)[1] if "/" in rel else rel
    folder = opts["daily_folder"]
    if folder:
        if not paths.fold(within).startswith(paths.fold(folder) + "/"):
            return None
        within = within[len(folder) + 1 :]
    stem = posixpath.splitext(within)[0]
    found = dayname.day_of(pattern, stem)
    if found is None and "/" not in pattern and "/" in stem:
        found = dayname.day_of(pattern, stem.rsplit("/", 1)[1])
    return found


def is_daily(rel: str, opts: dict[str, str]) -> bool:
    return daily_day(rel, opts) is not None
