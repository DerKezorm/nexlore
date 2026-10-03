"""Canvases (``.canvas``, JSON Canvas 1.0): written the way Obsidian writes them, read, saved against the state the
page loaded, with versions, the trash and conflict copies, like a note.

All canvases here are made up for the tests; they follow the way Obsidian writes a canvas (tabs, one card per line,
no line break at the end).
"""

from __future__ import annotations

import json
import re
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import Account, File, Version
from app.services import canvas, index, paths, prepare, vault

from .conftest import join
from .test_profile import person

BOM = bytes.fromhex("efbbbf")

#: A canvas as Obsidian writes one: every kind of card, a line with a label, letters beyond ASCII.
WRITTEN = (
    "{\n"
    '\t"nodes":[\n'
    '\t\t{"id":"a1b2c3d4e5f60708","type":"group","x":-300,"y":-460,"width":610,"height":200,"label":"Planung"},\n'
    '\t\t{"id":"0f1e2d3c4b5a6978","type":"file","file":"Projekte/Material.md","x":-280,"y":-200,"width":400,'
    '"height":400,"color":"6"},\n'
    '\t\t{"id":"1122334455667788","type":"text","text":"Größe: 3 × 2,5 m\\n\\n- [[Material]]","x":40,"y":-440,'
    '"width":250,"height":160},\n'
    '\t\t{"id":"99aabbccddeeff00","type":"link","url":"https://example.com/anleitung","x":360,"y":-400,"width":400,'
    '"height":80}\n'
    "\t],\n"
    '\t"edges":[\n'
    '\t\t{"id":"e1e2e3e4e5e6e7e8","fromNode":"0f1e2d3c4b5a6978","fromSide":"right","toNode":"1122334455667788",'
    '"toSide":"left","label":"braucht"}\n'
    "\t]\n"
    "}"
)
#: Fields in another order (a card a plugin made), a field the format does not name, no lines, more keys on top.
ODD = (
    "{\n"
    '\t"type":"canvas",\n'
    '\t"version":2,\n'
    '\t"nodes":[\n'
    '\t\t{"type":"text","text":"Zuerst der Text","id":"5566778899aabbcc","x":0,"y":0,"width":250,"height":60,'
    '"styleAttributes":{"shape":"pill"}},\n'
    '\t\t{"id":"ccbbaa9988776655","x":300,"y":0,"width":250,"height":60,"type":"text","text":"Typ hinten"}\n'
    "\t],\n"
    '\t"edges":[]\n'
    "}"
)


# --- Writing the way Obsidian writes --------------------------------------------------------------------------------


@pytest.mark.parametrize("text", [WRITTEN, ODD, canvas.EMPTY])
def test_a_canvas_comes_out_byte_for_byte_as_obsidian_wrote_it(text: str) -> None:
    assert canvas.serialize(canvas.parse(text)) == text


def test_a_canvas_in_another_form_comes_out_in_obsidians() -> None:
    other = json.dumps(json.loads(WRITTEN), ensure_ascii=False, indent=2) + "\n"
    assert other != WRITTEN
    assert canvas.serialize(canvas.parse(other)) == WRITTEN


def test_the_empty_canvas_is_obsidians_and_has_no_line_break_at_the_end() -> None:
    assert canvas.EMPTY == '{\n\t"nodes":[],\n\t"edges":[]\n}'
    assert canvas.parse(canvas.EMPTY) == {"nodes": [], "edges": []}


def test_a_canvas_is_no_larger_than_a_note() -> None:
    assert canvas.MAX_BYTES == prepare.MAX_NOTE_BYTES


# --- What is a canvas nexlore keeps ---------------------------------------------------------------------------------


def test_what_the_format_does_not_name_stays() -> None:
    data = canvas.parse(ODD)
    assert data["type"] == "canvas" and data["version"] == 2
    assert data["nodes"][0]["styleAttributes"] == {"shape": "pill"}
    assert list(data["nodes"][0]) == ["type", "text", "id", "x", "y", "width", "height", "styleAttributes"]


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("{nodes: []}", "bad_canvas"),
        ('{"nodes":[{"id":"a","x":NaN}]}', "bad_canvas"),
        ('{"nodes":[{"id":"a","x":Infinity}]}', "bad_canvas"),
        ("[]", "bad_canvas"),
        ('"text"', "bad_canvas"),
        ('{"nodes":{"id":"a"}}', "bad_canvas"),
        ('{"nodes":{}}', "bad_canvas"),
        ('{"nodes":5}', "bad_canvas"),
        ('{"edges":"none"}', "bad_canvas"),
        ('{"edges":""}', "bad_canvas"),
        ('{"nodes":[{"type":"text"}]}', "bad_canvas"),
        ('{"nodes":[{"id":""}]}', "bad_canvas"),
        ('{"nodes":[{"id":7}]}', "bad_canvas"),
        ('{"nodes":["a"]}', "bad_canvas"),
        ('{"edges":[{"fromNode":"a","toNode":"b"}]}', "bad_canvas"),
    ],
)
def test_what_is_no_canvas_is_refused(text: str, code: str) -> None:
    with pytest.raises(canvas.CanvasError) as caught:
        canvas.parse(text)
    assert caught.value.code == code


