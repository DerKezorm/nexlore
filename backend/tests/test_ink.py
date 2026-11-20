"""Drawings (``.svg`` with nexlore's strokes inside): the format, read only from its data and written after one pattern,
with every limit; the index (versions, the search, other SVGs left as they were); and the routes to read, save and
make one, with conflicts, locks and rights like a canvas.

All drawings here are made up for the tests.
"""

from __future__ import annotations

import copy
import json
import re
import time
import zlib
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, File, Version
from app.services import attachments, index, ink, paths, prepare, vault

from .conftest import join
from .test_profile import person

SVG = "{http://www.w3.org/2000/svg}"

#: A small sketch: a pen line with pressure, a marker over it, a dot, recognised words, a view, and fields a later
#: version might bring (on top and in a stroke).
SKETCH: dict[str, Any] = {
    "v": 1,
    "bg": "lines",
    "strokes": [
        {"tool": "pen", "color": "ink", "size": 4, "pts": [[10, 20, 0.5], [30, 25, 0.8], [52.5, 22, 1]]},
        {"tool": "marker", "color": "#FACC15", "size": 6, "pts": [[0, 40, 0.5], [60, 40, 0.5]], "layer": 2},
        {"tool": "pen", "color": "#2563eb", "size": 2.5, "pts": [[-100, -50, 0]]},
    ],
    "text": "Router Keller",
    "words": [{"t": "Router", "box": [10, 15, 40, 12]}, {"t": "Keller", "box": [55, 15, 38, 12], "conf": 0.9}],
    "view": {"x": -20, "y": -10, "z": 1.5, "h": 360},
    "later": {"shapes": [{"kind": "circle", "r": 3}], "name": "Größe"},
}
#: A picture somebody else drew: an SVG without the mark.
PICTURE = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/>'
    b"<metadata>{}</metadata></svg>\n"
)


def sketch(**changes: Any) -> dict[str, Any]:
    data = copy.deepcopy(SKETCH)
    data.update(changes)
    return data


def stroke(**changes: Any) -> dict[str, Any]:
    line: dict[str, Any] = {"tool": "pen", "color": "ink", "size": 4, "pts": [[0, 0, 0.5], [10, 10, 0.5]]}
    line.update(changes)
    return line


def drawn(**changes: Any) -> dict[str, Any]:
    """A drawing with one stroke changed as given."""
    return {"v": 1, "bg": "none", "strokes": [stroke(**changes)]}


def refused(data: Any) -> str:
    with pytest.raises(ink.InkError) as caught:
        ink.check(data)
    return caught.value.code


# --- The format -----------------------------------------------------------------------------------------------------


def test_a_drawing_comes_back_as_it_went_in_and_the_same_data_gives_the_same_bytes() -> None:
    text = ink.write(ink.check(sketch()))
    assert ink.parse(text) == SKETCH
    assert ink.write(ink.parse(text)) == text
    assert ink.write(copy.deepcopy(SKETCH)) == text
    # The order of the fields stays as it came.
    assert list(ink.parse(text)) == list(SKETCH)
    assert list(ink.parse(text)["strokes"][1]) == ["tool", "color", "size", "pts", "layer"]


def test_the_empty_drawing() -> None:
    assert ink.parse(ink.EMPTY) == {"v": 1, "bg": "none", "strokes": []}
    assert ink.EMPTY == ink.write(ink.BLANK)
    assert 'viewBox="0 0 680 220" width="680" height="220"' in ink.EMPTY
    assert "<desc>" not in ink.EMPTY and "<path" not in ink.EMPTY
    assert ink.is_ink(ink.EMPTY.encode())


def test_the_file_is_an_svg_every_program_reads_with_the_data_inside() -> None:
    text = ink.write(sketch())
    root = ElementTree.fromstring(text)
    assert root.tag == SVG + "svg"
    assert root.get("data-nexlore-ink") == "1" and root.get("color") == ink.INK_COLOR
    assert [child.tag for child in root] == [SVG + "desc", SVG + "metadata", SVG + "defs", SVG + "rect"] + [SVG + "path"] * 3
    assert root[0].text == "Router Keller"
    assert root[1].get("id") == "nexlore-ink" and json.loads(root[1].text or "") == SKETCH
    pen, marker, dot = root[4], root[5], root[6]
    # A pen: a filled shape of the ink's colour. A marker: a wide line, see-through.
    assert pen.get("fill") == "currentColor" and pen.get("stroke") is None and pen.get("d", "").endswith("Z")
    assert marker.get("fill") == "none" and marker.get("stroke") == "#facc15"
    assert marker.get("stroke-width") == "18" and marker.get("opacity") == "0.38"
    assert marker.get("d") == "M0 40 L60 40"
    assert dot.get("fill") == "#2563eb" and dot.get("d") == "M-100.8 -50 A0.8 0.8 0 1 0 -99.2 -50 A0.8 0.8 0 1 0 -100.8 -50 Z"
    assert text.endswith("</svg>\n") and text.startswith('<svg xmlns="http://www.w3.org/2000/svg" data-nexlore-ink="1"')


@pytest.mark.parametrize(("bg", "step"), [("lines", "32"), ("grid", "24"), ("dots", "22")])
def test_the_paper_is_in_the_file_as_far_as_the_box_goes(bg: str, step: str) -> None:
    root = ElementTree.fromstring(ink.write({**SKETCH, "bg": bg}))
    tags = [child.tag for child in root]
    assert tags[:4] == [SVG + "desc", SVG + "metadata", SVG + "defs", SVG + "rect"]
    pattern, paper = root[2][0], root[3]
    assert pattern.get("id") == "paper" and pattern.get("width") == step and pattern.get("patternUnits") == "userSpaceOnUse"
    assert paper.get("fill") == "url(#paper)"
    assert [paper.get(k) for k in ("x", "y", "width", "height")] == root.get("viewBox", "").split()
    # Under the strokes, never over them.
    assert tags[4:] == [SVG + "path"] * 3


