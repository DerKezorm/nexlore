"""Canvases: ``.canvas`` files in the JSON Canvas format (jsoncanvas.org, version 1.0), as Obsidian writes them.

A canvas is a file of the vault like a note: it is saved against the state the page loaded, a change in between goes
into a conflict copy, one person edits at a time, every save is a version. The page writes the text itself; the
server checks that it is a canvas it can keep, not that every field is one the format names. What nexlore does not
know stays in the file as it was (another program's fields, a fifth kind of card).

**The way Obsidian writes a canvas** (measured on 13 files, 12 came out byte for byte): ``{``, every key of the top on
a line of its own after one tab; a list that is not empty as ``"nodes":[``, each element on its own line after two
tabs as compact JSON (no blanks, letters beyond ASCII as they are), a comma after every element but the last, then a
tab and ``]``; an empty list as ``"edges":[]`` on one line; LF, and no line break at the end. Each object keeps the
order of its fields: Obsidian does not sort them. ``serialize`` writes that.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

#: The kind of link a canvas's reference to a file is in the index (beside ``wiki``, ``embed``, ``md``, ``md_embed``).
KIND = "canvas"

#: Each a canvas holds at most; well beyond what a person arranges, well below what makes a page slow to draw.
MAX_NODES = 10_000
MAX_EDGES = 20_000
#: As much as a note (``prepare.MAX_NOTE_BYTES``; not imported, the index reads canvases through this module).
MAX_BYTES = 5 * 1024 * 1024

#: A new canvas, as Obsidian writes an empty one.
EMPTY = '{\n\t"nodes":[],\n\t"edges":[]\n}'


class CanvasError(ValueError):
    def __init__(self, code: str, text: str) -> None:
        super().__init__(text)
        self.code = code
        self.text = text


def _no_constant(name: str) -> None:
    # NaN and Infinity are no JSON; Python would take them, Obsidian and every browser refuse the file.
    raise CanvasError("bad_canvas", "The canvas holds a number JSON does not know.")


def parse(text: str) -> dict[str, Any]:
    """The canvas in ``text``, checked as far as nexlore must: JSON, an object at the top, ``nodes`` and ``edges``
    lists of objects where present, each card and line with an id, within the limits. Anything else may be there."""
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise CanvasError("too_large", "A canvas holds at most 5 MB.")
    text = text.removeprefix("\ufeff")
    try:
        data = json.loads(text, parse_constant=_no_constant) if text.strip() else {}
    except CanvasError:
        raise
    except (ValueError, RecursionError) as exc:
        raise CanvasError("bad_canvas", "The canvas is no JSON nexlore can read.") from exc
    if not isinstance(data, dict):
        raise CanvasError("bad_canvas", "A canvas is an object with nodes and edges.")
    for key, limit in (("nodes", MAX_NODES), ("edges", MAX_EDGES)):
        items = data.get(key, [])
        if not isinstance(items, list):
            raise CanvasError("bad_canvas", f"The canvas's {key} are no list.")
        if len(items) > limit:
            raise CanvasError("too_large", f"A canvas holds at most {limit} {key}.")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise CanvasError("bad_canvas", f"Every element of the canvas's {key} needs an id.")
    return data


def serialize(data: dict[str, Any]) -> str:
    """``data`` written the way Obsidian writes a canvas (see the module's text)."""
    lines = ["{"]
    keys = list(data)
    for position, key in enumerate(keys):
        value = data[key]
        comma = "," if position < len(keys) - 1 else ""
        if isinstance(value, list) and value:
            lines.append("\t" + _compact(key) + ":[")
            last = len(value) - 1
            lines += ["\t\t" + _compact(item) + ("," if number < last else "") for number, item in enumerate(value)]
            lines.append("\t]" + comma)
        else:
            lines.append("\t" + _compact(key) + ":" + _compact(value) + comma)
    lines.append("}")
    return "\n".join(lines)


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# --- Where a canvas names files -------------------------------------------------------------------------------------


@dataclass
class Reference:
    """A file a canvas names: the ``file`` of a file card, or the ``background`` of a group."""

    #: As written, decoded; a path from the top of the space (Obsidian: of the vault).
    target: str
    subpath: str
    #: ``file`` or ``background``.
    field: str
    #: Where the JSON string stands in the text, quotes included: a move writes the new path there.
    start: int
    end: int


#: A JSON token: a string, a mark, anything else up to the next mark (a number, ``true``), or blanks.
_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,"]+|\s+', re.DOTALL)


@dataclass
class _Frame:
    container: str
    key: str | None = None
    #: In an object: whether the next string is a key.
    expect_key: bool = True
    #: In a card: its string fields with where they stand.
    fields: dict[str, tuple[str, int, int]] = field(default_factory=dict)


def references(text: str) -> list[Reference]:
    """The files ``text`` names, with the place of each in the text, so that a move can write a new path there and
    leave every other byte as it was. ``text`` must be a canvas ``parse`` took (a BOM in front is fine). Only cards at
    the top of ``nodes`` count: a ``file`` deeper inside a card (another program's field) is no reference."""
    found: list[Reference] = []
    stack: list[_Frame] = []
    # A BOM in front is a token outside every object, passed over like a number would be.
    for match in _TOKEN.finditer(text):
        token = match.group()
        if token.isspace():
            continue
        top = stack[-1] if stack else None
        if token in "{[":
            if top is not None and top.container == "{":
                top.expect_key = False
            stack.append(_Frame(container=token))
            continue
        if token in "}]":
            frame = stack.pop()
            if frame.container == "{" and _is_card(stack):
                found += _card_references(frame.fields)
            continue
        if top is None or top.container != "{":
            continue
        if token == ",":
            top.expect_key = True
        elif token == ":":
            top.expect_key = False
        elif token.startswith('"'):
            if top.expect_key:
                top.key = json.loads(token)
            elif top.key is not None:
                # Kept for every object; only a card's count when it closes.
                top.fields[top.key] = (json.loads(token), match.start(), match.end())
    return found


def _is_card(outer: list[_Frame]) -> bool:
    """Whether an object inside ``outer`` is a card: the top object, its ``nodes``, then the card."""
    return (
        len(outer) == 2 and outer[0].container == "{" and outer[0].key == "nodes" and outer[1].container == "["
    )


def _card_references(fields: dict[str, tuple[str, int, int]]) -> list[Reference]:
    kind = fields.get("type", ("", 0, 0))[0]
    subpath = fields.get("subpath", ("", 0, 0))[0]
    found = []
    if kind == "file" and "file" in fields:
        target, start, end = fields["file"]
        found.append(Reference(target=target, subpath=subpath, field="file", start=start, end=end))
    if kind == "group" and "background" in fields:
        target, start, end = fields["background"]
        found.append(Reference(target=target, subpath="", field="background", start=start, end=end))
    return found


def written(path: str) -> str:
    """A path as a JSON string, the way Obsidian writes one (letters beyond ASCII as they are)."""
    return _compact(path)