def test_nesting_too_deep_is_refused() -> None:
    with pytest.raises(canvas.CanvasError) as caught:
        canvas.parse('{"nodes":' + "[" * 100_000 + "]" * 100_000 + "}")
    assert caught.value.code == "bad_canvas"


def test_too_large_and_too_many_are_refused() -> None:
    with pytest.raises(canvas.CanvasError) as caught:
        canvas.parse('{"nodes":[],"x":"' + "ä" * (canvas.MAX_BYTES // 2) + '"}')
    assert caught.value.code == "too_large"
    many = {"nodes": [{"id": str(number)} for number in range(canvas.MAX_NODES + 1)]}
    with pytest.raises(canvas.CanvasError) as caught:
        canvas.parse(json.dumps(many))
    assert caught.value.code == "too_large"
    canvas.parse(json.dumps({"nodes": many["nodes"][:-1]}))


def test_an_empty_file_is_an_empty_canvas() -> None:
    assert canvas.parse("") == {}
    assert canvas.parse("\ufeff" + canvas.EMPTY) == {"nodes": [], "edges": []}


# --- Making, reading, saving ----------------------------------------------------------------------------------------


@pytest.fixture
def home(client: TestClient, account: Account, vault: Path) -> Path:
    """A space ``Haus`` of the signed-in operator, with a note beside where the canvas goes."""
    (vault / "Haus" / "Projekte").mkdir(parents=True)
    (vault / "Haus" / "Projekte" / "Material.md").write_bytes(b"# Material\n")
    index.scan()
    return vault / "Haus"


def _versions(rel: str) -> list[bytes]:
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == rel, File.deleted_at.is_(None)))
        assert file is not None
        rows = db.scalars(select(Version).where(Version.file_id == file.id).order_by(Version.id)).all()
        return [zlib.decompress(row.content) for row in rows]


def test_a_new_canvas_is_obsidians_empty_one(client: TestClient, home: Path) -> None:
    answer = client.post("/api/canvases", json={"folder": "Haus/Projekte", "name": "Gartenhaus"})
    assert answer.status_code == 201, answer.text
    made = answer.json()
    assert made["path"] == "Haus/Projekte/Gartenhaus.canvas"
    assert made["content"] == canvas.EMPTY and made["readonly"] is False and made["problem"] is None
    assert (home / "Projekte" / "Gartenhaus.canvas").read_bytes() == canvas.EMPTY.encode()
    assert made["hash"] == index.digest(canvas.EMPTY.encode())
    assert _versions(made["path"]) == [canvas.EMPTY.encode()]


def test_a_new_canvas_takes_a_free_name_and_its_ending_once(client: TestClient, home: Path) -> None:
    first = client.post("/api/canvases", json={"folder": "Haus", "name": "Plan"}).json()["path"]
    second = client.post("/api/canvases", json={"folder": "Haus", "name": "plan.canvas"}).json()["path"]
    odd = client.post("/api/canvases", json={"folder": "Haus", "name": "a/b: c?"}).json()["path"]
    assert first == "Haus/Plan.canvas"
    assert second == "Haus/plan 2.canvas"
    assert odd == "Haus/a b c.canvas"
    assert client.post("/api/canvases", json={"folder": "Haus/Fehlt", "name": "X"}).status_code == 404


def test_a_canvas_reads_with_its_state(client: TestClient, home: Path) -> None:
    (home / "Brett.canvas").write_bytes(WRITTEN.encode())
    index.scan()
    answer = client.get("/api/canvas", params={"path": "Haus/Brett.canvas"})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["content"] == WRITTEN and body["hash"] == index.digest(WRITTEN.encode())
    assert body["readonly"] is False and body["lock"] is None
    state = client.get("/api/canvas/state", params={"path": "Haus/Brett.canvas"}).json()
    assert state["hash"] == body["hash"]
    assert client.get("/api/canvas", params={"path": "Haus/Projekte/Material.md"}).json()["detail"]["code"] == "not_a_canvas"
    assert client.get("/api/canvas", params={"path": "Haus/Fehlt.canvas"}).status_code == 404


def test_a_canvas_nexlore_cannot_keep_is_shown_read_only(client: TestClient, home: Path) -> None:
    (home / "Kaputt.canvas").write_bytes(b'{"nodes":[{"id":"a"')
    (home / "Fremd.canvas").write_bytes(b'{"nodes":[],"x":"\xff"}')
    index.scan()
    broken = client.get("/api/canvas", params={"path": "Haus/Kaputt.canvas"}).json()
    assert broken["readonly"] is True and broken["problem"] == "bad_canvas"
    assert broken["content"] == '{"nodes":[{"id":"a"'
    foreign = client.get("/api/canvas", params={"path": "Haus/Fremd.canvas"}).json()
    assert foreign["readonly"] is True and foreign["problem"] == "not_utf8"


