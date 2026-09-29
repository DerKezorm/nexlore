"""How nexlore looks for one account: light or dark, the theme, fonts, text size and width, and the page it starts on.
Stored with the account, so it is the same on every device; each value is checked against a fixed list, never taken
as CSS."""

from __future__ import annotations

from typing import Any

from . import paths, themes

MODES = ("dark", "light", "system")
#: The fonts nexlore brings along (in the image, never from another server), and the browser's own.
FONTS_UI = ("inter", "atkinson", "plex", "system")
FONTS_TEXT = ("inter", "literata", "source-serif", "atkinson", "plex", "system")
FONTS_CODE = ("jetbrains", "system")
WIDTHS = ("narrow", "normal", "wide", "full")
SIZE_MIN, SIZE_MAX = 14, 20
#: Where nexlore opens (Obsidian's Homepage plugin): the map, today's daily note, the note opened last, one note.
STARTS = ("graph", "daily", "last", "note")

DEFAULTS: dict[str, Any] = {
    "mode": "dark",
    #: ``nexlore``, a theme that comes along (``services/themes.BUILT_IN``) or ``t:<id>`` of a stored one.
    "theme": "nexlore",
    #: Take the theme a space sets for its notes.
    "space_themes": True,
    "font_ui": "inter",
    "font_text": "inter",
    "font_code": "jetbrains",
    "size": 16,
    "width": "normal",
    "start": "graph",
    #: With ``start: note``: its path. Whether it may be read is asked when it is opened, like any note.
    "start_note": "",
}


class AppearanceError(ValueError):
    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


def of(stored: Any) -> dict[str, Any]:
    """The account's appearance: what it chose, the defaults for the rest; a value no longer valid is dropped."""
    out = dict(DEFAULTS)
    if isinstance(stored, dict):
        for key, value in stored.items():
            try:
                out.update(_checked({key: value}))
            except AppearanceError:
                continue
    return out


def _checked(changes: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "mode": MODES, "font_ui": FONTS_UI, "font_text": FONTS_TEXT, "font_code": FONTS_CODE, "width": WIDTHS,
        "start": STARTS,
    }
    out: dict[str, Any] = {}
    for key, value in changes.items():
        if key in allowed:
            if value not in allowed[key]:
                raise AppearanceError(key)
            out[key] = value
        elif key == "size":
            if isinstance(value, bool) or not isinstance(value, int) or not SIZE_MIN <= value <= SIZE_MAX:
                raise AppearanceError(key)
            out[key] = value
        elif key == "space_themes":
            if not isinstance(value, bool):
                raise AppearanceError(key)
            out[key] = value
        elif key == "start_note":
            if not isinstance(value, str) or len(value) > paths.MAX_PATH_CHARS or not value.lower().endswith(".md"):
                raise AppearanceError(key)
            try:
                paths.parse(value)
            except paths.PathError as exc:
                raise AppearanceError(key) from exc
            out[key] = value
        elif key == "theme":
            if not isinstance(value, str) or not themes.ref_ok(value):
                raise AppearanceError(key)
            out[key] = value
        else:
            raise AppearanceError(key)
    return out


def change(stored: Any, changes: dict[str, Any]) -> dict[str, Any]:
    """The stored choices with ``changes`` laid over them; raises for an unknown key or a value not on its list."""
    checked = _checked(changes)
    base = {key: value for key, value in (stored or {}).items() if key in DEFAULTS} if isinstance(stored, dict) else {}
    return {**base, **checked}