def test_the_pen_follows_the_pressure() -> None:
    light = ink.write(drawn(pts=[[0, 0, 0], [100, 0, 0]]))
    heavy = ink.write(drawn(pts=[[0, 0, 1], [100, 0, 1]]))
    # Half the width at either side of the line: size * (0.35 + 0.95 * pressure) / 2.
    assert ElementTree.fromstring(light)[1].get("d") == "M25 0.7 L75 0.7 A0.7 0.7 0 0 0 75 -0.7 L25 -0.7 A0.7 0.7 0 0 0 25 0.7 Z"
    assert ElementTree.fromstring(heavy)[1].get("d") == "M25 2.6 L75 2.6 A2.6 2.6 0 0 0 75 -2.6 L25 -2.6 A2.6 2.6 0 0 0 25 2.6 Z"


def test_the_box_is_every_stroke_with_its_width_and_a_margin() -> None:
    # A pen reaches 0.7 of its size beyond its points, a marker 1.5; 24 around; whole units, outwards.
    assert ink._box([stroke(pts=[[0, 0, 1], [100, 50, 1]])]) == (-27, -27, 154, 104)
    assert ink._box([stroke(tool="marker", pts=[[0, 0, 1], [100, 50, 1]])]) == (-30, -30, 160, 110)
    assert ink._box([stroke(size=1, pts=[[0.5, 0.5, 1]])]) == (-25, -25, 51, 51)
    assert ink._box([stroke(pts=[])]) == ink.EMPTY_BOX
    assert ink._box([]) == ink.EMPTY_BOX
    text = ink.write(drawn(pts=[[0, 0, 1], [100, 50, 1]]))
    assert 'viewBox="-27 -27 154 104" width="154" height="104"' in text


def test_a_stroke_without_points_draws_nothing_and_stays() -> None:
    data = {"v": 1, "strokes": [stroke(pts=[]), stroke()]}
    text = ink.write(ink.check(data))
    assert text.count("<path") == 1
    assert ink.parse(text) == data


def test_numbers_in_the_paths_have_one_decimal_and_no_minus_zero() -> None:
    assert [ink._number(value) for value in (0, -0.0, -0.04, 12.0, 12.25, -3.55, 999999.94)] == [
        "0", "0", "0", "12", "12.2", "-3.5", "999999.9",
    ]


@pytest.mark.parametrize(
    "text",
    [
        "</metadata><script>alert(1)</script>",
        "</desc><script>alert(1)</script><desc>",
        "]]><![CDATA[ & &amp; &lt; \"quoted\" 'single'",
        "<!-- --> <?xml?> \u2028 \u2029 ä ✓ 🖊",
        "\x00\x01\x08\x0b\x1f\ufffe tab\tline\nend",
    ],
)
def test_a_text_cannot_break_out_of_the_file_and_comes_back_the_same(text: str) -> None:
    data = sketch(text=text, words=[{"t": text, "box": [0, 0, 1, 1]}], later={text: text})
    written = ink.write(ink.check(data))
    root = ElementTree.fromstring(written)
    assert [child.tag for child in root] == [SVG + "desc", SVG + "metadata", SVG + "defs", SVG + "rect"] + [SVG + "path"] * 3
    assert not any(element.tag.endswith("script") for element in root.iter())
    assert ink.parse(written) == data
    # The data holds none of the marks XML reads, whatever the text.
    metadata = written.split('<metadata id="nexlore-ink">', 1)[1].split("</metadata>", 1)[0]
    assert not set("<>&") & set(metadata)
    assert written.count("</metadata>") == 1


def test_the_paths_are_never_read() -> None:
    """A file changed elsewhere (a script added, a path drawn) opens with its data only."""
    text = ink.write(sketch())
    tampered = text.replace("</svg>", '<script>alert(1)</script><path d="M0 0 L999 999"/></svg>')
    assert ink.parse(tampered) == SKETCH
    assert "<script" not in ink.write(ink.parse(tampered))


def test_the_mark_counts_only_near_the_start() -> None:
    mark = b'data-nexlore-ink="1"'
    assert ink.is_ink(mark)
    assert ink.is_ink(b" " * (2048 - len(mark)) + mark)
    assert not ink.is_ink(b" " * (2049 - len(mark)) + mark)
    assert not ink.is_ink(PICTURE)
    assert not ink.is_ink(b'<svg data-nexlore-ink="0">')


def test_what_the_search_finds_in_a_drawing() -> None:
    assert ink.text_of(SKETCH) == "Router Keller"
    assert ink.text_of(sketch(text="")) == "Router Keller"
    assert ink.text_of(sketch(text=" ", words=[{"t": "Keller", "box": [0, 0, 1, 1]}])) == "Keller"
    assert ink.text_of({"v": 1, "strokes": []}) == ""


# --- What is a drawing nexlore keeps --------------------------------------------------------------------------------


def test_what_the_format_does_not_name_stays_and_what_it_names_may_be_left_out() -> None:
    assert ink.check({"v": 1, "strokes": []}) == {"v": 1, "strokes": []}
    assert ink.check(sketch(view=None))["view"] is None
    data = ink.check(sketch(v=1, future=[{"a": None, "b": True, "c": 1.5}]))
    assert data["future"] == [{"a": None, "b": True, "c": 1.5}]
    for background in ink.BACKGROUNDS:
        ink.check(sketch(bg=background))
    for tool in ink.TOOLS:
        ink.check(drawn(tool=tool))
    for color in ("ink", "#000000", "#ffffff", "#AbCdEf"):
        ink.check(drawn(color=color))


