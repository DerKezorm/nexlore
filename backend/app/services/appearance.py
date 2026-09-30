"""How nexlore looks for one account: light or dark, the theme, fonts, text size and width, and the page it starts on.
Stored with the account, so it is the same on every device; each value is checked against a fixed list, never taken
as CSS."""

from __future__ import annotations

import re
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
#: The tabs of the column beside a note, and the sidebar folded to a strip of symbols or open.
PANEL_TABS = ("outline", "links", "comments", "graph", "versions", "plugins")
SIDEBARS = ("open", "rail")
#: Own keys for commands (the command palette): at most this many, each a combination written as the browser
#: names it ("Ctrl+Alt+Shift+Meta+Key") and the command's name to show in the list.
KEYS_MAX = 60
LABEL_MAX = 80
_COMMAND = re.compile(r"^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9:_-]+){1,3}$")
_COMBO = re.compile(
    r"^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?"
    r"(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Enter|Space|Home|End|PageUp|PageDown|Insert"
    r"|Comma|Period|Slash|Minus|Equal|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Backquote)$"
)

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
    #: The column beside a note on a wide screen: shown, and which tab; below 1280 pixels a sheet on request.
    "panel": True,
    "panel_tab": "links",
    "sidebar": "open",
    #: Own keys: command id -> {"combo", "label"}.
    "keys": {},
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
        "start": STARTS, "panel_tab": PANEL_TABS, "sidebar": SIDEBARS,
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
        elif key in ("space_themes", "panel"):
            if not isinstance(value, bool):
                raise AppearanceError(key)
            out[key] = value
        elif key == "start_note" and value == "":
            # No note chosen (any more).
            out[key] = value
        elif key == "start_note":
            if not isinstance(value, str) or len(value) > paths.MAX_PATH_CHARS or not value.lower().endswith(".md"):
                raise AppearanceError(key)
            try:
                paths.parse(value)
            except paths.PathError as exc:
                raise AppearanceError(key) from exc
            out[key] = value
        elif key == "keys":
            out[key] = _keys(value)
        elif key == "theme":
            if not isinstance(value, str) or not themes.ref_ok(value):
                raise AppearanceError(key)
            out[key] = value
        else:
            raise AppearanceError(key)
    return out


def _keys(value: Any) -> dict[str, dict[str, str]]:
    """Own keys: known shapes only, each combination once."""
    if not isinstance(value, dict) or len(value) > KEYS_MAX:
        raise AppearanceError("keys")
    out: dict[str, dict[str, str]] = {}
    seen: set[str] = set()
    for command, own in value.items():
        if not isinstance(command, str) or len(command) > 64 or not _COMMAND.match(command):
            raise AppearanceError("keys")
        if not isinstance(own, dict) or set(own) != {"combo", "label"}:
            raise AppearanceError("keys")
        combo, label = own["combo"], own["label"]
        if not isinstance(combo, str) or not _COMBO.match(combo) or combo in seen:
            raise AppearanceError("keys")
        if not isinstance(label, str) or not 0 < len(label) <= LABEL_MAX:
            raise AppearanceError("keys")
        seen.add(combo)
        out[command] = {"combo": combo, "label": label}
    return out


def change(stored: Any, changes: dict[str, Any]) -> dict[str, Any]:
    """The stored choices with ``changes`` laid over them; raises for an unknown key or a value not on its list."""
    checked = _checked(changes)
    base = {key: value for key, value in (stored or {}).items() if key in DEFAULTS} if isinstance(stored, dict) else {}
    return {**base, **checked}
