"""Colour themes: the fifteen colours nexlore is drawn from, once for dark and once for light, as ``#rrggbb``.

The model is nexdeck's (same colours, same check), per account here: everybody picks their own, keeps their own,
and may share one with the others of the server (the gallery). A space may set a theme for its notes. The browser
derives the in-between shades (hover, the softer and brighter accent) from these.

Every colour read as text is checked against the page, the raised page and the card: below 4.5:1 it is hard to read.
The themes that come along clear that, a test keeps it so; a theme made or taken in is told where it falls short and
stored anyway (the person decides).
"""

from __future__ import annotations

import re
from typing import Any

TOKENS: tuple[str, ...] = (
    "bg", "bg-elev", "surface", "surface-hover", "border", "border-strong",
    "text", "text-muted", "text-faint", "accent", "on-accent", "ok", "warn", "bad", "ai",
)
TEXT = ("text", "text-muted", "text-faint", "accent", "ok", "warn", "bad", "ai")
GROUNDS = ("bg", "bg-elev", "surface")
LEAST = 4.5
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
NAME_MAX = 40
#: A reference to a theme: nexlore's own, one that comes along, or one stored (``t:<id>``).
DEFAULT = "nexlore"


class ThemeError(ValueError):
    pass


def _pair(dark: dict[str, str], light: dict[str, str], ai_dark: str, ai_light: str) -> dict[str, dict[str, str]]:
    return {"dark": {**dark, "ai": ai_dark}, "light": {**light, "ai": ai_light}}


BUILT_IN: dict[str, dict[str, dict[str, str]]] = {
    "deepsea": _pair(
        {"bg": "#07141c", "bg-elev": "#0b1d28", "surface": "#0f2633", "surface-hover": "#153242", "border": "#17374a",
         "border-strong": "#22506a", "text": "#e3f1f6", "text-muted": "#a7c3cf", "text-faint": "#86a6b4",
         "accent": "#2dd4bf", "on-accent": "#04201c", "ok": "#4ade80", "warn": "#facc15", "bad": "#f87171"},
        {"bg": "#eef6f8", "bg-elev": "#ffffff", "surface": "#ffffff", "surface-hover": "#e3eff3", "border": "#cfe1e8",
         "border-strong": "#b3ccd6", "text": "#0b2430", "text-muted": "#345563", "text-faint": "#4b6a78",
         "accent": "#0f766e", "on-accent": "#ffffff", "ok": "#147c3b", "warn": "#9c5f07", "bad": "#b91c1c"},
        "#c4b5fd", "#6d28d9",
    ),
    "forest": _pair(
        {"bg": "#10150f", "bg-elev": "#161d14", "surface": "#1c2519", "surface-hover": "#243020", "border": "#2a3825",
         "border-strong": "#3c4f35", "text": "#e8eddf", "text-muted": "#b7c2a8", "text-faint": "#9aa78a",
         "accent": "#a3c96b", "on-accent": "#15200b", "ok": "#86d17a", "warn": "#e0b84f", "bad": "#e88a6a"},
        {"bg": "#f3f5ee", "bg-elev": "#ffffff", "surface": "#fbfcf8", "surface-hover": "#e9eee0", "border": "#d8e0cb",
         "border-strong": "#c2cdb0", "text": "#1c2617", "text-muted": "#435238", "text-faint": "#566548",
         "accent": "#4d7a1f", "on-accent": "#ffffff", "ok": "#2f7d32", "warn": "#8a6212", "bad": "#b4432a"},
        "#c9b8f0", "#6b3fb8",
    ),
    "ember": _pair(
        {"bg": "#141110", "bg-elev": "#1b1715", "surface": "#221d1a", "surface-hover": "#2c2521", "border": "#342b26",
         "border-strong": "#4a3d35", "text": "#f3ebe5", "text-muted": "#c9b8ab", "text-faint": "#ab998c",
         "accent": "#fb923c", "on-accent": "#231105", "ok": "#84cc16", "warn": "#fbbf24", "bad": "#f44462"},
        {"bg": "#faf5f1", "bg-elev": "#ffffff", "surface": "#ffffff", "surface-hover": "#f3eae3", "border": "#eadbd0",
         "border-strong": "#dbc6b6", "text": "#2a1d15", "text-muted": "#5c4638", "text-faint": "#6e5748",
         "accent": "#c2410c", "on-accent": "#ffffff", "ok": "#4d7c0f", "warn": "#9c5f07", "bad": "#be123c"},
        "#d8b4fe", "#7e22ce",
    ),
    "mist": _pair(
        {"bg": "#15181d", "bg-elev": "#1b1f26", "surface": "#21262e", "surface-hover": "#2a303a", "border": "#2f3641",
         "border-strong": "#434c5a", "text": "#edf0f4", "text-muted": "#bcc3cf", "text-faint": "#a0a8b6",
         "accent": "#a5b4fc", "on-accent": "#141733", "ok": "#6ee7b7", "warn": "#fcd34d", "bad": "#fda4af"},
        {"bg": "#f4f5f8", "bg-elev": "#ffffff", "surface": "#ffffff", "surface-hover": "#eceef3", "border": "#dde1e8",
         "border-strong": "#c9ced8", "text": "#1d2230", "text-muted": "#475067", "text-faint": "#596178",
         "accent": "#4f46e5", "on-accent": "#ffffff", "ok": "#047857", "warn": "#92400e", "bad": "#be123c"},
        "#f0abfc", "#86198f",
    ),
    "sandstone": _pair(
        {"bg": "#1a1612", "bg-elev": "#211c17", "surface": "#29221c", "surface-hover": "#332b23", "border": "#3a3128",
         "border-strong": "#524538", "text": "#f2e9dc", "text-muted": "#cdbda6", "text-faint": "#b09f88",
         "accent": "#e4b363", "on-accent": "#231806", "ok": "#9ccc65", "warn": "#f0c052", "bad": "#ef8a73"},
        {"bg": "#f7f1e6", "bg-elev": "#fffdf8", "surface": "#fffdf8", "surface-hover": "#efe6d6", "border": "#e4d8c3",
         "border-strong": "#d3c3a7", "text": "#2e2418", "text-muted": "#5c4c38", "text-faint": "#6d5c47",
         "accent": "#9a5b13", "on-accent": "#ffffff", "ok": "#3f7a22", "warn": "#8f5e0a", "bad": "#b3402a"},
        "#c4b5fd", "#6d28d9",
    ),
    "graphite": _pair(
        {"bg": "#0c0c0d", "bg-elev": "#131314", "surface": "#1a1a1c", "surface-hover": "#232326", "border": "#2a2a2e",
         "border-strong": "#3d3d42", "text": "#f4f4f5", "text-muted": "#b8b8bf", "text-faint": "#9d9da6",
         "accent": "#d9f99d", "on-accent": "#141a05", "ok": "#86efac", "warn": "#fde047", "bad": "#fca5a5"},
        {"bg": "#f4f4f5", "bg-elev": "#ffffff", "surface": "#ffffff", "surface-hover": "#ececee", "border": "#dcdce0",
         "border-strong": "#c6c6cc", "text": "#141416", "text-muted": "#45454d", "text-faint": "#57575f",
         "accent": "#3f6212", "on-accent": "#ffffff", "ok": "#166534", "warn": "#854d0e", "bad": "#b91c1c"},
        "#c4b5fd", "#6d28d9",
    ),
    "plum": _pair(
        {"bg": "#16101b", "bg-elev": "#1d1524", "surface": "#241a2d", "surface-hover": "#2e2239", "border": "#352841",
         "border-strong": "#4c3a5c", "text": "#f1e9f6", "text-muted": "#c7b5d3", "text-faint": "#aa97b8",
         "accent": "#e879f9", "on-accent": "#2a0a31", "ok": "#86efac", "warn": "#fcd34d", "bad": "#fb7185"},
        {"bg": "#f8f3fa", "bg-elev": "#ffffff", "surface": "#ffffff", "surface-hover": "#f0e6f4", "border": "#e4d6ea",
         "border-strong": "#d1bddb", "text": "#261a2e", "text-muted": "#54405f", "text-faint": "#665271",
         "accent": "#a21caf", "on-accent": "#ffffff", "ok": "#147c3b", "warn": "#92400e", "bad": "#be123c"},
        "#a5b4fc", "#4338ca",
    ),
}