@pytest.mark.parametrize(
    ("data", "code"),
    [
        ([], "bad_ink"),
        ("drawing", "bad_ink"),
        ({"strokes": []}, "bad_ink"),
        ({"v": 0, "strokes": []}, "bad_ink"),
        ({"v": "1", "strokes": []}, "bad_ink"),
        ({"v": 1.0, "strokes": []}, "bad_ink"),
        ({"v": True, "strokes": []}, "bad_ink"),
        ({"v": 2, "strokes": []}, "newer_ink"),
        ({"v": 1}, "bad_ink"),
        ({"v": 1, "strokes": {}}, "bad_ink"),
        ({"v": 1, "strokes": [], "bg": "paper"}, "bad_ink"),
        ({"v": 1, "strokes": [], "bg": None}, "bad_ink"),
        ({"v": 1, "strokes": ["line"]}, "bad_ink"),
        (drawn(tool="brush"), "bad_ink"),
        (drawn(tool=None), "bad_ink"),
        (drawn(color="red"), "bad_ink"),
        (drawn(color="#12345"), "bad_ink"),
        (drawn(color="#1234567"), "bad_ink"),
        (drawn(color="#12345g"), "bad_ink"),
        (drawn(color=" #123456"), "bad_ink"),
        (drawn(color=None), "bad_ink"),
        (drawn(size="4"), "bad_ink"),
        (drawn(size=True), "bad_ink"),
        (drawn(size=None), "bad_ink"),
        (drawn(size=0.49), "bad_ink"),
        (drawn(size=64.01), "bad_ink"),
        (drawn(size=float("nan")), "bad_ink"),
        (drawn(size=float("inf")), "bad_ink"),
        (drawn(pts={}), "bad_ink"),
        (drawn(pts=None), "bad_ink"),
        (drawn(pts=[[0, 0]]), "bad_ink"),
        (drawn(pts=[[0, 0, 0.5, 1]]), "bad_ink"),
        (drawn(pts=[(0, 0, 0.5)]), "bad_ink"),
        (drawn(pts=["0,0,0.5"]), "bad_ink"),
        (drawn(pts=[[1_000_000, 0, 0.5]]), "bad_ink"),
        (drawn(pts=[[0, -1_000_000, 0.5]]), "bad_ink"),
        (drawn(pts=[[-1_000_000, 0, 0.5]]), "bad_ink"),
        (drawn(pts=[[0, 1e300, 0.5]]), "bad_ink"),
        (drawn(pts=[[10**400, 0, 0.5]]), "bad_ink"),
        (drawn(pts=[[float("nan"), 0, 0.5]]), "bad_ink"),
        (drawn(pts=[[0, float("-inf"), 0.5]]), "bad_ink"),
        (drawn(pts=[["0", 0, 0.5]]), "bad_ink"),
        (drawn(pts=[[0, False, 0.5]]), "bad_ink"),
        (drawn(pts=[[0, 0, -0.01]]), "bad_ink"),
        (drawn(pts=[[0, 0, 1.01]]), "bad_ink"),
        (drawn(pts=[[0, 0, None]]), "bad_ink"),
        (drawn(pts=[[0, 0, True]]), "bad_ink"),
        (sketch(text=5), "bad_ink"),
        (sketch(text=None), "bad_ink"),
        (sketch(words={}), "bad_ink"),
        (sketch(words=["Router"]), "bad_ink"),
        (sketch(words=[{"box": [0, 0, 1, 1]}]), "bad_ink"),
        (sketch(words=[{"t": 5, "box": [0, 0, 1, 1]}]), "bad_ink"),
        (sketch(words=[{"t": "a"}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [0, 0, 1]}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [0, 0, 1, 1, 1]}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [0, 0, -1, 1]}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [0, 0, 1, -1]}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [0, 0, "1", 1]}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [1e6, 0, 1, 1]}]), "bad_ink"),
        (sketch(words=[{"t": "a", "box": [0, 0, 1, float("nan")]}]), "bad_ink"),
        (sketch(view=[]), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 1}), "bad_ink"),
        (sketch(view={"x": 0, "z": 1, "h": 360}), "bad_ink"),
        (sketch(view={"y": 0, "z": 1, "h": 360}), "bad_ink"),
        (sketch(view={"x": 1e6, "y": 0, "z": 1, "h": 360}), "bad_ink"),
        (sketch(view={"x": 0, "y": -1e6, "z": 1, "h": 360}), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 0.049, "h": 360}), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 10.01, "h": 360}), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 1, "h": 79.9}), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 1, "h": 2000.1}), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": "1", "h": 360}), "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 1, "h": True}), "bad_ink"),
        (sketch(later=float("nan")), "bad_ink"),
        (sketch(later=[[{"x": float("inf")}]]), "bad_ink"),
        (sketch(later={1, 2}), "bad_ink"),
        (sketch(text="half \ud800 a pair"), "bad_ink"),
        (sketch(words=[{"t": "\udfff", "box": [0, 0, 1, 1]}]), "bad_ink"),
        (sketch(later={"\ud83d": 1}), "bad_ink"),
        (sketch(**{"\ud83d": 1}), "bad_ink"),
        ({"v": 1, "strokes": [stroke(**{"\udc00": 1})]}, "bad_ink"),
        ({"v": 1, "strokes": [stroke(extra=["\udc00"])]}, "bad_ink"),
        (sketch(view={"x": 0, "y": 0, "z": 1, "h": 360, "note": "\udc00"}), "bad_ink"),
    ],
)
def test_what_is_no_drawing_is_refused(data: Any, code: str) -> None:
    assert refused(data) == code


@pytest.mark.parametrize(
    "data",
    [
        drawn(size=0.5), drawn(size=64), drawn(size=4.25),
        drawn(pts=[[999_999.9, -999_999.9, 0]]), drawn(pts=[[0, 0, 1]]), drawn(pts=[[0.5, -0.5, 0.0]]),
        sketch(view={"x": 999_999, "y": -999_999, "z": 0.05, "h": 80}),
        sketch(view={"x": 0, "y": 0, "z": 10, "h": 2000}),
        sketch(words=[{"t": "", "box": [-5, -5, 0, 0]}]),
        sketch(text="a" * ink.MAX_TEXT),
    ],
)
def test_what_lies_on_a_limit_is_taken(data: dict[str, Any]) -> None:
    assert ink.check(data) is data
    assert ink.parse(ink.write(data)) == data


