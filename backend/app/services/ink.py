"""Drawings: ``.svg`` files with the strokes inside, drawn with a pen in nexlore and shown as a picture everywhere else.

**What makes an SVG a drawing.** The mark ``data-nexlore-ink="1"`` within its first 2 KB. Every other SVG stays a
picture or a download, as before; nexlore never opens one to draw in.

**What nexlore reads.** Only the JSON in ``<metadata id="nexlore-ink">``: version, background, strokes (tool, colour,
size and points ``[x, y, pressure]``), the recognised text with its words, and the remembered view. The paths beside
it are for every other program (Obsidian, GitHub, an image viewer). They are never read back: a file another program
changed, or one somebody made up with a script inside, is drawn from its strokes alone, and every save writes the
whole file anew after one fixed pattern (``write``). Fields nexlore does not know stay, at every level: a later version
of the format, or of the iPad's recognition, must not lose them through an older server.

**Why the escapes.** The JSON sits in an XML element. ``<``, ``>`` and ``&`` only ever occur inside its strings, so
writing them as ``\\u003c`` and so on keeps the JSON the same JSON and leaves nothing an XML reader could take for
markup: a recognised text of ``</metadata><script>`` stays text.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

#: In the root element of every drawing; looked for in the first ``MARK_WINDOW`` bytes only (a large picture is never
#: searched whole for it).
MARK = 'data-nexlore-ink="1"'
MARK_WINDOW = 2048
#: The version of the format this server writes and reads.
VERSION = 1

#: As much as a note (``prepare.MAX_NOTE_BYTES``; not imported, the index reads drawings through this module).
MAX_BYTES = 5 * 1024 * 1024
#: Well beyond a page of handwriting, well below what makes a page slow to draw.
MAX_STROKES = 20_000
MAX_POINTS = 10_000
MAX_TEXT = 100_000
MAX_WORDS = 20_000
#: Coordinates are free (the surface has no edge), but finite: beyond this a number is a mistake, not a drawing.
MAX_COORDINATE = 1e6
SIZE_RANGE = (0.5, 64.0)
#: The remembered view: pixels per unit, and the height of the block in the note in pixels.
ZOOM_RANGE = (0.05, 10.0)
HEIGHT_RANGE = (80.0, 2000.0)
#: How deep fields nexlore does not know may nest; JSON from a person is never deeper.
MAX_DEPTH = 32

TOOLS = ("pen", "marker")
BACKGROUNDS = ("none", "lines", "grid", "dots")
#: ``ink`` follows light and dark in nexlore; in the file it is ``currentColor`` with this colour at the root.
INK = "ink"
INK_COLOR = "#1b1b22"
_HEX = re.compile(r"#[0-9a-fA-F]{6}")

#: Room around the strokes in the file's ``viewBox``; and the box of a drawing without strokes.
PAD = 24
EMPTY_BOX = (0, 0, 680, 220)
#: How the marker looks in the file: wide and see-through, as on paper.
MARKER_WIDTH = 3
MARKER_OPACITY = "0.38"

#: A new drawing: nothing on it, no background.
BLANK: dict[str, Any] = {"v": VERSION, "bg": "none", "strokes": []}

_SURROGATE = re.compile("[\ud800-\udfff]")
#: What XML 1.0 does not allow in text, even escaped.
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
#: Where the data stands, exactly as ``write`` puts it. Found as plain text, not with a pattern: a file made up to be
#: slow to search costs no more than reading it once.
_OPEN = '<metadata id="nexlore-ink">'
_CLOSE = "</metadata>"
#: What the JSON holds as an escape although JSON would not need one: XML's marks, and the two characters XML allows
#: nowhere (JSON escapes the control characters itself).
_JSON_ESCAPED = re.compile("[<>&\ufffe\uffff]")


class InkError(ValueError):
    def __init__(self, code: str, text: str) -> None:
        super().__init__(text)
        self.code = code
        self.text = text


def _bad(text: str) -> InkError:
    return InkError("bad_ink", text)


def is_ink(data: bytes) -> bool:
    """Whether a file is a drawing: the mark near its start. Only the start is looked at, so a large SVG costs
    nothing, and a mark somewhere deep in another program's picture makes it no drawing."""
    return MARK.encode() in data[:MARK_WINDOW]


# --- Reading --------------------------------------------------------------------------------------------------------


def _no_constant(name: str) -> None:
    # NaN and Infinity are no JSON; Python would take them, a browser refuses the file.
    raise _bad("The drawing holds a number JSON does not know.")