def test_a_save_writes_exactly_the_text_and_keeps_a_version(client: TestClient, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    answer = client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"saved": True, "hash": index.digest(WRITTEN.encode()), "conflict": None}
    assert (home / "Brett.canvas").read_bytes() == WRITTEN.encode()
    assert _versions(made["path"])[-1] == WRITTEN.encode()
    # The same text again, with the old base (a save sent twice): nothing to do, no copy.
    again = client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    assert again.json()["saved"] is False and again.json()["conflict"] is None
    assert [path.name for path in home.iterdir() if "conflict" in path.name] == []


def test_another_tab_saving_makes_a_version_of_its_own(client: TestClient, account: Account, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    first = client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    other = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-other0000"})
    other.cookies = client.cookies
    second = other.put("/api/canvas", json={"path": made["path"], "content": ODD, "base_hash": first.json()["hash"]})
    assert second.json()["saved"] is True
    assert _versions(made["path"])[-2:] == [WRITTEN.encode(), ODD.encode()]


def test_a_save_against_a_changed_canvas_goes_into_a_copy(client: TestClient, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    (home / "Brett.canvas").write_bytes(ODD.encode())
    answer = client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    body = answer.json()
    assert body["saved"] is False and body["hash"] == index.digest(ODD.encode())
    assert re.fullmatch(r"Haus/Brett \(conflict \d{4}-\d{2}-\d{2} \d{6}\)\.canvas", body["conflict"])
    assert (home / "Brett.canvas").read_bytes() == ODD.encode()
    assert (home / body["conflict"].split("/", 1)[1]).read_bytes() == WRITTEN.encode()
    # What was on disk went into the history too.
    assert ODD.encode() in _versions(made["path"])


def test_a_save_while_somebody_else_edits_goes_into_a_copy(client: TestClient, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    other = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-other0000"})
    other.cookies = client.cookies
    assert other.post("/api/locks", json={"path": made["path"]}).status_code == 200
    assert client.get("/api/canvas", params={"path": made["path"]}).json()["lock"]["mine"] is False
    answer = client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    assert answer.json()["conflict"] is not None
    assert (home / "Brett.canvas").read_bytes() == canvas.EMPTY.encode()


@pytest.mark.parametrize(
    ("content", "status", "code"),
    [
        ('{"nodes":[{"id":"a"', 422, "bad_canvas"),
        ("[]", 422, "bad_canvas"),
        ('{"nodes":[],"x":"' + "ä" * (canvas.MAX_BYTES // 2) + '"}', 413, "too_large"),
    ],
    ids=["broken", "list", "too_large"],
)
def test_a_save_that_is_no_canvas_is_refused_and_writes_nothing(
    client: TestClient, home: Path, content: str, status: int, code: str
) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    answer = client.put("/api/canvas", json={"path": made["path"], "content": content, "base_hash": made["hash"]})
    assert answer.status_code == status and answer.json()["detail"]["code"] == code
    assert (home / "Brett.canvas").read_bytes() == canvas.EMPTY.encode()


def test_a_note_is_not_saved_as_a_canvas(client: TestClient, home: Path) -> None:
    note = client.get("/api/note", params={"path": "Haus/Projekte/Material.md"}).json()
    answer = client.put(
        "/api/canvas", json={"path": "Haus/Projekte/Material.md", "content": canvas.EMPTY, "base_hash": note["hash"]}
    )
    assert answer.json()["detail"]["code"] == "not_a_canvas"
    assert (home / "Projekte" / "Material.md").read_bytes() == b"# Material\n"


def test_a_mark_at_the_start_of_the_file_stays(client: TestClient, home: Path) -> None:
    (home / "Bom.canvas").write_bytes(b"\xef\xbb\xbf" + canvas.EMPTY.encode())
    index.scan()
    loaded = client.get("/api/canvas", params={"path": "Haus/Bom.canvas"}).json()
    assert loaded["content"] == canvas.EMPTY and loaded["readonly"] is False
    client.put("/api/canvas", json={"path": "Haus/Bom.canvas", "content": WRITTEN, "base_hash": loaded["hash"]})
    assert (home / "Bom.canvas").read_bytes() == b"\xef\xbb\xbf" + WRITTEN.encode()


# --- Rights ---------------------------------------------------------------------------------------------------------


def test_reading_needs_the_right_to_read_and_saving_the_right_to_write(client: TestClient, vault: Path) -> None:
    anna, rita, bob = person("anna"), person("rita"), person("bob")
    assert anna.post("/api/spaces", json={"name": "Garten"}).status_code == 201
    join(anna, "Garten", "rita", "read")
    made = anna.post("/api/canvases", json={"folder": "Garten", "name": "Beete"}).json()
    assert rita.get("/api/canvas", params={"path": made["path"]}).status_code == 200
    saved = rita.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    assert saved.status_code == 403
    assert rita.post("/api/canvases", json={"folder": "Garten", "name": "Meins"}).status_code == 403
    assert bob.get("/api/canvas", params={"path": made["path"]}).status_code == 404
    assert bob.get("/api/canvas/state", params={"path": made["path"]}).status_code == 404
    assert (vault / "Garten" / "Beete.canvas").read_bytes() == canvas.EMPTY.encode()


# --- Versions and the trash -----------------------------------------------------------------------------------------


def test_a_canvas_from_outside_gets_a_version_and_so_does_each_change(home: Path) -> None:
    (home / "Brett.canvas").write_bytes(WRITTEN.encode())
    index.scan()
    assert _versions("Haus/Brett.canvas") == [WRITTEN.encode()]
    (home / "Brett.canvas").write_bytes(ODD.encode())
    index.scan()
    assert _versions("Haus/Brett.canvas") == [WRITTEN.encode(), ODD.encode()]


def test_a_canvas_larger_than_a_note_is_only_hashed(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    large = ('{"nodes":[],"x":"' + "a" * (canvas.MAX_BYTES + 1) + '"}').encode()
    (home / "Gross.canvas").write_bytes(large)
    hashed: list[str] = []
    real = prepare.hash_file
    monkeypatch.setattr(prepare, "hash_file", lambda path: hashed.append(path) or real(path))
    index.scan()
    assert any(path.endswith("Gross.canvas") for path in hashed)
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Haus/Gross.canvas"))
        assert file is not None and file.hash == index.digest(large)
    assert _versions("Haus/Gross.canvas") == []
    assert prepare.prepare(str(paths.vault_root()), "Haus/Gross.canvas").compressed is None


def test_a_canvas_larger_than_a_note_goes_to_the_trash_whole(client: TestClient, home: Path) -> None:
    large = ('{"nodes":[],"x":"' + "a" * (canvas.MAX_BYTES + 1) + '"}').encode()
    (home / "Gross.canvas").write_bytes(large)
    index.scan()
    assert client.request("DELETE", "/api/files", params={"path": "Haus/Gross.canvas"}).status_code == 200
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Haus/Gross.canvas"))
        assert file is not None
        # Moved into the trash folder as it is, never read into memory for a version.
        assert db.scalars(select(Version).where(Version.file_id == file.id)).all() == []
        assert vault.trash_file(file.id).read_bytes() == large
    entry = next(item for item in client.get("/api/trash").json() if item["path"] == "Haus/Gross.canvas")
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert (home / "Gross.canvas").read_bytes() == large


def test_a_canvas_comes_back_from_the_trash(client: TestClient, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    assert client.request("DELETE", "/api/files", params={"path": made["path"]}).status_code == 200
    assert not (home / "Brett.canvas").exists()
    entry = next(item for item in client.get("/api/trash").json() if item["path"] == made["path"])
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert (home / "Brett.canvas").read_bytes() == WRITTEN.encode()


def test_what_was_on_disk_when_a_canvas_went_to_the_trash_comes_back(client: TestClient, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    # Changed outside a moment before, the watcher has not seen it yet.
    (home / "Brett.canvas").write_bytes(ODD.encode())
    assert client.request("DELETE", "/api/files", params={"path": made["path"]}).status_code == 200
    entry = next(item for item in client.get("/api/trash").json() if item["path"] == made["path"])
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert (home / "Brett.canvas").read_bytes() == ODD.encode()


def test_a_canvas_trashed_before_canvases_had_versions_comes_back_from_its_file(home: Path) -> None:
    (home / "Alt.canvas").write_bytes(WRITTEN.encode())
    index.scan()
    with index.guard, SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Haus/Alt.canvas"))
        assert file is not None
        db.execute(delete(Version).where(Version.file_id == file.id))
        # As the trash took any file other than a note before: moved whole into the trash folder.
        vault._move(home / "Alt.canvas", vault.trash_file(file.id))
        index.forget(db, file, how=index.APP, by="tester")
        db.commit()
        entry = f"f-{file.id}"
    actor = vault.Actor(name="tester", client="tab-tests000")
    assert vault.restore_trash(entry, actor=actor) == ["Haus/Alt.canvas"]
    assert (home / "Alt.canvas").read_bytes() == WRITTEN.encode()
    # From now on it has versions like any canvas.
    assert _versions("Haus/Alt.canvas") == [WRITTEN.encode()]


def test_an_old_version_of_a_canvas_comes_back(client: TestClient, home: Path) -> None:
    made = client.post("/api/canvases", json={"folder": "Haus", "name": "Brett"}).json()
    other = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-other0000"})
    other.cookies = client.cookies
    first = client.put("/api/canvas", json={"path": made["path"], "content": WRITTEN, "base_hash": made["hash"]})
    other.put("/api/canvas", json={"path": made["path"], "content": ODD, "base_hash": first.json()["hash"]})
    rows = client.get("/api/versions", params={"path": made["path"]}).json()
    old = next(row for row in rows if client.get(f"/api/versions/{row['id']}").json()["content"] == WRITTEN)
    assert client.post(f"/api/versions/{old['id']}/restore").status_code == 200
    assert (home / "Brett.canvas").read_bytes() == WRITTEN.encode()
    # The state before stays as a version of its own.
    assert ODD.encode() in _versions(made["path"])


# --- Where a canvas names files, and what follows a move ------------------------------------------------------------

#: A board in the space ``Haus``: a note, a note's section, a picture as background, one card pointing nowhere, one
#: into another space, a ``file`` that is no reference (a text card's field, one deep inside a card, one in a line).
BOARD = (
    "{\n"
    '\t"nodes":[\n'
    '\t\t{"id":"g000000000000001","type":"group","x":0,"y":0,"width":900,"height":600,"label":"Alles",'
    '"background":"Anhänge/skizze.png","backgroundStyle":"cover"},\n'
    '\t\t{"id":"n000000000000001","type":"file","file":"Projekte/Material.md","x":20,"y":20,"width":300,'
    '"height":200},\n'
    '\t\t{"id":"n000000000000002","type":"file","file":"Projekte/Material.md","subpath":"#Holz","x":340,"y":20,'
    '"width":300,"height":200},\n'
    '\t\t{"id":"n000000000000003","type":"file","file":"Projekte/Fehlt.md","x":20,"y":240,"width":300,"height":100},\n'
    '\t\t{"id":"n000000000000004","type":"file","file":"Garten/Beete.md","x":340,"y":240,"width":300,"height":100},\n'
    '\t\t{"id":"t000000000000001","type":"text","text":"kein Verweis","file":"Projekte/Material.md","x":20,'
    '"y":360,"width":200,"height":60,"extra":{"file":"Projekte/Material.md"}}\n'
    "\t],\n"
    '\t"edges":[\n'
    '\t\t{"id":"e000000000000001","fromNode":"n000000000000001","toNode":"n000000000000002","type":"file",'
    '"file":"Projekte/Material.md"}\n'
    "\t]\n"
    "}"
)


def test_references_are_the_cards_files_with_their_place_in_the_text() -> None:
    found = canvas.references(BOARD)
    assert [(ref.field, ref.target, ref.subpath) for ref in found] == [
        ("background", "Anhänge/skizze.png", ""),
        ("file", "Projekte/Material.md", ""),
        ("file", "Projekte/Material.md", "#Holz"),
        ("file", "Projekte/Fehlt.md", ""),
        ("file", "Garten/Beete.md", ""),
    ]
    for ref in found:
        assert json.loads(BOARD[ref.start : ref.end]) == ref.target
    with_mark = "\ufeff" + BOARD
    assert [ref.start - 1 for ref in canvas.references(with_mark)] == [ref.start for ref in found]


def test_a_reference_written_with_escapes_is_found_and_decoded() -> None:
    text = '{"nodes":[{"id":"a","type":"file","file":"Anh\\u00e4nge\\/Bild.png","x":0,"y":0,"width":1,"height":1}]}'
    (ref,) = canvas.references(text)
    assert ref.target == "Anhänge/Bild.png"
    assert text[ref.start : ref.end] == '"Anh\\u00e4nge\\/Bild.png"'


@pytest.fixture
def board(client: TestClient, home: Path, vault: Path) -> Path:
    (home / "Anhänge").mkdir()
    (home / "Anhänge" / "skizze.png").write_bytes(b"\x89PNG\r\n\x1a\nnot really")
    (home / "Projekte" / "Material.md").write_bytes(b"# Material\n\n## Holz\n\nLaerche.\n")
    (vault / "Garten").mkdir()
    (vault / "Garten" / "Beete.md").write_bytes(b"# Beete\n")
    (home / "Brett.canvas").write_bytes(BOARD.encode())
    index.scan()
    return home / "Brett.canvas"


def _outgoing(client: TestClient, path: str) -> dict[tuple[str, str], str | None]:
    answer = client.get("/api/links", params={"path": path}).json()["outgoing"]
    return {(item["target"], item["subpath"]): item["path"] for item in answer}


def test_a_note_shows_the_canvases_it_lies_on(client: TestClient, board: Path) -> None:
    backlinks = client.get("/api/links", params={"path": "Haus/Projekte/Material.md"}).json()["backlinks"]
    assert [(item["path"], item["kind"], item["context"]) for item in backlinks] == [
        ("Haus/Brett.canvas", "canvas", None),
        ("Haus/Brett.canvas", "canvas", None),
    ]
    picture = client.get("/api/links", params={"path": "Haus/Anhänge/skizze.png"}).json()["backlinks"]
    assert [item["path"] for item in picture] == ["Haus/Brett.canvas"]


def test_a_canvas_knows_which_cards_lead_somewhere(client: TestClient, board: Path) -> None:
    assert _outgoing(client, "Haus/Brett.canvas") == {
        ("Anhänge/skizze.png", ""): "Haus/Anhänge/skizze.png",
        ("Projekte/Material.md", ""): "Haus/Projekte/Material.md",
        ("Projekte/Material.md", "#Holz"): "Haus/Projekte/Material.md",
        ("Projekte/Fehlt.md", ""): None,
        # Another space's name in front: a card from there, for whoever may read it.
        ("Garten/Beete.md", ""): "Garten/Beete.md",
    }


def test_a_path_written_from_the_top_of_the_whole_vault_leads_there(client: TestClient, board: Path) -> None:
    board.write_bytes(BOARD.replace('"Projekte/Material.md","x":20', '"Haus/Projekte/Material.md","x":20').encode())
    index.scan()
    assert _outgoing(client, "Haus/Brett.canvas")[("Haus/Projekte/Material.md", "")] == "Haus/Projekte/Material.md"


def test_renaming_a_note_writes_its_new_path_into_the_canvas_and_nothing_else(client: TestClient, board: Path) -> None:
    answer = client.post(
        "/api/move", json={"source": "Haus/Projekte/Material.md", "destination": "Haus/Projekte/Stoffe.md"}
    )
    assert answer.status_code == 200, answer.text
    assert answer.json()["rewritten"] == 1
    # Only the two file cards: the text card's field, the field deep in a card and the line's stay as they were.
    cards = ('"id":"n000000000000001"', '"id":"n000000000000002"')
    expected = "\n".join(
        line.replace('"file":"Projekte/Material.md"', '"file":"Projekte/Stoffe.md"') if line.lstrip().startswith(
            tuple("{" + card for card in cards)) else line
        for line in BOARD.split("\n")
    )
    assert expected.count("Stoffe.md") == 2 and expected.count("Material.md") == 3
    assert board.read_bytes().decode() == expected
    assert _outgoing(client, "Haus/Brett.canvas")[("Projekte/Stoffe.md", "")] == "Haus/Projekte/Stoffe.md"
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Haus/Brett.canvas"))
        assert file is not None
        newest = db.scalars(select(Version).where(Version.file_id == file.id).order_by(Version.id.desc())).first()
        assert newest is not None and newest.source == index.RENAME


def test_moving_a_folder_and_a_picture_follows_into_the_canvas(client: TestClient, board: Path) -> None:
    assert client.post("/api/move", json={"source": "Haus/Projekte", "destination": "Haus/Alt"}).status_code == 200
    moved = client.post("/api/move", json={"source": "Haus/Anhänge/skizze.png", "destination": "Haus/Anhänge/plan.png"})
    assert moved.status_code == 200
    data = json.loads(board.read_bytes())
    assert [node.get("file") or node.get("background") for node in data["nodes"][:4]] == [
        "Anhänge/plan.png", "Alt/Material.md", "Alt/Material.md", "Projekte/Fehlt.md",
    ]


def test_a_path_with_the_spaces_name_in_front_keeps_it(client: TestClient, board: Path) -> None:
    board.write_bytes(BOARD.replace('"Projekte/Material.md","x":20', '"Haus/Projekte/Material.md","x":20').encode())
    index.scan()
    client.post("/api/move", json={"source": "Haus/Projekte/Material.md", "destination": "Haus/Material.md"})
    files = [node.get("file") for node in json.loads(board.read_bytes())["nodes"][1:3]]
    assert files == ["Haus/Material.md", "Material.md"]


def test_an_escaped_path_is_rewritten_plain_and_the_rest_stays(client: TestClient, home: Path) -> None:
    text = (
        '{\n\t"nodes":[\n'
        '\t\t{"id":"a","type":"file","file":"Projekte\\/Material.md","x":0,"y":0,"width":1,"height":1},\n'
        '\t\t{"id":"b","type":"text","text":"bleibt \\u00e4","x":0,"y":0,"width":1,"height":1}\n'
        '\t],\n\t"edges":[]\n}'
    )
    (home / "Brett.canvas").write_bytes(text.encode())
    index.scan()
    client.post("/api/move", json={"source": "Haus/Projekte/Material.md", "destination": "Haus/Projekte/Möbel.md"})
    expected = text.replace('"Projekte\\/Material.md"', '"Projekte/Möbel.md"')
    assert (home / "Brett.canvas").read_bytes().decode() == expected


def test_a_moved_canvas_still_names_its_cards(client: TestClient, board: Path, home: Path) -> None:
    moved = client.post("/api/move", json={"source": "Haus/Brett.canvas", "destination": "Haus/Projekte/Brett.canvas"})
    assert moved.status_code == 200
    assert (home / "Projekte" / "Brett.canvas").read_bytes() == BOARD.encode()
    backlinks = client.get("/api/links", params={"path": "Haus/Projekte/Material.md"}).json()["backlinks"]
    assert {item["path"] for item in backlinks} == {"Haus/Projekte/Brett.canvas"}


def test_a_canvas_stays_a_canvas(client: TestClient, board: Path) -> None:
    answer = client.post("/api/move", json={"source": "Haus/Brett.canvas", "destination": "Haus/Brett.md"})
    assert answer.status_code == 400 and answer.json()["detail"]["code"] == "path_invalid"
    answer = client.post("/api/move", json={"source": "Haus/Brett.canvas", "destination": "Haus/Brett.json"})
    assert answer.status_code == 400 and answer.json()["detail"]["code"] == "path_invalid"
    assert board.exists()


def test_a_deleted_note_leaves_its_card_pointing_nowhere(client: TestClient, board: Path) -> None:
    client.request("DELETE", "/api/files", params={"path": "Haus/Projekte/Material.md"})
    assert _outgoing(client, "Haus/Brett.canvas")[("Projekte/Material.md", "")] is None
    assert board.read_bytes() == BOARD.encode()


def test_a_picture_a_canvas_shows_does_not_go_with_a_note(client: TestClient, board: Path, home: Path) -> None:
    (home / "Projekte" / "Notiz.md").write_bytes("# Notiz\n\n![[Anhänge/skizze.png]]\n".encode())
    index.scan()
    assert client.get("/api/files/own", params={"path": "Haus/Projekte/Notiz.md"}).json()["paths"] == []


def test_a_canvas_nexlore_cannot_read_names_nothing(client: TestClient, home: Path) -> None:
    # A whole card, then the file breaks off: no JSON, so not a card counts.
    (home / "Kaputt.canvas").write_bytes(b'{"nodes":[{"id":"a","type":"file","file":"Projekte/Material.md"},')
    index.scan()
    assert client.get("/api/links", params={"path": "Haus/Kaputt.canvas"}).json()["outgoing"] == []


def test_a_card_finds_its_file_by_path_only(client: TestClient, home: Path) -> None:
    # Obsidian reads a card's path from the top of the vault, never by name the way a wiki link finds a note.
    text = '{"nodes":[{"id":"a","type":"file","file":"Material.md","x":0,"y":0,"width":1,"height":1}]}'
    (home / "Brett.canvas").write_bytes(text.encode())
    index.scan()
    assert _outgoing(client, "Haus/Brett.canvas") == {("Material.md", ""): None}


def test_a_name_that_changes_only_its_case_is_written_anew(client: TestClient, board: Path) -> None:
    answer = client.post(
        "/api/move", json={"source": "Haus/Projekte/Material.md", "destination": "Haus/Projekte/material.md"}
    )
    assert answer.status_code == 200, answer.text
    files = [node.get("file") for node in json.loads(board.read_bytes())["nodes"][1:3]]
    assert files == ["Projekte/material.md", "Projekte/material.md"]


def test_a_mark_at_the_start_stays_when_a_move_rewrites_the_canvas(client: TestClient, board: Path) -> None:
    board.write_bytes(BOM + BOARD.encode())
    index.scan()
    client.post("/api/move", json={"source": "Haus/Projekte/Material.md", "destination": "Haus/Projekte/Stoffe.md"})
    data = board.read_bytes()
    assert data.startswith(BOM) and data.count(b"Stoffe.md") == 2


# --- Cards from another space ---------------------------------------------------------------------------------------

#: A canvas in "Haus" with a card from "Garten", one that leads nowhere there, and one of its own.
ACROSS = (
    '{\n\t"nodes":[\n'
    '\t\t{"id":"a","type":"file","file":"Garten/Beete.md","x":0,"y":0,"width":100,"height":60},\n'
    '\t\t{"id":"b","type":"file","file":"Garten/Fehlt.md","x":200,"y":0,"width":100,"height":60},\n'
    '\t\t{"id":"c","type":"file","file":"Notiz.md","x":400,"y":0,"width":100,"height":60}\n'
    '\t],\n\t"edges":[]\n}'
)


class Across:
    """anna manages "Haus" (the canvas) and "Garten"; bob reads "Haus" only, carl both, eve "Garten" only."""

    def __init__(self, vault: Path) -> None:
        self.anna, self.bob, self.carl, self.eve = person("anna"), person("bob"), person("carl"), person("eve")
        for name in ("Haus", "Garten"):
            assert self.anna.post("/api/spaces", json={"name": name}).status_code == 201
        (vault / "Garten" / "Beete.md").write_bytes(b"# Beete\n\nTomaten.\n")
        (vault / "Haus" / "Notiz.md").write_bytes(b"# Notiz\n")
        (vault / "Haus" / "Brett.canvas").write_bytes(ACROSS.encode())
        index.scan()
        join(self.anna, "Haus", "bob", "read")
        join(self.anna, "Haus", "carl", "read")
        join(self.anna, "Garten", "carl", "read")
        join(self.anna, "Garten", "eve", "read")


@pytest.fixture
def across(client: TestClient, account: Account, vault: Path) -> Across:
    return Across(vault)


def test_a_card_from_another_space_leads_there_for_whoever_may_read_it(across: Across) -> None:
    answer = across.carl.get("/api/canvas", params={"path": "Haus/Brett.canvas"}).json()
    assert answer["cards"] == {"Garten/Beete.md": "Garten/Beete.md", "Garten/Fehlt.md": None, "Notiz.md": "Haus/Notiz.md"}
    assert answer["locked"] == []
    assert across.carl.get("/api/note", params={"path": "Garten/Beete.md"}).status_code == 200


def test_whoever_may_not_read_its_space_sees_the_card_locked_and_never_its_content(across: Across) -> None:
    answer = across.bob.get("/api/canvas", params={"path": "Haus/Brett.canvas"}).json()
    # Locked: the card that leads somewhere; the one that leads nowhere is just missing.
    assert answer["cards"] == {"Garten/Beete.md": None, "Garten/Fehlt.md": None, "Notiz.md": "Haus/Notiz.md"}
    assert answer["locked"] == ["Garten/Beete.md"]
    assert "Tomaten" not in json.dumps(answer)
    assert across.bob.get("/api/note", params={"path": "Garten/Beete.md"}).status_code == 404
    outgoing = across.bob.get("/api/links", params={"path": "Haus/Brett.canvas"}).json()["outgoing"]
    assert {item["target"]: item["path"] for item in outgoing}["Garten/Beete.md"] is None


def test_the_note_names_the_canvas_only_to_whoever_may_read_the_canvas(across: Across) -> None:
    def backlinks(who: TestClient) -> list[str]:
        return [item["path"] for item in who.get("/api/links", params={"path": "Garten/Beete.md"}).json()["backlinks"]]

    assert backlinks(across.carl) == ["Haus/Brett.canvas"]
    assert backlinks(across.eve) == []


def test_the_own_space_answers_first(across: Across, vault: Path) -> None:
    (vault / "Haus" / "Garten").mkdir()
    (vault / "Haus" / "Garten" / "Beete.md").write_bytes(b"# Beete im Haus\n")
    index.scan()
    for who in (across.bob, across.carl):
        answer = who.get("/api/canvas", params={"path": "Haus/Brett.canvas"}).json()
        assert answer["cards"]["Garten/Beete.md"] == "Haus/Garten/Beete.md"
        assert answer["locked"] == []


def test_renaming_in_the_other_space_follows_into_the_canvas_with_that_space_in_front(across: Across, vault: Path) -> None:
    moved = across.anna.post("/api/move", json={"source": "Garten/Beete.md", "destination": "Garten/Hochbeete.md"})
    assert moved.status_code == 200, moved.text
    text = (vault / "Haus" / "Brett.canvas").read_bytes().decode()
    assert text == ACROSS.replace('"Garten/Beete.md"', '"Garten/Hochbeete.md"')
    answer = across.carl.get("/api/canvas", params={"path": "Haus/Brett.canvas"}).json()
    assert answer["cards"]["Garten/Hochbeete.md"] == "Garten/Hochbeete.md"


def test_a_card_from_another_space_is_read_strictly_as_a_path(across: Across, vault: Path) -> None:
    (vault / "Garten" / "Weiter" / "Unter").mkdir(parents=True)
    (vault / "Garten" / "Weiter" / "Unter" / "Ernte.md").write_bytes(b"# Ernte\n")
    board = vault / "Haus" / "Brett.canvas"
    board.write_bytes(ACROSS.replace('"Garten/Fehlt.md"', '"Garten/Unter/Ernte.md"').encode())
    index.scan()
    # Not found where it is written: no search by name, as in the own space (Obsidian reads it the same way).
    answer = across.carl.get("/api/canvas", params={"path": "Haus/Brett.canvas"}).json()
    assert answer["cards"]["Garten/Unter/Ernte.md"] is None


def test_renaming_the_other_space_follows_into_the_canvas(across: Across, vault: Path) -> None:
    renamed = across.anna.post("/api/spaces/Garten/rename", json={"name": "Beet"})
    assert renamed.status_code == 200, renamed.text
    text = (vault / "Haus" / "Brett.canvas").read_bytes().decode()
    assert '"file":"Beet/Beete.md"' in text
    answer = across.carl.get("/api/canvas", params={"path": "Haus/Brett.canvas"}).json()
    assert answer["cards"]["Beet/Beete.md"] == "Beet/Beete.md"


def test_before_trashing_the_canvases_it_lies_on_are_named_to_whoever_may_read_them(across: Across, vault: Path) -> None:
    def on(who: TestClient, path: str) -> dict[str, object]:
        answer = who.get("/api/canvases/on", params={"path": path})
        assert answer.status_code == 200, answer.text
        return answer.json()

    assert on(across.anna, "Garten/Beete.md") == {"count": 1, "paths": ["Haus/Brett.canvas"]}
    # A folder: what lies in it.
    assert on(across.anna, "Garten") == {"count": 1, "paths": ["Haus/Brett.canvas"]}
    # Whoever may not read the canvas's space learns nothing of it.
    assert on(across.eve, "Garten/Beete.md") == {"count": 0, "paths": []}
    # The canvas goes into the trash along with its own space: no warning about itself.
    assert on(across.anna, "Haus/Notiz.md") == {"count": 1, "paths": ["Haus/Brett.canvas"]}
    assert on(across.anna, "Haus") == {"count": 0, "paths": []}
    # A canvas in the trash keeps no card worth a word.
    assert across.anna.request("DELETE", "/api/files", params={"path": "Haus/Brett.canvas"}).status_code in (200, 204)
    assert on(across.anna, "Garten/Beete.md") == {"count": 0, "paths": []}
    # Nobody without the right to read the thing itself asks at all.
    assert across.bob.get("/api/canvases/on", params={"path": "Garten/Beete.md"}).status_code == 404