def test_too_many_is_too_large_and_one_less_is_fine() -> None:
    line = stroke(pts=[[0, 0, 0.5]])
    assert ink.check({"v": 1, "strokes": [line] * ink.MAX_STROKES})
    assert refused({"v": 1, "strokes": [line] * (ink.MAX_STROKES + 1)}) == "too_large"
    assert ink.check(drawn(pts=[[0, 0, 0.5]] * ink.MAX_POINTS))
    assert refused(drawn(pts=[[0, 0, 0.5]] * (ink.MAX_POINTS + 1))) == "too_large"
    assert refused(sketch(text="a" * (ink.MAX_TEXT + 1))) == "too_large"
    word = {"t": "a", "box": [0, 0, 1, 1]}
    assert ink.check(sketch(words=[word] * ink.MAX_WORDS))
    assert refused(sketch(words=[word] * (ink.MAX_WORDS + 1))) == "too_large"


def test_the_limits_are_those_of_the_format() -> None:
    assert (ink.MAX_STROKES, ink.MAX_POINTS, ink.MAX_TEXT, ink.MAX_WORDS) == (20_000, 10_000, 100_000, 20_000)
    assert ink.MAX_BYTES == prepare.MAX_NOTE_BYTES == 5 * 1024 * 1024
    assert ink.MARK_WINDOW == 2048


def test_too_many_points_are_refused_before_they_are_looked_at() -> None:
    # A stroke of one more than allowed, every point wrong: the count says no first.
    assert refused(drawn(pts=[None] * (ink.MAX_POINTS + 1))) == "too_large"
    assert refused({"v": 1, "strokes": [None] * (ink.MAX_STROKES + 1)}) == "too_large"


def test_nesting_too_deep_is_refused() -> None:
    deep: Any = 1
    for _ in range(ink.MAX_DEPTH + 1):
        deep = [deep]
    assert refused(sketch(later=deep)) == "bad_ink"
    shallow: Any = 1
    for _ in range(ink.MAX_DEPTH - 1):
        shallow = [shallow]
    ink.check(sketch(later=shallow))
    text = ink.write(sketch()).replace('"later":', '"later":' + "[" * 100_000 + "]" * 100_000 + ',"x":')
    with pytest.raises(ink.InkError) as caught:
        ink.parse(text)
    assert caught.value.code == "bad_ink"


@pytest.mark.parametrize(
    "text",
    [
        "<svg data-nexlore-ink=\"1\"></svg>",
        '<svg data-nexlore-ink="1"><metadata id="nexlore-ink">{"v":1,"strokes":[]}</svg>',
        '<svg data-nexlore-ink="1"><metadata id="nexlore-ink">{"v":1,"strokes":[</metadata></svg>',
        '<svg data-nexlore-ink="1"><metadata id="nexlore-ink">{"v":1,"strokes":[],"x":NaN}</metadata></svg>',
        '<svg data-nexlore-ink="1"><metadata id="nexlore-ink">{"v":1,"strokes":[],"x":-Infinity}</metadata></svg>',
        '<svg data-nexlore-ink="1"><metadata id="nexlore-ink">{"v":1,"strokes":[],"x":"\\ud800"}</metadata></svg>',
        '<svg data-nexlore-ink="1"><metadata id="nexlore-ink"></metadata></svg>',
        '<svg data-nexlore-ink="1"><metadata>{"v":1,"strokes":[]}</metadata></svg>',
    ],
    ids=["no_data", "not_closed", "broken", "nan", "infinity", "half_pair", "empty", "other_metadata"],
)
def test_a_file_without_data_nexlore_can_read_is_refused(text: str) -> None:
    with pytest.raises(ink.InkError) as caught:
        ink.parse(text)
    assert caught.value.code == "bad_ink"


def test_the_data_is_the_first_of_nexlores_metadata() -> None:
    text = ink.write(sketch())
    head, tail = text.split("<metadata", 1)
    decoy = '<metadata id="other">{"v":1,"strokes":[]}</metadata>'
    assert ink.parse(head + decoy + "<metadata" + tail) == SKETCH


def test_a_file_larger_than_a_note_is_refused() -> None:
    text = ink.write(sketch(text="ä" * (ink.MAX_TEXT // 2)))
    padding = " " * (ink.MAX_BYTES - len(text.encode()) + 1)
    with pytest.raises(ink.InkError) as caught:
        ink.parse(text.replace("</svg>", padding + "</svg>"))
    assert caught.value.code == "too_large"
    ink.parse(text.replace("</svg>", padding[:-1] + "</svg>"))


def test_writing_more_than_a_file_holds_is_refused() -> None:
    many = {"v": 1, "strokes": [stroke(pts=[[number % 1000 + 0.5, number // 1000 + 0.5, 0.5] for number in range(
        ink.MAX_POINTS)])] * 40}
    with pytest.raises(ink.InkError) as caught:
        ink.encode(many)
    assert caught.value.code == "too_large"
    assert ink.encode(sketch()) == ink.write(sketch()).encode()


# --- The index ------------------------------------------------------------------------------------------------------


@pytest.fixture
def home(client: TestClient, account: Account, vault: Path) -> Path:
    """A space ``Haus`` of the signed-in operator, with a note the drawings are made for."""
    (vault / "Haus" / "Projekte").mkdir(parents=True)
    (vault / "Haus" / "Projekte" / "Netzwerk.md").write_bytes(b"# Netzwerk\n")
    index.scan()
    return vault / "Haus"


def _row(rel: str) -> File:
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))
        assert file is not None
        db.expunge(file)
        return file


def _versions(rel: str) -> list[bytes]:
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))
        assert file is not None
        rows = db.scalars(select(Version).where(Version.file_id == file.id).order_by(Version.id)).all()
        return [zlib.decompress(row.content) for row in rows]


def _write(home: Path, name: str, data: dict[str, Any] | bytes) -> bytes:
    raw = data if isinstance(data, bytes) else ink.write(data).encode()
    (home / name).write_bytes(raw)
    return raw


def test_a_drawing_from_outside_gets_a_version_and_so_does_each_change(home: Path) -> None:
    first = _write(home, "Skizze.svg", sketch())
    index.scan()
    assert _versions("Haus/Skizze.svg") == [first]
    assert _row("Haus/Skizze.svg").features == {"ink": 1}
    second = _write(home, "Skizze.svg", sketch(text="Router Dachboden"))
    index.scan()
    assert _versions("Haus/Skizze.svg") == [first, second]