def parse(text: str) -> dict[str, Any]:
    """The drawing in the SVG ``text``, checked (``check``): only the JSON of its metadata is read, never the paths."""
    if len(text.encode("utf-8", errors="surrogatepass")) > MAX_BYTES:
        raise InkError("too_large", "A drawing holds at most 5 MB.")
    start = text.find(_OPEN)
    end = text.find(_CLOSE, start + len(_OPEN)) if start >= 0 else -1
    if end < 0:
        raise _bad("The drawing holds no strokes nexlore can read.")
    try:
        data = json.loads(text[start + len(_OPEN) : end], parse_constant=_no_constant)
    except InkError:
        raise
    except (ValueError, RecursionError) as exc:
        raise _bad("The drawing's data is no JSON nexlore can read.") from exc
    return check(data)


def check(data: Any) -> dict[str, Any]:
    """``data`` when it is a drawing nexlore can keep, else ``InkError``. The page sends this object to be saved,
    and the same checks run on every file read, so a drawing that passed once always passes again. Counts are checked
    before anything is looked into: a list of a million points is refused without walking it."""
    try:
        return _check(data)
    except RecursionError as exc:
        raise _bad("The drawing nests too deep.") from exc


def _check(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise _bad("A drawing is an object with strokes.")
    version = data.get("v")
    if not _is_int(version) or version < 1:
        raise _bad("The drawing names no version of its format.")
    if version > VERSION:
        raise InkError("newer_ink", "The drawing was made by a newer nexlore.")
    if "bg" in data and data["bg"] not in BACKGROUNDS:
        raise _bad("The drawing's background is none nexlore knows.")
    strokes = data.get("strokes")
    if not isinstance(strokes, list):
        raise _bad("The drawing's strokes are no list.")
    if len(strokes) > MAX_STROKES:
        raise InkError("too_large", f"A drawing holds at most {MAX_STROKES} strokes.")
    for stroke in strokes:
        _check_stroke(stroke)
    if "text" in data:
        if not isinstance(data["text"], str):
            raise _bad("The drawing's text is no text.")
        if len(data["text"]) > MAX_TEXT:
            raise InkError("too_large", f"A drawing's text holds at most {MAX_TEXT} characters.")
    if "words" in data:
        _check_words(data["words"])
    if "view" in data and data["view"] is not None:
        _check_view(data["view"])
    _check_rest(data, ("v", "bg", "strokes", "words", "view"), 0)
    return data


def _check_stroke(stroke: Any) -> None:
    if not isinstance(stroke, dict):
        raise _bad("Every stroke is an object.")
    if stroke.get("tool") not in TOOLS:
        raise _bad("A stroke's tool is a pen or a marker.")
    color = stroke.get("color")
    if not isinstance(color, str) or (color != INK and not _HEX.fullmatch(color)):
        raise _bad("A stroke's colour is ink or #rrggbb.")
    if not _number_in(stroke.get("size"), *SIZE_RANGE):
        raise _bad(f"A stroke's size lies between {SIZE_RANGE[0]} and {SIZE_RANGE[1]:g}.")
    points = stroke.get("pts")
    if not isinstance(points, list):
        raise _bad("A stroke's points are a list.")
    if len(points) > MAX_POINTS:
        raise InkError("too_large", f"A stroke holds at most {MAX_POINTS} points.")
    for point in points:
        if not isinstance(point, list) or len(point) != 3:
            raise _bad("A point is [x, y, pressure].")
        x, y, pressure = point
        if not _coordinate(x) or not _coordinate(y):
            raise _bad("A point lies within a million units of the start.")
        if not _number_in(pressure, 0.0, 1.0):
            raise _bad("A point's pressure lies between 0 and 1.")
    _check_rest(stroke, ("tool", "color", "size", "pts"), 1)


def _check_words(words: Any) -> None:
    if not isinstance(words, list):
        raise _bad("The drawing's words are no list.")
    if len(words) > MAX_WORDS:
        raise InkError("too_large", f"A drawing holds at most {MAX_WORDS} recognised words.")
    for word in words:
        if not isinstance(word, dict) or not isinstance(word.get("t"), str):
            raise _bad("Every recognised word has its text.")
        box = word.get("box")
        if not isinstance(box, list) or len(box) != 4 or not all(_coordinate(value) for value in box):
            raise _bad("Every recognised word has its box [x, y, width, height].")
        if box[2] < 0 or box[3] < 0:
            raise _bad("A word's box has no negative width or height.")
        _check_rest(word, ("box",), 2)


def _check_view(view: Any) -> None:
    if not isinstance(view, dict):
        raise _bad("The drawing's view is an object.")
    if not _coordinate(view.get("x")) or not _coordinate(view.get("y")):
        raise _bad("The view's corner lies within a million units of the start.")
    if not _number_in(view.get("z"), *ZOOM_RANGE):
        raise _bad(f"The view's zoom lies between {ZOOM_RANGE[0]} and {ZOOM_RANGE[1]:g}.")
    if not _number_in(view.get("h"), *HEIGHT_RANGE):
        raise _bad(f"The view's height lies between {HEIGHT_RANGE[0]:g} and {HEIGHT_RANGE[1]:g} pixels.")
    _check_rest(view, ("x", "y", "z", "h"), 2)


def _check_rest(item: dict[str, Any], known: tuple[str, ...], depth: int) -> None:
    """The fields of ``item`` nexlore does not check one by one (unknown ones, and texts): kept as they are, but
    only what can be written back as UTF-8 and is not nested without end."""
    for key, value in item.items():
        _no_surrogate(key)
        if key not in known:
            _plain(value, depth + 1)


def _plain(value: Any, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise _bad("The drawing nests too deep.")
    if isinstance(value, str):
        _no_surrogate(value)
    elif isinstance(value, float) and not math.isfinite(value):
        raise _bad("The drawing holds a number JSON does not know.")
    elif isinstance(value, list):
        for item in value:
            _plain(item, depth + 1)
    elif isinstance(value, dict):
        for key, item in value.items():
            _no_surrogate(key)
            _plain(item, depth + 1)
    elif value is not None and not isinstance(value, bool | int | float):
        raise _bad("The drawing holds a value JSON does not know.")


def _no_surrogate(text: Any) -> None:
    # Half of a character pair (``"\ud800"`` in the JSON): no UTF-8 can hold it, the file could not be written.
    if isinstance(text, str) and _SURROGATE.search(text):
        raise _bad("The drawing holds a broken character.")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _as_float(value: Any) -> float | None:
    """``value`` as a float, or None (no number, a truth value, an integer beyond a float). NaN and infinity come
    through: every check compares against bounds, and NaN fails every comparison, infinity every bound."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        return float(value)
    except OverflowError:
        return None


def _number_in(value: Any, low: float, high: float) -> bool:
    number = _as_float(value)
    return number is not None and low <= number <= high


def _coordinate(value: Any) -> bool:
    number = _as_float(value)
    return number is not None and abs(number) < MAX_COORDINATE


def text_of(data: dict[str, Any]) -> str:
    """What the search finds a drawing by: the recognised text, or its words where only those came."""
    text = data.get("text")
    if isinstance(text, str) and text.strip():
        return text
    words = data.get("words")
    if isinstance(words, list):
        return " ".join(word["t"] for word in words if isinstance(word, dict) and isinstance(word.get("t"), str))
    return ""


# --- Writing --------------------------------------------------------------------------------------------------------


#: The paper of each background in the file, in the same steps as in nexlore (lines 32, squares 24, dots 22 units),
#: in a grey that reads on white and on dark.
_PAPER = {
    "lines": 'width="32" height="32" patternUnits="userSpaceOnUse">'
    '<path d="M0 31.5H32" stroke="#c4c4cf" stroke-width="1" fill="none"/>',
    "grid": 'width="24" height="24" patternUnits="userSpaceOnUse">'
    '<path d="M0 23.5H24M23.5 0V24" stroke="#c4c4cf" stroke-width="1" fill="none"/>',
    "dots": 'width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="1.2" fill="#c4c4cf"/>',
}


def write(data: dict[str, Any]) -> str:
    """The SVG of a drawing ``check`` took, always after the same pattern: the root with the mark, the box of all
    strokes and the ink's colour; the recognised text as ``<desc>``; the data as ``<metadata>``; one ``<path>`` per
    stroke that has points. The same data gives the same bytes."""
    x, y, width, height = _box(data["strokes"])
    root = (
        f'<svg xmlns="http://www.w3.org/2000/svg" {MARK} viewBox="{x} {y} {width} {height}" width="{width}" '
        f'height="{height}" color="{INK_COLOR}">'
    )
    lines = [root]
    text = data.get("text")
    if isinstance(text, str) and text:
        lines.append(f"<desc>{_xml_text(text)}</desc>")
    lines.append(f"{_OPEN}{_json(data)}{_CLOSE}")
    paper = _PAPER.get(data.get("bg", "none"))
    if paper:
        # The paper under the strokes, as far as the box goes: lined or squared in every other program too.
        lines.append(f'<defs><pattern id="paper" {paper}</pattern></defs>')
        lines.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="url(#paper)"/>')
    lines += [path for stroke in data["strokes"] if (path := _path(stroke))]
    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def encode(data: Any) -> bytes:
    """``data`` checked and written as the bytes of the file, or ``InkError`` (``too_large`` past 5 MB)."""
    written = write(check(data)).encode("utf-8")
    if len(written) > MAX_BYTES:
        raise InkError("too_large", "A drawing holds at most 5 MB.")
    return written


def _json(data: dict[str, Any]) -> str:
    # They stand only inside strings of the JSON: escaped there, they stay the same characters.
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return _JSON_ESCAPED.sub(lambda found: f"\\u{ord(found.group()):04x}", text)


def _xml_text(text: str) -> str:
    text = _NOT_XML.sub(" ", text)
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _box(strokes: list[dict[str, Any]]) -> tuple[int, int, int, int]:
    """Every stroke with the room its line takes, plus ``PAD``, in whole units (rounded outwards)."""
    low_x = low_y = math.inf
    high_x = high_y = -math.inf
    for stroke in strokes:
        reach = stroke["size"] * (MARKER_WIDTH / 2 if stroke["tool"] == "marker" else 0.7)
        for x, y, _pressure in stroke["pts"]:
            low_x, low_y = min(low_x, x - reach), min(low_y, y - reach)
            high_x, high_y = max(high_x, x + reach), max(high_y, y + reach)
    if low_x > high_x:
        return EMPTY_BOX
    left, top = math.floor(low_x - PAD), math.floor(low_y - PAD)
    return left, top, math.ceil(high_x + PAD) - left, math.ceil(high_y + PAD) - top


def _number(value: float) -> str:
    """A coordinate with one decimal at most: ``12``, ``-3.5``; never ``-0``."""
    text = f"{value:.1f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _point(point: tuple[float, float]) -> str:
    return f"{_number(point[0])} {_number(point[1])}"


def _path(stroke: dict[str, Any]) -> str:
    points = stroke["pts"]
    if not points:
        return ""
    color = "currentColor" if stroke["color"] == INK else stroke["color"].lower()
    size = stroke["size"]
    if stroke["tool"] == "marker":
        if len(points) == 1:
            shape = f"M{_point(points[0][:2])} l0.1 0"
        else:
            shape = "M" + " L".join(_point(point[:2]) for point in points)
        return (
            f'<path d="{shape}" fill="none" stroke="{color}" stroke-width="{_number(size * MARKER_WIDTH)}" '
            f'stroke-linecap="round" stroke-linejoin="round" opacity="{MARKER_OPACITY}"/>'
        )
    return f'<path d="{_outline(points, size)}" fill="{color}"/>'


def _outline(points: list[list[float]], size: float) -> str:
    """A pen's stroke as a filled shape whose width follows the pressure: the line smoothed, an edge on either side
    at half the width, round at both ends."""

    def width(index: int) -> float:
        return size * (0.35 + 0.95 * points[index][2])

    count = len(points)
    if count == 1:
        x, y = points[0][0], points[0][1]
        radius = _number(width(0) / 2 + 0.4)
        return (
            f"M{_point((x - width(0) / 2 - 0.4, y))} A{radius} {radius} 0 1 0 {_point((x + width(0) / 2 + 0.4, y))} "
            f"A{radius} {radius} 0 1 0 {_point((x - width(0) / 2 - 0.4, y))} Z"
        )
    smooth = []
    for index in range(count):
        before, after = points[max(0, index - 1)], points[min(count - 1, index + 1)]
        here = points[index]
        smooth.append(((before[0] + 2 * here[0] + after[0]) / 4, (before[1] + 2 * here[1] + after[1]) / 4))
    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []
    for index in range(count):
        before, after = smooth[max(0, index - 1)], smooth[min(count - 1, index + 1)]
        dx, dy = after[0] - before[0], after[1] - before[1]
        length = math.hypot(dx, dy) or 1.0
        dx, dy = dx / length, dy / length
        half = width(index) / 2
        x, y = smooth[index]
        left.append((x - dy * half, y + dx * half))
        right.append((x + dy * half, y - dx * half))
    end, start = _number(width(count - 1) / 2), _number(width(0) / 2)
    return (
        "M" + " L".join(_point(point) for point in left)
        + f" A{end} {end} 0 0 0 {_point(right[-1])}"
        + " L" + " L".join(_point(point) for point in reversed(right[:-1]))
        + f" A{start} {start} 0 0 0 {_point(left[0])} Z"
    )


#: A new drawing as a file.
EMPTY = write(BLANK)