def _luminance(colour: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (int(colour[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(one: str, other: str) -> float:
    """The contrast ratio of two colours, from 1 to 21."""
    a, b = _luminance(one), _luminance(other)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def weak_spots(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Every colour read as text that falls below 4.5:1 on a ground, and the accent's own text."""
    found = []
    for mode in ("dark", "light"):
        palette = data.get(mode) or {}
        for token in TEXT:
            if token not in palette:
                continue
            worst = min((contrast(palette[token], palette[g]) for g in GROUNDS if g in palette), default=21.0)
            if worst < LEAST:
                found.append({"mode": mode, "token": token, "ratio": round(worst, 2)})
        if "accent" in palette and "on-accent" in palette:
            ratio = contrast(palette["accent"], palette["on-accent"])
            if ratio < LEAST:
                found.append({"mode": mode, "token": "on-accent", "ratio": round(ratio, 2)})
    return found


def check_colours(incoming: Any) -> dict[str, dict[str, str]]:
    """The colours of a theme as they may be stored: ``{"dark": {...}, "light": {...}}``, each side and each colour
    optional (nexlore's own fills the gaps). Refused in words: anything that is not such a mapping, an unknown name,
    a colour that is not ``#rrggbb``."""
    if not isinstance(incoming, dict):
        raise ThemeError("The colours are a mapping of dark and light to their colours.")
    stray_side = sorted(set(incoming) - {"dark", "light"})
    if stray_side:
        raise ThemeError(f"{stray_side[0]!r} is neither dark nor light.")
    out: dict[str, dict[str, str]] = {}
    for mode in ("dark", "light"):
        palette = incoming.get(mode)
        if palette is None:
            continue
        if not isinstance(palette, dict):
            raise ThemeError(f"The {mode} colours have to be a mapping of name to colour.")
        stray = sorted(set(palette) - set(TOKENS))
        if stray:
            raise ThemeError(f"{stray[0]!r} is not a colour a theme sets. These are: {', '.join(TOKENS)}.")
        side: dict[str, str] = {}
        for token, value in palette.items():
            if not isinstance(value, str) or not HEX.match(value):
                raise ThemeError(f"The {mode} colour {token!r} has to be written as #rrggbb.")
            side[token] = value.lower()
        out[mode] = side
    return out


def id_of(ref: str) -> int | None:
    """The stored theme a reference names (``t:<id>``), else None."""
    if ref.startswith("t:") and ref[2:].isdigit() and len(ref) < 20:
        return int(ref[2:])
    return None


def ref_ok(ref: str) -> bool:
    """A reference that may stand in an appearance or a space: its form, not whether it may be read."""
    return ref == DEFAULT or ref in BUILT_IN or id_of(ref) is not None


def check_name(name: Any) -> str:
    clean = str(name or "").strip()
    if not clean or len(clean) > NAME_MAX or any(ord(c) < 32 for c in clean):
        raise ThemeError(f"A theme needs a name of at most {NAME_MAX} characters.")
    return clean