def test_another_svg_stays_a_picture_without_versions(home: Path) -> None:
    (home / "Logo.svg").write_bytes(PICTURE)
    index.scan()
    row = _row("Haus/Logo.svg")
    assert row.features is None and row.hash == index.digest(PICTURE) and row.size == len(PICTURE)
    assert row.title == "Logo.svg" and not row.is_note
    assert _versions("Haus/Logo.svg") == []
    made = prepare.prepare(str(paths.vault_root()), "Haus/Logo.svg")
    assert made is not None and made.compressed is None and made.analysis.body is None
    assert made.analysis == prepare.Analysis(title="Logo.svg")
    assert not prepare.versioned("Haus/Logo.svg", len(PICTURE))
    assert not prepare.versioned("Haus/Logo.svg", len(PICTURE), None)
    # Changed, it still keeps no versions.
    (home / "Logo.svg").write_bytes(PICTURE.replace(b'r="4"', b'r="3"'))
    index.scan()
    assert _versions("Haus/Logo.svg") == []


def test_an_svg_larger_than_a_note_is_only_hashed(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    large = ink.EMPTY.encode() + b" " * ink.MAX_BYTES
    (home / "Gross.svg").write_bytes(large)
    (home / "Bild.svg").write_bytes(PICTURE + b" " * ink.MAX_BYTES)
    hashed: list[str] = []
    real = prepare.hash_file
    monkeypatch.setattr(prepare, "hash_file", lambda path: hashed.append(path) or real(path))
    index.scan()
    assert sorted(Path(path).name for path in hashed) == ["Bild.svg", "Gross.svg"]
    assert _row("Haus/Gross.svg").hash == index.digest(large)
    assert _versions("Haus/Gross.svg") == [] and _versions("Haus/Bild.svg") == []
    assert not prepare.versioned("Haus/Gross.svg", len(large), {"ink": 1})
    assert prepare.versioned("Haus/Gross.svg", ink.MAX_BYTES, {"ink": 1})


def test_a_drawing_says_why_nexlore_cannot_read_it_and_still_keeps_versions(home: Path) -> None:
    broken = ink.EMPTY.replace('"strokes":[]', '"strokes":{}').encode()
    _write(home, "Kaputt.svg", broken)
    _write(home, "Neu.svg", ink.EMPTY.replace('"v":1', '"v":7').encode())
    _write(home, "Fremd.svg", ink.EMPTY.replace('"bg":"none"', '"bg":"\xff"').encode("latin-1"))
    index.scan()
    assert _row("Haus/Kaputt.svg").features == {"ink": 1, "bad_ink": 1}
    assert _row("Haus/Neu.svg").features == {"ink": 1, "newer_ink": 1}
    assert _row("Haus/Fremd.svg").features == {"ink": 1, "not_utf8": 1}
    assert _versions("Haus/Kaputt.svg") == [broken]


def test_the_analysis_of_a_drawing(home: Path) -> None:
    found = prepare.analyse("Haus/Skizze.svg", ink.write(sketch()).encode())
    assert found.features == {"ink": 1} and found.body == "Router Keller" and found.title == "Skizze.svg"
    assert prepare.analyse("Haus/Leer.svg", ink.EMPTY.encode()).body is None
    assert prepare.analyse("Haus/Bom.svg", b"\xef\xbb\xbf" + ink.write(sketch()).encode()).body == "Router Keller"
    too_large = prepare.analyse("Haus/Gross.svg", ink.EMPTY.encode() + b" " * ink.MAX_BYTES)
    assert too_large.features == {"ink": 1, "too_large": 1} and too_large.body is None
    # Too large is said before anything is decoded: not "not UTF-8" for 5 MB that are not.
    not_text = prepare.analyse("Haus/Gross.svg", ink.EMPTY.encode() + b"\xff" * ink.MAX_BYTES)
    assert not_text.features == {"ink": 1, "too_large": 1}
    picture = prepare.analyse("Haus/Logo.svg", PICTURE)
    assert picture.features is None and picture.body is None
    assert prepare.is_read_whole("Haus/Logo.SVG") and paths.is_svg("Haus/Logo.SVG")


def test_the_search_finds_the_text_of_a_drawing(client: TestClient, home: Path) -> None:
    _write(home, "Skizze.svg", sketch(text="Glasfaser bis zum Dachboden"))
    (home / "Logo.svg").write_bytes(PICTURE.replace(b"<circle", b"<text>Glasfaser</text><circle"))
    index.scan()
    hits = client.get("/api/search", params={"q": "dachboden"}).json()
    assert [hit["path"] for hit in hits] == ["Haus/Skizze.svg"]
    assert "Glasfaser" in hits[0]["snippet"]
    # Only the drawing's own text: not another picture's.
    assert [hit["path"] for hit in client.get("/api/search", params={"q": "glasfaser"}).json()] == ["Haus/Skizze.svg"]


def test_a_drawing_comes_back_from_the_trash(client: TestClient, home: Path) -> None:
    raw = _write(home, "Skizze.svg", sketch())
    index.scan()
    assert client.request("DELETE", "/api/files", params={"path": "Haus/Skizze.svg"}).status_code == 200
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Haus/Skizze.svg"))
        assert file is not None
        # Kept as a version, not as a file in the trash folder.
        assert not vault.trash_file(file.id).exists()
    entry = next(item for item in client.get("/api/trash").json() if item["path"] == "Haus/Skizze.svg")
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert (home / "Skizze.svg").read_bytes() == raw


def test_another_svg_goes_to_the_trash_whole(client: TestClient, home: Path) -> None:
    (home / "Logo.svg").write_bytes(PICTURE)
    index.scan()
    assert client.request("DELETE", "/api/files", params={"path": "Haus/Logo.svg"}).status_code == 200
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Haus/Logo.svg"))
        assert file is not None
        assert db.scalars(select(Version).where(Version.file_id == file.id)).all() == []
        assert vault.trash_file(file.id).read_bytes() == PICTURE
    entry = next(item for item in client.get("/api/trash").json() if item["path"] == "Haus/Logo.svg")
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert (home / "Logo.svg").read_bytes() == PICTURE


# --- Making a drawing for a note ------------------------------------------------------------------------------------


def test_a_new_drawing_lands_in_the_notes_attachment_folder_named_like_a_pasted_picture(
    client: TestClient, home: Path
) -> None:
    answer = client.post("/api/inks", json={"note": "Haus/Projekte/Netzwerk.md"})
    assert answer.status_code == 201, answer.text
    assert answer.json() == {"path": "Haus/Projekte/Attachments/Netzwerk 1.svg", "embed": "![[Netzwerk 1.svg]]"}
    full = home / "Projekte" / "Attachments" / "Netzwerk 1.svg"
    assert full.read_bytes() == ink.EMPTY.encode()
    assert _versions("Haus/Projekte/Attachments/Netzwerk 1.svg") == [ink.EMPTY.encode()]
    assert _row("Haus/Projekte/Attachments/Netzwerk 1.svg").features == {"ink": 1}
    second = client.post("/api/inks", json={"note": "Haus/Projekte/Netzwerk.md"}).json()
    assert second == {"path": "Haus/Projekte/Attachments/Netzwerk 2.svg", "embed": "![[Netzwerk 2.svg]]"}
    # Numbered by the whole name, ending included, as pasted pictures are; compared without case.
    (home / "Projekte" / "Attachments" / "Netzwerk 3.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (home / "Projekte" / "Attachments" / "netzwerk 3.SVG").write_bytes(PICTURE)
    third = client.post("/api/inks", json={"note": "Haus/Projekte/Netzwerk.md"}).json()
    assert third["path"] == "Haus/Projekte/Attachments/Netzwerk 4.svg"


def test_a_new_drawing_follows_the_operators_pattern(client: TestClient, home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    moment = time.struct_time((2026, 11, 8, 14, 5, 9, 6, 312, 0))
    monkeypatch.setattr(attachments.time, "localtime", lambda *_args: moment)
    current = client.get("/api/settings/files").json()
    changed = {**current, "pasted_name": "{note}/{date} {n:3}", "attachment_folder": "Anhänge"}
    assert client.put("/api/settings/files", json=changed).status_code == 200
    made = client.post("/api/inks", json={"note": "Haus/Projekte/Netzwerk.md"}).json()
    assert made == {
        "path": "Haus/Projekte/Anhänge/Netzwerk/2026-11-08 001.svg", "embed": "![[2026-11-08 001.svg]]",
    }
    assert (home / "Projekte" / "Anhänge" / "Netzwerk" / "2026-11-08 001.svg").read_bytes() == ink.EMPTY.encode()


def test_the_embed_names_the_path_where_the_name_alone_leads_elsewhere(client: TestClient, home: Path) -> None:
    (home / "Netzwerk 1.svg").write_bytes(PICTURE)
    index.scan()
    made = client.post("/api/inks", json={"note": "Haus/Projekte/Netzwerk.md"}).json()
    assert made == {
        "path": "Haus/Projekte/Attachments/Netzwerk 1.svg", "embed": "![[Projekte/Attachments/Netzwerk 1.svg]]",
    }
    with SessionLocal() as db:
        names = index.Names(db, _row(made["path"]).space_id, preload=False)
        target = made["embed"][3:-2]
        assert index.resolve("embed", target, "Haus/Projekte/Netzwerk.md", names) == _row(made["path"]).id


def test_a_drawing_is_made_only_for_a_note_that_is_there(client: TestClient, home: Path) -> None:
    (home / "Logo.svg").write_bytes(PICTURE)
    index.scan()
    assert client.post("/api/inks", json={"note": "Haus/Logo.svg"}).json()["detail"]["code"] == "not_a_note"
    assert client.post("/api/inks", json={"note": "Haus/Fehlt.md"}).status_code == 404
    assert client.post("/api/inks", json={"note": "Haus/../x.md"}).status_code in (400, 422)
    assert not (home / "Attachments").exists()


def test_a_drawing_is_never_made_over_a_file(home: Path) -> None:
    actor = vault.Actor(name="tester", client="tab-tests000")
    (home / "Da.svg").write_bytes(PICTURE)
    with pytest.raises(vault.VaultError) as caught:
        vault.create_ink("Haus/da.SVG", actor=actor)
    assert caught.value.code == "exists"
    assert (home / "Da.svg").read_bytes() == PICTURE
    with pytest.raises(vault.VaultError) as caught:
        vault.create_ink("Haus/Da.png", actor=actor)
    assert caught.value.code == "path_invalid"
    with pytest.raises(vault.VaultError) as caught:
        vault.create_ink("Fehlt/Da 2.svg", actor=actor)
    assert caught.value.status == 404
    made = vault.create_ink("Haus/Neu/Tief/Da.svg", actor=actor)
    assert made.path == "Haus/Neu/Tief/Da.svg" and (home / "Neu" / "Tief" / "Da.svg").read_bytes() == ink.EMPTY.encode()


# --- Reading and saving ---------------------------------------------------------------------------------------------


@pytest.fixture
def made(client: TestClient, home: Path) -> dict[str, Any]:
    """A new drawing of the note, as the page loads it."""
    path = client.post("/api/inks", json={"note": "Haus/Projekte/Netzwerk.md"}).json()["path"]
    return client.get("/api/ink", params={"path": path}).json()


def _file(home: Path, made: dict[str, Any]) -> Path:
    return home.parent.joinpath(*made["path"].split("/"))


def test_a_drawing_reads_with_its_state(client: TestClient, made: dict[str, Any]) -> None:
    assert made["ink"] == ink.BLANK
    assert made["hash"] == index.digest(ink.EMPTY.encode()) and made["size"] == len(ink.EMPTY.encode())
    assert made["readonly"] is False and made["problem"] is None and made["lock"] is None
    assert made["modified"] == _row(made["path"]).mtime_ns // 1_000_000
    assert set(made) == {"path", "ink", "hash", "size", "modified", "readonly", "problem", "lock"}
    state = client.get("/api/ink/state", params={"path": made["path"]}).json()
    assert state == {"hash": made["hash"], "modified": made["modified"], "lock": None}


def test_reading_what_is_no_drawing(client: TestClient, home: Path) -> None:
    (home / "Logo.svg").write_bytes(PICTURE)
    _write(home, "Kaputt.svg", ink.EMPTY.replace('"strokes":[]', '"strokes":5').encode())
    _write(home, "Fremd.svg", ink.EMPTY.replace('"bg":"none"', '"bg":"\xff"').encode("latin-1"))
    _write(home, "Neu.svg", ink.EMPTY.replace('"v":1', '"v":2').encode())
    index.scan()
    picture = client.get("/api/ink", params={"path": "Haus/Logo.svg"})
    assert picture.status_code == 200
    assert picture.json()["ink"] is None and picture.json()["problem"] == "not_ink" and picture.json()["readonly"] is True
    assert picture.json()["hash"] == index.digest(PICTURE)
    for name, problem in (("Kaputt.svg", "bad_ink"), ("Fremd.svg", "not_utf8"), ("Neu.svg", "newer_ink")):
        body = client.get("/api/ink", params={"path": f"Haus/{name}"}).json()
        assert (body["ink"], body["problem"], body["readonly"]) == (None, problem, True)
    note = client.get("/api/ink", params={"path": "Haus/Projekte/Netzwerk.md"})
    assert note.status_code == 422 and note.json()["detail"]["code"] == "not_a_drawing"
    assert client.get("/api/ink/state", params={"path": "Haus/Projekte/Netzwerk.md"}).status_code == 422
    assert client.get("/api/ink", params={"path": "Haus/Fehlt.svg"}).status_code == 404
    assert client.get("/api/ink/state", params={"path": "Haus/Fehlt.svg"}).status_code == 404


def test_a_save_writes_the_file_after_the_pattern_and_keeps_a_version(
    client: TestClient, home: Path, made: dict[str, Any]
) -> None:
    answer = client.put("/api/ink", json={"path": made["path"], "ink": SKETCH, "base_hash": made["hash"]})
    assert answer.status_code == 200, answer.text
    written = ink.write(SKETCH).encode()
    assert answer.json() == {"saved": True, "hash": index.digest(written), "conflict": None}
    assert _file(home, made).read_bytes() == written
    # Saved by the tab that made it a moment ago: the two are one step, one version.
    assert _versions(made["path"])[-1] == written
    loaded = client.get("/api/ink", params={"path": made["path"]}).json()
    assert loaded["ink"] == SKETCH and loaded["hash"] == index.digest(written)
    # The same drawing again, with the old base (a save sent twice): nothing to do, no copy.
    again = client.put("/api/ink", json={"path": made["path"], "ink": SKETCH, "base_hash": made["hash"]})
    assert again.json() == {"saved": False, "hash": index.digest(written), "conflict": None}
    assert [path.name for path in _file(home, made).parent.iterdir() if "conflict" in path.name] == []
    hits = client.get("/api/search", params={"q": "keller"}).json()
    assert [hit["path"] for hit in hits] == [made["path"]]


def test_another_tab_saving_makes_a_version_of_its_own(client: TestClient, made: dict[str, Any]) -> None:
    first = client.put("/api/ink", json={"path": made["path"], "ink": SKETCH, "base_hash": made["hash"]}).json()
    other = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-other0000"})
    other.cookies = client.cookies
    changed = sketch(text="Router Dachboden")
    second = other.put("/api/ink", json={"path": made["path"], "ink": changed, "base_hash": first["hash"]})
    assert second.json()["saved"] is True
    assert _versions(made["path"])[-2:] == [ink.write(SKETCH).encode(), ink.write(changed).encode()]


def test_a_save_against_a_changed_drawing_goes_into_a_copy(client: TestClient, home: Path, made: dict[str, Any]) -> None:
    outside = _write(_file(home, made).parent, "Netzwerk 1.svg", sketch(text="vom iPad"))
    answer = client.put("/api/ink", json={"path": made["path"], "ink": SKETCH, "base_hash": made["hash"]})
    body = answer.json()
    assert answer.status_code == 200 and body["saved"] is False and body["hash"] == index.digest(outside)
    assert re.fullmatch(r"Haus/Projekte/Attachments/Netzwerk 1 \(conflict \d{4}-\d{2}-\d{2} \d{6}\)\.svg", body["conflict"])
    assert _file(home, made).read_bytes() == outside
    copy_path = home.parent.joinpath(*body["conflict"].split("/"))
    assert copy_path.read_bytes() == ink.write(SKETCH).encode()
    # What was on disk went into the history too, and the copy is a drawing with versions of its own.
    assert outside in _versions(made["path"])
    assert _row(body["conflict"]).features == {"ink": 1}
    assert _versions(body["conflict"]) == [ink.write(SKETCH).encode()]


def test_a_save_while_somebody_else_draws_goes_into_a_copy(client: TestClient, home: Path, made: dict[str, Any]) -> None:
    other = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-other0000"})
    other.cookies = client.cookies
    assert other.post("/api/locks", json={"path": made["path"]}).status_code == 200
    lock = client.get("/api/ink", params={"path": made["path"]}).json()["lock"]
    assert lock["mine"] is False and lock["holder"] == "tester"
    assert client.get("/api/ink/state", params={"path": made["path"]}).json()["lock"]["mine"] is False
    assert other.get("/api/ink/state", params={"path": made["path"]}).json()["lock"]["mine"] is True
    assert client.post("/api/locks", json={"path": made["path"]}).status_code == 423
    answer = client.put("/api/ink", json={"path": made["path"], "ink": SKETCH, "base_hash": made["hash"]})
    assert answer.json()["saved"] is False and answer.json()["conflict"] is not None
    assert _file(home, made).read_bytes() == ink.EMPTY.encode()
    # The holder saves as usual.
    mine = other.put("/api/ink", json={"path": made["path"], "ink": SKETCH, "base_hash": made["hash"]})
    assert mine.json()["saved"] is True and _file(home, made).read_bytes() == ink.write(SKETCH).encode()
    assert other.request("DELETE", "/api/locks", params={"path": made["path"]}).status_code == 204
    assert client.get("/api/ink", params={"path": made["path"]}).json()["lock"] is None


@pytest.mark.parametrize(
    ("data", "status", "code"),
    [
        (drawn(size=100), 422, "bad_ink"),
        ({"v": 2, "strokes": []}, 422, "newer_ink"),
        ({"v": 1, "strokes": [stroke(pts=[[0, 0, 0.5]])] * (ink.MAX_STROKES + 1)}, 413, "too_large"),
        (sketch(text="a" * (ink.MAX_TEXT + 1)), 413, "too_large"),
    ],
    ids=["bad", "newer", "too_many", "too_long"],
)
def test_a_save_that_is_no_drawing_is_refused_and_writes_nothing(
    client: TestClient, home: Path, made: dict[str, Any], data: dict[str, Any], status: int, code: str
) -> None:
    answer = client.put("/api/ink", json={"path": made["path"], "ink": data, "base_hash": made["hash"]})
    assert answer.status_code == status and answer.json()["detail"]["code"] == code
    assert _file(home, made).read_bytes() == ink.EMPTY.encode()
    assert _versions(made["path"]) == [ink.EMPTY.encode()]


def test_a_save_larger_than_a_file_holds_is_refused(client: TestClient, home: Path, made: dict[str, Any]) -> None:
    # Within every count, but the file would pass 5 MB.
    line = stroke(pts=[[number % 1000 + 0.25, number // 1000 + 0.25, 0.5] for number in range(ink.MAX_POINTS)])
    answer = client.put("/api/ink", json={"path": made["path"], "ink": {"v": 1, "strokes": [line] * 20},
                                          "base_hash": made["hash"]})
    assert answer.status_code == 413 and answer.json()["detail"]["code"] == "too_large"
    assert _file(home, made).read_bytes() == ink.EMPTY.encode()


def test_a_number_json_does_not_know_is_refused(client: TestClient, home: Path, made: dict[str, Any]) -> None:
    # JSON knows no NaN, but the request is read by a reader that takes it.
    body = json.dumps({"path": made["path"], "ink": drawn(), "base_hash": made["hash"]}).replace('"size": 4', '"size": NaN')
    assert "NaN" in body
    answer = client.put("/api/ink", content=body, headers={"Content-Type": "application/json"})
    assert answer.status_code == 422
    assert _file(home, made).read_bytes() == ink.EMPTY.encode()


def test_somebodys_picture_is_never_drawn_over(client: TestClient, home: Path) -> None:
    (home / "Logo.svg").write_bytes(PICTURE)
    index.scan()
    answer = client.put("/api/ink", json={"path": "Haus/Logo.svg", "ink": SKETCH, "base_hash": index.digest(PICTURE)})
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "not_ink"
    assert (home / "Logo.svg").read_bytes() == PICTURE
    note = client.get("/api/note", params={"path": "Haus/Projekte/Netzwerk.md"}).json()
    answer = client.put("/api/ink", json={"path": "Haus/Projekte/Netzwerk.md", "ink": SKETCH, "base_hash": note["hash"]})
    assert answer.json()["detail"]["code"] == "not_a_drawing"
    assert (home / "Projekte" / "Netzwerk.md").read_bytes() == b"# Netzwerk\n"


def test_no_other_way_writes_text_into_an_svg(client: TestClient, home: Path, made: dict[str, Any]) -> None:
    script = '<svg data-nexlore-ink="1"><script>alert(1)</script></svg>'
    answer = client.put("/api/note", json={"path": made["path"], "content": script, "base_hash": made["hash"]})
    assert answer.status_code >= 400
    assert _file(home, made).read_bytes() == ink.EMPTY.encode()
    actor = vault.Actor(name="tester", client="tab-tests000")
    with pytest.raises(vault.VaultError) as caught:
        vault.save(made["path"], script.encode(), base_hash=made["hash"], actor=actor)
    assert caught.value.code == "not_a_note"
    assert vault.save(made["path"], ink.write(SKETCH).encode(), base_hash=made["hash"], actor=actor,
                      drawing=True).conflict is None
    with pytest.raises(vault.VaultError):
        vault.save("Haus/Projekte/Netzwerk.png", b"x", base_hash=made["hash"], actor=actor, drawing=True)


# --- Rights ---------------------------------------------------------------------------------------------------------


def test_reading_needs_the_right_to_read_and_saving_and_making_the_right_to_write(client: TestClient, vault: Path) -> None:
    anna, rita, bob = person("anna"), person("rita"), person("bob")
    assert anna.post("/api/spaces", json={"name": "Garten"}).status_code == 201
    assert anna.post("/api/notes", json={"folder": "Garten", "title": "Beete", "content": "# Beete\n"}).status_code == 201
    join(anna, "Garten", "rita", "read")
    made = anna.post("/api/inks", json={"note": "Garten/Beete.md"})
    assert made.status_code == 201, made.text
    path = made.json()["path"]
    loaded = rita.get("/api/ink", params={"path": path})
    assert loaded.status_code == 200 and loaded.json()["ink"] == ink.BLANK
    assert rita.get("/api/ink/state", params={"path": path}).status_code == 200
    saved = rita.put("/api/ink", json={"path": path, "ink": SKETCH, "base_hash": loaded.json()["hash"]})
    assert saved.status_code == 403
    assert rita.post("/api/inks", json={"note": "Garten/Beete.md"}).status_code == 403
    assert rita.post("/api/locks", json={"path": path}).status_code == 403
    for answer in (
        bob.get("/api/ink", params={"path": path}),
        bob.get("/api/ink/state", params={"path": path}),
        bob.put("/api/ink", json={"path": path, "ink": SKETCH, "base_hash": loaded.json()["hash"]}),
        bob.post("/api/inks", json={"note": "Garten/Beete.md"}),
    ):
        assert answer.status_code == 404
    assert vault.joinpath(*path.split("/")).read_bytes() == ink.EMPTY.encode()
    assert sorted(entry.name for entry in (vault / "Garten" / "Attachments").iterdir()) == ["Beete 1.svg"]
    writer = anna.put("/api/ink", json={"path": path, "ink": SKETCH, "base_hash": loaded.json()["hash"]})
    assert writer.status_code == 200 and writer.json()["saved"] is True
