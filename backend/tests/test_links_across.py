"""Links into another space: ``[[Space/Note]]`` leads there, for whoever may read both.

The world of these tests: ``anna`` manages ``Learning`` and ``Homelab``. ``bob`` may read ``Learning`` only (the
source of the links), ``carl`` may read both. ``dave`` has a space of his own, ``Diary``, that nobody else sees, and
links from there into ``Homelab`` too. Everything that hands out where a link leads is asked by bob and by carl:
for bob a link into ``Homelab`` must look exactly like a link to a note that does not exist, same status, same text.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.db import SessionLocal
from app.main import app
from app.models import File, GraphNode, Link, Setting, Version
from app.services import graphstore, index, settings_service

from .conftest import join, make_account, sign_in

START = (
    "# Start\n\nWhy? See [[Homelab/Why ZFS]] and [[Homelab/Nothing]].\n"
    "Pictures: ![[Homelab/rack.png]] and ![[Homelab/none.png]].\n"
    "Also [md](../Homelab/Why%20ZFS.md) and [gone](../Homelab/Gone.md).\n"
    "From the top: [abs](Homelab/Why%20ZFS.md), [root](/Homelab/Why%20ZFS.md), [low](homelab/Why%20ZFS.md).\n"
)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def person(name: str, tab: str) -> tuple[TestClient, object]:
    row = make_account(name)
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{tab:0<8}"})
    sign_in(client, row)
    return client, row


class World:
    def __init__(self, operator: TestClient) -> None:
        self.operator = operator
        self.anna, _ = person("anna", "anna")
        self.bob, _ = person("bob", "bob")
        self.carl, _ = person("carl", "carl")
        self.dave, _ = person("dave", "dave")


def note(client: TestClient, folder: str, title: str, content: str) -> None:
    made = client.post("/api/notes", json={"folder": folder, "title": title, "content": content})
    assert made.status_code == 201, made.text


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    w = World(client)
    for name in ("Learning", "Homelab"):
        assert w.anna.post("/api/spaces", json={"name": name}).status_code == 201
    assert w.dave.post("/api/spaces", json={"name": "Diary"}).status_code == 201
    note(w.anna, "Homelab", "Why ZFS", "# Why ZFS\n\nchecksums, back to [[Learning/Start]]\n")
    (vault / "Homelab" / "rack.png").write_bytes(PNG)
    note(w.anna, "Learning", "Start", START)
    note(w.anna, "Learning", "Plain", "no links here")
    note(w.dave, "Diary", "Today", "read [[homelab/Why ZFS]] again\n")
    client.post("/api/index/scan")
    join(w.anna, "Learning", "bob", "read")
    for space in ("Learning", "Homelab"):
        join(w.anna, space, "carl", "read")
    return w


def target(source: str, written: str) -> str | None:
    with SessionLocal() as db:
        row = db.execute(
            select(Link.target_id).join(File, File.id == Link.source_id).where(File.path == source, Link.target == written)
        ).first()
        assert row is not None, f"no link {written!r} in {source}"
        return db.scalar(select(File.path).where(File.id == row[0])) if row[0] else None


# --- The index -------------------------------------------------------------------------------------------------------


def test_the_index_resolves_links_into_another_space(world: World) -> None:
    assert target("Learning/Start.md", "Homelab/Why ZFS") == "Homelab/Why ZFS.md"
    assert target("Learning/Start.md", "Homelab/rack.png") == "Homelab/rack.png"
    assert target("Learning/Start.md", "../Homelab/Why ZFS.md") == "Homelab/Why ZFS.md"
    assert target("Learning/Start.md", "Homelab/Nothing") is None
    assert target("Homelab/Why ZFS.md", "Learning/Start") == "Learning/Start.md"
    assert target("Diary/Today.md", "homelab/Why ZFS") == "Homelab/Why ZFS.md"
    assert target("Learning/Start.md", "Homelab/Why ZFS.md") == "Homelab/Why ZFS.md"
    with SessionLocal() as db:
        across = {row.target: row.target_space_id for row in db.scalars(select(Link))}
        homelab = db.scalar(select(File.space_id).where(File.path == "Homelab/Why ZFS.md"))
    assert across["Homelab/Why ZFS"] == homelab
    assert across["Homelab/Nothing"] is None


def test_a_note_that_appears_in_the_other_space_is_found_and_one_that_goes_is_lost(world: World, vault: Path) -> None:
    (vault / "Homelab" / "Nothing.md").write_text("now it is here", encoding="utf-8")
    index.scan()
    assert target("Learning/Start.md", "Homelab/Nothing") == "Homelab/Nothing.md"
    (vault / "Homelab" / "Nothing.md").unlink()
    index.scan()
    assert target("Learning/Start.md", "Homelab/Nothing") is None
    with SessionLocal() as db:
        assert db.scalar(select(Link.target_space_id).where(Link.target == "Homelab/Nothing")) is None


def test_a_saved_note_links_into_another_space_at_once(world: World) -> None:
    state = world.anna.get("/api/note", params={"path": "Learning/Plain.md"}).json()
    saved = world.anna.put(
        "/api/note", json={"path": "Learning/Plain.md", "content": "[[Homelab/Why ZFS]]", "base_hash": state["hash"]}
    )
    assert saved.status_code == 200, saved.text
    assert target("Learning/Plain.md", "Homelab/Why ZFS") == "Homelab/Why ZFS.md"


def test_the_own_space_always_answers_first(world: World, vault: Path) -> None:
    # A folder called like the other space, with a note of that name: the link leads there, for everybody.
    (vault / "Learning" / "Homelab").mkdir()
    (vault / "Learning" / "Homelab" / "Why ZFS.md").write_text("the own one", encoding="utf-8")
    index.scan()
    assert target("Learning/Start.md", "Homelab/Why ZFS") == "Learning/Homelab/Why ZFS.md"
    world.anna.delete("/api/files", params={"path": "Learning/Homelab/Why ZFS.md"})
    assert target("Learning/Start.md", "Homelab/Why ZFS") == "Homelab/Why ZFS.md"


def test_a_big_scan_resolves_links_into_another_space(vault: Path, account: object) -> None:
    for number in range(index.SMALL_CHANGE + 10):
        (vault / "A").mkdir(exist_ok=True)
        (vault / "A" / f"a{number}.md").write_text(f"[[B/b{number}]] and [[B/Sub/b{number}]]", encoding="utf-8")
    (vault / "B" / "Sub").mkdir(parents=True)
    for number in range(index.SMALL_CHANGE + 10):
        (vault / "B" / "Sub" / f"b{number}.md").write_text("b", encoding="utf-8")
    index.scan()
    assert target("A/a3.md", "B/b3") == "B/Sub/b3.md"
    assert target("A/a70.md", "B/Sub/b70") == "B/Sub/b70.md"


def test_links_indexed_before_they_could_cross_are_filled_in_once(world: World) -> None:
    with SessionLocal() as db:
        db.execute(update(Link).values(via=None, target_space_id=None))
        db.execute(update(Link).where(Link.target_space_id.is_(None), Link.target.like("Homelab/%")).values(target_id=None))
        db.query(Setting).filter(Setting.key == index.VIA_FILLED).delete()
        db.commit()
    assert target("Learning/Start.md", "Homelab/Why ZFS") is None
    assert index.fill_via() >= 3
    assert target("Learning/Start.md", "Homelab/Why ZFS") == "Homelab/Why ZFS.md"
    with SessionLocal() as db:
        assert db.scalar(select(Link.via).where(Link.target == "Homelab/Why ZFS").limit(1)) == "homelab"
        assert db.get(Setting, index.VIA_FILLED) is not None
    # Only once.
    with SessionLocal() as db:
        db.execute(update(Link).values(target_id=None))
        db.commit()
    assert index.fill_via() == 0


# --- Every route, asked by bob (source only) and carl (both) -----------------------------------------------------------


def test_the_links_of_a_note_lead_nowhere_for_whoever_may_not_read_the_other_space(world: World) -> None:
    def outgoing(client: TestClient) -> dict[str, dict]:
        answer = client.get("/api/links", params={"path": "Learning/Start.md"})
        assert answer.status_code == 200
        return {item["target"]: item for item in answer.json()["outgoing"]}

    carl = outgoing(world.carl)
    assert carl["Homelab/Why ZFS"]["path"] == "Homelab/Why ZFS.md" and carl["Homelab/Why ZFS"]["title"] == "Why ZFS"
    assert carl["Homelab/rack.png"]["path"] == "Homelab/rack.png"
    bob = outgoing(world.bob)
    for there, nothing in (
        ("Homelab/Why ZFS", "Homelab/Nothing"),
        ("Homelab/rack.png", "Homelab/none.png"),
        ("../Homelab/Why ZFS.md", "../Homelab/Gone.md"),
    ):
        # Exactly like a link to nothing: every field but the words written.
        assert {**bob[there], "target": ""} == {**bob[nothing], "target": "", "line": bob[there]["line"]}
        assert bob[there]["path"] is None and bob[there]["title"] is None


def test_backlinks_from_another_space_show_only_to_its_readers(world: World) -> None:
    def backlinks(client: TestClient, path: str) -> set[str]:
        return {item["path"] for item in client.get("/api/links", params={"path": path}).json()["backlinks"]}

    assert backlinks(world.carl, "Learning/Start.md") == {"Homelab/Why ZFS.md"}
    assert backlinks(world.bob, "Learning/Start.md") == set()
    # dave's Diary links into Homelab: nobody but dave learns of it.
    assert backlinks(world.anna, "Homelab/Why ZFS.md") == {"Learning/Start.md"}
    assert backlinks(world.carl, "Homelab/Why ZFS.md") == {"Learning/Start.md"}
    assert world.dave.get("/api/links", params={"path": "Learning/Start.md"}).status_code == 404


@pytest.mark.parametrize("kind", ["wiki", "embed"])
def test_resolving_a_link_into_a_foreign_space_answers_like_a_missing_one(world: World, kind: str) -> None:
    written, nothing = ("Homelab/Why ZFS", "Homelab/Nothing") if kind == "wiki" else ("Homelab/rack.png", "Homelab/x.png")
    ask = {"source": "Learning/Start.md", "kind": kind}
    there = world.bob.get("/api/resolve", params={**ask, "target": written})
    missing = world.bob.get("/api/resolve", params={**ask, "target": nothing})
    assert (there.status_code, there.text) == (missing.status_code, missing.text) == (200, missing.text)
    assert there.json() == {"path": None, "is_note": False}
    assert world.carl.get("/api/resolve", params={**ask, "target": written}).json()["path"] is not None


def test_resolving_many_links_answers_like_missing_ones(world: World) -> None:
    ask = {"source": "Learning/Start.md", "target": ["Homelab/Why ZFS|so", "Homelab/Nothing"]}
    bob = world.bob.get("/api/resolve/many", params=ask)
    assert bob.status_code == 200
    assert bob.json() == {"found": {"Homelab/Why ZFS|so": None, "Homelab/Nothing": None}}
    carl = world.carl.get("/api/resolve/many", params=ask).json()
    assert carl["found"]["Homelab/Why ZFS|so"] == "Homelab/Why ZFS.md"


def test_suggestions_offer_notes_of_other_readable_spaces_only(world: World) -> None:
    ask = {"q": "zfs", "source": "Learning/Start.md"}
    assert world.bob.get("/api/notes/find", params=ask).json() == []
    found = world.carl.get("/api/notes/find", params=ask).json()
    assert [(hit["path"], hit["link"]) for hit in found] == [("Homelab/Why ZFS.md", "Homelab/Why ZFS")]
    # The own space first.
    # "Why ZFS" is shorter, and length ranks among equals: the own space still comes first.
    note(world.anna, "Learning", "My old ZFS notes", "mine")
    found = world.carl.get("/api/notes/find", params=ask).json()
    assert [hit["path"] for hit in found] == ["Learning/My old ZFS notes.md", "Homelab/Why ZFS.md"]
    assert found[0]["link"] == "My old ZFS notes"


def test_search_finds_nothing_of_a_foreign_space(world: World) -> None:
    assert world.bob.get("/api/search", params={"q": "checksums"}).json() == []
    assert [hit["path"] for hit in world.carl.get("/api/search", params={"q": "checksums"}).json()] == [
        "Homelab/Why ZFS.md"
    ]


def test_the_local_graph_reaches_into_readable_spaces_only(world: World) -> None:
    def nodes(client: TestClient) -> set[str]:
        answer = client.get("/api/graph/local", params={"path": "Learning/Start.md", "depth": 2})
        assert answer.status_code == 200
        return {row[1] for row in answer.json()["nodes"]}

    assert nodes(world.carl) == {"Learning/Start.md", "Homelab/Why ZFS.md"}
    assert nodes(world.bob) == {"Learning/Start.md"}
    # anna reads both, but not dave's Diary, which links into Homelab as well.
    assert "Diary/Today.md" not in {
        row[1] for row in world.anna.get("/api/graph/local", params={"path": "Homelab/Why ZFS.md"}).json()["nodes"]
    }


def _tiles(client: TestClient, space: str) -> dict:
    """The tiles that hold the notes of the space, at their level."""
    overview = client.get("/api/graph/overview", params={"space": space}).json()
    assert overview["status"] == "ready"
    with SessionLocal() as db:
        rows = db.execute(
            select(GraphNode.level, GraphNode.x, GraphNode.y).join(File, File.id == GraphNode.file_id).where(
                GraphNode.cloud == "folders", File.path.like(f"{space}/%")
            )
        ).all()
    wanted = set()
    for level, x, y in rows:
        size = graphstore.TILE / 2**level
        wanted.add(f"{level}:{math.floor(x / size)}:{math.floor(y / size)}")
    answer = client.get("/api/graph/tiles", params={"space": space, "t": sorted(wanted)})
    assert answer.status_code == 200
    notes = {row[7] for tile in answer.json()["tiles"] for row in tile["notes"]}
    assert all(path.startswith(space + "/") for path in notes) and notes
    return answer.json()


def test_tiles_carry_links_into_another_space_only_for_its_readers(world: World) -> None:
    with SessionLocal() as db:
        ids = {path: file_id for file_id, path in db.execute(select(File.id, File.path))}
    start, why = ids["Learning/Start.md"], ids["Homelab/Why ZFS.md"]
    # A link only into Learning, none back: it comes along from the other space's side alone.
    note(world.anna, "Homelab", "Only back", "see [[Learning/Plain]]")
    with SessionLocal() as db:
        ids = {path: file_id for file_id, path in db.execute(select(File.id, File.path))}
    plain, back = ids["Learning/Plain.md"], ids["Homelab/Only back.md"]
    # The map of every space is there, as in the browser, which asks for every overview first.
    for space in ("Learning", "Homelab"):
        world.anna.get("/api/graph/overview", params={"space": space})
    world.dave.get("/api/graph/overview", params={"space": "Diary"})
    carl = _tiles(world.carl, "Learning")
    assert sorted([start, why]) in carl["links"]
    assert sorted([plain, back]) in carl["links"]
    assert why in [row[0] for row in carl["others"]]
    bob = _tiles(world.bob, "Learning")
    assert all(why not in pair for pair in bob["links"])
    assert why not in [row[0] for row in bob["others"]]
    # Nor the other way round: Homelab's tiles, asked by anna, say nothing of dave's Diary.
    anna = _tiles(world.anna, "Homelab")
    assert ids["Diary/Today.md"] not in [row[0] for row in anna["others"]]
    assert all(ids["Diary/Today.md"] not in pair for pair in anna["links"])


def test_bundles_between_spaces_only_between_readable_ones(world: World) -> None:
    for client in (world.carl, world.bob, world.anna):
        for space in ("Learning", "Homelab"):
            client.get("/api/graph/overview", params={"space": space})
    world.dave.get("/api/graph/overview", params={"space": "Diary"})
    carl = world.carl.get("/api/graph/across").json()["links"]
    assert carl and sum(count for _a, _b, count in carl) == 6  # five links there, one back
    assert world.bob.get("/api/graph/across").json() == {"links": []}
    assert sum(count for _a, _b, count in world.anna.get("/api/graph/across").json()["links"]) == 6
    # dave reads only his Diary: its link into Homelab is no bundle for him.
    assert world.dave.get("/api/graph/across").json() == {"links": []}
    # The overview of one space counts links inside it only.
    overview = world.carl.get("/api/graph/overview", params={"space": "Learning"}).json()
    assert overview["links"] == []


def test_bundles_between_spaces_follow_a_map_built_after_they_were_counted(world: World) -> None:
    # Asked before any map exists (the browser asks right after the overviews, but a map may be built later).
    assert world.carl.get("/api/graph/across").json() == {"links": []}
    for space in ("Learning", "Homelab"):
        world.carl.get("/api/graph/overview", params={"space": space})
    assert sum(count for _a, _b, count in world.carl.get("/api/graph/across").json()["links"]) == 6


def test_a_file_used_from_a_foreign_space_counts_as_unused_there(world: World, vault: Path) -> None:
    (vault / "Learning" / "chart.png").write_bytes(PNG + b"chart")
    index.scan()
    note(world.anna, "Homelab", "Uses chart", "![[Learning/chart.png]]")
    assert target("Homelab/Uses chart.md", "Learning/chart.png") == "Learning/chart.png"

    def uses(client: TestClient) -> int:
        items = client.get("/api/attachments", params={"space": "Learning"}).json()["items"]
        return next(item["uses"] for item in items if item["path"] == "Learning/chart.png")

    assert uses(world.carl) == 1
    assert uses(world.bob) == 0


def test_a_public_page_shows_links_into_another_space_as_words(world: World) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"shares_allowed": True})
    made = world.anna.post("/api/shares", json={"path": "Learning/Start.md"})
    assert made.status_code == 201, made.text
    token = made.json()["link"].rsplit("/", 1)[1]
    visitor = TestClient(app, base_url="http://testserver")
    page = visitor.get(f"/api/public/{token}/page").json()
    # Their own words stay, as plain text; nothing on the page leads anywhere.
    assert "See Homelab/Why ZFS and Homelab/Nothing." in page["content"]
    assert "[[" not in page["content"] and "](" not in page["content"]
    assert page["links"] == []
    with SessionLocal() as db:
        rack = db.scalar(select(File.id).where(File.path == "Homelab/rack.png"))
    assert visitor.get(f"/api/public/{token}/file/{rack}").status_code == 404


# --- Renaming: links follow everywhere, the count names only what the mover may read ------------------------------------


def test_renaming_rewrites_links_in_every_space_and_counts_only_readable_ones(world: World, vault: Path) -> None:
    moved = world.anna.post(
        "/api/move", json={"source": "Homelab/Why ZFS.md", "destination": "Homelab/Pools/Why ZFS pools.md"}
    )
    assert moved.status_code == 200, moved.text
    # Learning/Start (anna reads it) and Diary/Today (anna does not) are both rewritten; only one is counted.
    assert moved.json()["rewritten"] == 1
    start = (vault / "Learning" / "Start.md").read_text(encoding="utf-8")
    assert "[[Homelab/Why ZFS pools]]" in start
    assert "[md](../Homelab/Pools/Why%20ZFS%20pools.md)" in start
    assert "[abs](Homelab/Pools/Why%20ZFS%20pools.md)" in start  # from the top, as written
    assert "[root](/Homelab/Pools/Why%20ZFS%20pools.md)" in start
    assert "[[Homelab/Nothing]]" in start and "[gone](../Homelab/Gone.md)" in start
    # The space's name in the letters dave wrote it in.
    assert (vault / "Diary" / "Today.md").read_text(encoding="utf-8") == "read [[homelab/Why ZFS pools]] again\n"
    assert target("Diary/Today.md", "homelab/Why ZFS pools") == "Homelab/Pools/Why ZFS pools.md"
    # Its own link back into Learning stays as it was: it still leads there from the new folder.
    assert "[[Learning/Start]]" in (vault / "Homelab" / "Pools" / "Why ZFS pools.md").read_text(encoding="utf-8")
    with SessionLocal() as db:
        diary = db.scalar(select(File.id).where(File.path == "Diary/Today.md"))
        newest = db.scalar(select(Version).where(Version.file_id == diary).order_by(Version.id.desc()).limit(1))
    assert (newest.source, newest.author) == (index.RENAME, "anna")
    # dave sees who renamed, in his history.
    history = world.dave.get("/api/versions", params={"path": "Diary/Today.md"}).json()
    assert (history[0]["source"], history[0]["author"]) == ("rename", "anna")


def test_a_rename_keeps_the_name_alone_where_it_still_leads_there(world: World, vault: Path) -> None:
    moved = world.anna.post("/api/move", json={"source": "Homelab/Why ZFS.md", "destination": "Homelab/Deep/Why ZFS.md"})
    assert moved.status_code == 200
    # Only the folder changed: [[Homelab/Why ZFS]] still finds the one note of that name.
    assert (vault / "Diary" / "Today.md").read_text(encoding="utf-8") == "read [[homelab/Why ZFS]] again\n"
    assert moved.json()["rewritten"] == 1  # the Markdown paths in Learning/Start
    assert "[md](../Homelab/Deep/Why%20ZFS.md)" in (vault / "Learning" / "Start.md").read_text(encoding="utf-8")


def test_a_rename_while_the_linking_note_is_edited_ends_in_a_conflict_copy(world: World, vault: Path) -> None:
    before = world.dave.get("/api/note", params={"path": "Diary/Today.md"}).json()
    assert world.dave.post("/api/locks", json={"path": "Diary/Today.md"}).status_code == 200
    assert world.anna.post(
        "/api/move", json={"source": "Homelab/Why ZFS.md", "destination": "Homelab/ZFS.md"}
    ).status_code == 200
    saved = world.dave.put(
        "/api/note", json={"path": "Diary/Today.md", "content": "my own words [[homelab/Why ZFS]]",
                           "base_hash": before["hash"]}
    ).json()
    assert saved["saved"] is False and saved["conflict"].startswith("Diary/Today (conflict ")
    assert (vault / "Diary" / "Today.md").read_text(encoding="utf-8") == "read [[homelab/ZFS]] again\n"


def test_a_rename_in_a_space_the_reader_cannot_see_leaves_their_view_as_missing(world: World) -> None:
    # bob's view of the link before and after: nothing to see either way, and no error.
    world.anna.post("/api/move", json={"source": "Homelab/Why ZFS.md", "destination": "Homelab/ZFS.md"})
    links = world.bob.get("/api/links", params={"path": "Learning/Start.md"}).json()["outgoing"]
    assert {item["target"]: item["path"] for item in links}["Homelab/ZFS"] is None


def test_moving_the_linking_note_keeps_its_links_into_another_space(world: World, vault: Path) -> None:
    (vault / "Learning" / "Deep").mkdir()
    moved = world.anna.post("/api/move", json={"source": "Learning/Start.md", "destination": "Learning/Deep/Start.md"})
    assert moved.status_code == 200, moved.text
    start = (vault / "Learning" / "Deep" / "Start.md").read_text(encoding="utf-8")
    # A wiki link and a path from the top name the space: they still lead there. A relative path climbs one more.
    assert "[[Homelab/Why ZFS]]" in start and "[abs](Homelab/Why%20ZFS.md)" in start
    # Still right from the new place: left as the author wrote it, letters and all.
    assert "[low](homelab/Why%20ZFS.md)" in start and "[root](/Homelab/Why%20ZFS.md)" in start
    assert "[md](../../Homelab/Why%20ZFS.md)" in start
    assert target("Learning/Deep/Start.md", "../../Homelab/Why ZFS.md") == "Homelab/Why ZFS.md"
    # And the link back from Homelab follows the moved note.
    assert "[[Learning/Start]]" in (vault / "Homelab" / "Why ZFS.md").read_text(encoding="utf-8")
    assert target("Homelab/Why ZFS.md", "Learning/Start") == "Learning/Deep/Start.md"


def test_resolving_every_link_of_a_space_looks_at_links_from_other_spaces_too(world: World) -> None:
    with SessionLocal() as db:
        db.execute(update(Link).where(Link.target.like("Homelab/%")).values(target_id=None, target_space_id=None))
        homelab = db.scalar(select(File.space_id).where(File.path == "Homelab/Why ZFS.md"))
        index.reresolve(db, homelab, None)
        db.commit()
    assert target("Learning/Start.md", "Homelab/Why ZFS") == "Homelab/Why ZFS.md"
    assert target("Diary/Today.md", "homelab/Why ZFS") == "Homelab/Why ZFS.md"


def test_a_wrong_target_space_is_put_right_when_the_link_is_looked_at_again(world: World) -> None:
    with SessionLocal() as db:
        db.execute(update(Link).where(Link.target == "Homelab/Why ZFS").values(target_space_id=None))
        homelab = db.scalar(select(File.space_id).where(File.path == "Homelab/Why ZFS.md"))
        index.reresolve(db, homelab, ["why zfs"])
        db.commit()
        spaces = set(db.scalars(select(Link.target_space_id).where(Link.target == "Homelab/Why ZFS")))
    assert spaces == {homelab}


def test_names_of_another_space_loaded_whole_are_loaded_again_after_a_change(world: World, vault: Path) -> None:
    # A big change loads the names of other spaces whole; a file that appears there meanwhile must not be missed.
    with SessionLocal() as db:
        learning = db.scalar(select(File.space_id).where(File.path == "Learning/Start.md"))
        names = index.Names(db, learning, preload=True)
        assert index.resolve("wiki", "Homelab/Later", "Learning/Start.md", names) is None
        (vault / "Homelab" / "Later.md").write_text("later", encoding="utf-8")
        index.scan()
        assert index.resolve("wiki", "Homelab/Later", "Learning/Start.md", names) is not None


def test_a_note_gone_for_good_leaves_no_space_behind_on_links_to_it(world: World) -> None:
    assert world.anna.delete("/api/files", params={"path": "Homelab/Why ZFS.md"}).status_code == 200
    entry = next(e for e in world.anna.get("/api/trash").json() if e["path"] == "Homelab/Why ZFS.md")
    assert world.anna.delete(f"/api/trash/{entry['id']}").status_code == 200
    with SessionLocal() as db:
        left = db.execute(select(Link.target_id, Link.target_space_id).where(Link.target == "Homelab/Why ZFS")).all()
    assert left and all(row == (None, None) for row in left)

