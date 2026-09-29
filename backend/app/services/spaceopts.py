"""What the managers of a space set for everybody in it (M6), and what follows from it: where daily notes live,
which notes are daily notes (the graph shows or hides them), where templates live.

Stored in ``Space.options`` (JSON); a key that was never set takes its default. The daily note's name is always the
date, ``JJJJ-MM-TT.md``, as Obsidian writes it.
"""

from __future__ import annotations

import re

from ..models import Space
from . import paths

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
#: English like "Attachments": the folders a new space gets are named the same in every language.
#: ``theme``: the colours the notes of the space are shown in (a theme reference, ``routers/themes``); empty: none.
DEFAULTS: dict[str, str] = {"daily_folder": "Daily", "daily_template": "", "template_folder": "Templates", "theme": ""}


def options_of(space: Space) -> dict[str, str]:
    stored = space.options if isinstance(space.options, dict) else {}
    return {key: str(stored.get(key) or "") if key in stored else default for key, default in DEFAULTS.items()}


def daily_path(space_name: str, opts: dict[str, str], day: str) -> str:
    folder = opts["daily_folder"]
    return f"{space_name}/{folder}/{day}.md" if folder else f"{space_name}/{day}.md"


def is_daily(rel: str, opts: dict[str, str]) -> bool:
    """A daily note: named like a date, and in the space's daily folder or below it (anywhere in the space, when
    the folder is set to none: then every note named like a date counts)."""
    if not paths.is_note(rel) or not DATE.match(paths.stem(rel)):
        return False
    folder = opts["daily_folder"]
    if not folder:
        return True
    within = rel.split("/", 1)[1] if "/" in rel else rel
    return paths.fold(within).startswith(paths.fold(folder) + "/")
