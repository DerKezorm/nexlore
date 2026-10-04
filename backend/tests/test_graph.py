"""The graph: layout, the stored map, tiles, small changes without movement, tags, topics, the neighbourhood."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import MEMBER, GraphGroup, GraphNode, GraphState, Setting, Space, Tag
from app.services import graphlayout as gl
from app.services import graphstore, index, topics

from .conftest import join, make_account, sign_in


def put(root: Path, rel: str, content: str) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode())


def space_id(name: str) -> int:
    with SessionLocal() as db:
        found = db.scalar(select(Space.id).where(Space.folder == name))
    assert found is not None
    return found


def nodes(cloud: str = "folders") -> dict[int, GraphNode]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(GraphNode).where(GraphNode.cloud == cloud)))
        for row in rows:
            db.expunge(row)
    return {row.file_id: row for row in rows}


def groups(cloud: str = "folders") -> dict[str, GraphGroup]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(GraphGroup).where(GraphGroup.cloud == cloud)))
        for row in rows:
            db.expunge(row)
    return {row.key: row for row in rows}


def file_id(path: str) -> int:
    from app.models import File

    with SessionLocal() as db:
        found = db.scalar(select(File.id).where(File.path == path, File.deleted_at.is_(None)))
    assert found is not None, path
    return found


# --- Layout, pure ----------------------------------------------------------------------------------------------------


def flat(count: int, links: list[tuple[int, int]]) -> gl.Group:
    root = gl.Group("space", "space", "S")
    folder = gl.Group("f:Big", "folder", "Big", notes=list(range(count)))
    root.children.append(folder)
    return root


def inside_and_apart(result: gl.Result, root: gl.Group) -> None:
    """Every item lies inside its parent's circle, and no two items of a group overlap."""

    def check(group: gl.Group) -> None:
        parent = result.groups[group.key]
        items = [(result.groups[c.key].x, result.groups[c.key].y, result.groups[c.key].r) for c in group.children]
        items += [(result.notes[n].x, result.notes[n].y, result.notes[n].r) for n in group.notes]
        for x, y, r in items:
            assert math.hypot(x - parent.x, y - parent.y) + r <= parent.r + 1e-6
        for i, (x1, y1, r1) in enumerate(items):
            for x2, y2, r2 in items[i + 1 :]:
                assert math.hypot(x1 - x2, y1 - y2) >= r1 + r2 - 1e-6
        for child in group.children:
            check(child)

    check(root)


def test_a_crowded_folder_is_split_into_buckets_by_its_links() -> None:
    # Two tight circles of 200 notes each, and 60 notes without a link inside the folder.
    links = [(a, a + 1) for a in range(199)] + [(a, a + 1) for a in range(200, 399)]
    links += [(a, 0) for a in range(1, 40)]
    root = flat(460, links)
    titles = {n: f"Note {n:03d}" for n in range(460)}
    degree: dict[int, int] = {}
    for a, b in links:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
    gl.split(root, links, titles, degree)
    folder = root.children[0]
    assert folder.notes == []
    kinds = sorted(child.kind for child in folder.children)
    assert "unlinked" in kinds and kinds.count("bucket") >= 2
    lonely = next(child for child in folder.children if child.kind == "unlinked")
    assert sorted(lonely.notes) == list(range(400, 460))
    # No bucket mixes the two circles, and the first is named after its most linked note.
    for child in folder.children:
        if child.kind == "bucket":
            assert all(n < 200 for n in child.notes) or all(200 <= n < 400 for n in child.notes)
    first = next(child for child in folder.children if 0 in child.notes)
    assert first.anchor == 0 and first.name == "Note 000"
    assert all(len(child.notes) <= gl.MAX_ITEMS for child in folder.children)


def test_a_small_folder_is_not_split() -> None:
    root = flat(gl.MAX_ITEMS, [])
    gl.split(root, [], {}, {})
    assert len(root.children[0].notes) == gl.MAX_ITEMS and root.children[0].children == []


def test_thousands_of_subgroups_get_ranges_by_name() -> None:
    root = gl.Group("space", "space", "S")
    for n in range(700):
        root.children.append(gl.Group(f"t:tag{n:03d}", "tag", f"tag{n:03d}", notes=[n]))
    gl.split(root, [], {}, {})
    assert len(root.children) <= gl.MAX_ITEMS
    assert all(child.kind == "range" for child in root.children)
    assert all(len(child.children) <= gl.MAX_ITEMS // 2 for child in root.children)
    # In order of the names, and each range named by its first and last.
    names = [grand.name for child in root.children for grand in child.children]
    assert names == sorted(names) and len(names) == 700
    assert root.children[0].name == "ta–ta"
    result = gl.layout(root, [], {}, seed="s")
    inside_and_apart(result, root)


def test_layout_is_nested_without_overlaps_and_the_same_each_time() -> None:
    root = gl.Group("space", "space", "S")
    for name, count in (("A", 30), ("B", 5), ("C", 120)):
        root.children.append(gl.Group(f"f:{name}", "folder", name, notes=list(range(len(root.children) * 1000,
                                                                                     len(root.children) * 1000 + count))))
    root.children[2].children.append(gl.Group("f:C/D", "folder", "D", notes=[5000, 5001, 5002]))
    links = [(0, 1), (1, 2), (1000, 2000), (2000, 5000)]
    degree = {0: 1, 1: 2, 2: 1, 1000: 1, 2000: 2, 5000: 1}
    first = gl.layout(root, links, degree, seed="s")
    second = gl.layout(root, links, degree, seed="s")
    inside_and_apart(first, root)
    assert first.notes[1].r > first.notes[5].r  # linked notes are bigger dots
    assert {k: (p.x, p.y) for k, p in first.notes.items()} == {k: (p.x, p.y) for k, p in second.notes.items()}


def test_many_groups_all_linked_to_each_other_stay_packed() -> None:
    # Like tools/lastprobe.py: dozens of folders side by side, every one linked to every other thousands of times.
    # Every folder got the full pull of each of its links at once, and the map swung itself to 10^21.
    import random

    rng = random.Random(1)
    root = gl.Group("space", "space", "S")
    count = 0
    for a in range(40):
        leaf = gl.Group(f"f:{a}/x", "folder", "x", notes=list(range(count, count + 30)))
        root.children.append(gl.Group(f"f:{a}", "folder", str(a), children=[leaf]))
        count += 30
    links = [(i, rng.randrange(count)) for i in range(count) for _ in range(8)]
    degree: dict[int, int] = {}
    for a, b in links:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
    result = gl.layout(root, links, degree, seed="s")
    area = math.sqrt(sum(result.groups[c.key].r ** 2 for c in root.children))
    assert result.groups["space"].r < 2.2 * area
    inside_and_apart(result, root)


def test_a_new_layout_starts_where_things_were() -> None:
    root = gl.Group("space", "space", "S", children=[gl.Group("f:A", "folder", "A", notes=list(range(40)))])
    first = gl.layout(root, [], {}, seed="s")
    previous = {f"g:{k}": (p.rx, p.ry) for k, p in first.groups.items()}
    previous.update({f"n:{k}": (p.rx, p.ry) for k, p in first.notes.items()})
    # A different seed would put everything elsewhere; with the old positions nothing moves.
    again = gl.layout(root, [], {}, previous, seed="other")
    moved = max(math.hypot(first.notes[n].rx - again.notes[n].rx, first.notes[n].ry - again.notes[n].ry)
                for n in range(40))
    assert moved < 1e-6


def test_a_free_spot_is_inside_and_touches_nothing() -> None:
    taken = [(0.0, 0.0, 30.0), (60.0, 0.0, 25.0)]
    x, y = gl.free_spot((0.0, 0.0), 200.0, taken, 20.0, (60.0, 40.0), 1)
    assert math.hypot(x, y) + 20 <= 200
    for ox, oy, r in taken:
        assert math.hypot(x - ox, y - oy) >= r + 20
    # Near what was asked for, not just anywhere.
    assert math.hypot(x - 60, y - 40) < 80


# --- The stored map --------------------------------------------------------------------------------------------------


@pytest.fixture
def garden(vault: Path, account: object) -> Path:
    # Front matter first, and not in the order of the alphabet: the first tag is "summer".
    put(vault, "Garden/Beds/Tomatoes.md", "---\ntags: [summer, plants]\n---\nTomatoes like [[Basil]]. #veg")
    put(vault, "Garden/Beds/Basil.md", "Basil next to [[Tomatoes]] #herbs/kitchen")
    put(vault, "Garden/Tools/Spade.md", "A spade for the [[Tomatoes]].")
    put(vault, "Garden/Plan.md", "The plan: [[Spade]] and [[Basil]].")
    put(vault, "Garden/Daily/2026-09-27.md", "watered")
    index.scan()
    return vault


def test_the_overview_has_every_group_with_place_counts_and_links(client: TestClient, garden: Path) -> None:
    answer = client.get("/api/graph/overview", params={"space": "Garden"}).json()
    assert answer["status"] == "ready" and answer["open_from"] == graphstore.OPEN_FROM
    by_name = {row[3]: row for row in answer["groups"]}
    assert set(by_name) == {"Garden", "Beds", "Tools", "Daily"}
    space_row = by_name["Garden"]
    assert space_row[2] == "space" and space_row[1] is None and space_row[4] == 5 and space_row[5] == 1
    assert by_name["Beds"][4] == 2 and by_name["Daily"][5] == 1
    # Children lie inside their parent.
    for row in answer["groups"]:
        if row[1] is not None:
            parent = next(p for p in answer["groups"] if p[0] == row[1])
            assert math.hypot(row[6] - parent[6], row[7] - parent[7]) + row[8] <= parent[8] + 0.5
    counts = {(a, b): c for a, b, c in answer["links"]}
    beds, tools, space_group = by_name["Beds"][0], by_name["Tools"][0], by_name["Garden"][0]
    assert counts[tuple(sorted((beds, tools)))] == 1  # Spade -> Tomatoes
    assert counts[tuple(sorted((beds, space_group)))] == 1 and counts[tuple(sorted((tools, space_group)))] == 1
    # The same colour for a folder as the interface works out (FNV-1a of its key; palette.test.ts has the same 5).
    assert by_name["Beds"][9] == 5 and by_name["Garden"][9] == -1


def test_tiles_bring_the_notes_of_a_level_and_square_with_their_links(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    stored = nodes()
    tomatoes = stored[file_id("Garden/Beds/Tomatoes.md")]
    size = graphstore.TILE / 2**tomatoes.level
    tx, ty = math.floor(tomatoes.x / size), math.floor(tomatoes.y / size)
    answer = client.get(
        "/api/graph/tiles", params={"space": "Garden", "t": [f"{tomatoes.level}:{tx}:{ty}"]}
    ).json()
    found = {row[0]: row for tile in answer["tiles"] for row in tile["notes"]}
    assert tomatoes.file_id in found
    row = found[tomatoes.file_id]
    assert row[6] == "Tomatoes" and row[7] == "Garden/Beds/Tomatoes.md" and row[1] == tomatoes.group_id
    spade = file_id("Garden/Tools/Spade.md")
    assert sorted([spade, tomatoes.file_id]) in answer["links"]
    # A tile at another level has nothing of it.
    other = client.get(
        "/api/graph/tiles", params={"space": "Garden", "t": [f"{tomatoes.level + 3}:{tx}:{ty}"]}
    ).json()
    assert all(tomatoes.file_id != r[0] for tile in other["tiles"] for r in tile["notes"])
    # Nor a tile of the right level somewhere else, on either side.
    for dx, dy in ((5, 0), (-5, 0), (0, 5), (0, -5)):
        far = client.get(
            "/api/graph/tiles", params={"space": "Garden", "t": [f"{tomatoes.level}:{tx + dx}:{ty + dy}"]}
        ).json()
        assert all(tomatoes.file_id != r[0] for tile in far["tiles"] for r in tile["notes"]), (dx, dy)
    assert client.get("/api/graph/tiles", params={"space": "Garden", "t": ["1:x:2"]}).status_code == 422
    assert client.get("/api/graph/tiles", params={"space": "Garden", "t": ["1:2"]}).status_code == 422


def test_big_answers_come_compressed_when_the_browser_takes_gzip(client: TestClient, garden: Path) -> None:
    for n in range(40):
        put(garden, f"Garden/Folder {n}/Note {n}.md", f"note {n} [[Basil]]")
    index.scan()
    raw = client.get("/api/graph/overview", params={"space": "Garden"}, headers={"Accept-Encoding": "identity"})
    packed = client.get("/api/graph/overview", params={"space": "Garden"}, headers={"Accept-Encoding": "gzip"})
    assert raw.headers.get("content-encoding") is None and packed.headers["content-encoding"] == "gzip"
    assert packed.json() == raw.json() and packed.headers["vary"] == "Accept-Encoding"
    assert int(packed.headers["content-length"]) < len(raw.content)


def test_levels_follow_the_size_of_the_home_group(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    stored = nodes()
    by_id = {g.id: g for g in groups().values()}
    for node in stored.values():
        home = by_id[node.group_id]
        assert node.level == math.floor(math.log2(graphstore.OPEN_FROM / home.r))
        assert 2**node.level <= graphstore.OPEN_FROM / home.r < 2 ** (node.level + 1)


def test_a_new_note_takes_a_free_spot_and_nothing_else_moves(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    before = nodes()
    groups_before = groups()
    put(garden, "Garden/Beds/Parsley.md", "Parsley near [[Basil]]")
    index.scan()
    answer = client.get("/api/graph/overview", params={"space": "Garden"}).json()
    after = nodes()
    assert set(after) - set(before) == {file_id("Garden/Beds/Parsley.md")}
    for key, row in before.items():
        assert (after[key].x, after[key].y) == (row.x, row.y)
    assert {k: (g.x, g.y, g.r) for k, g in groups().items()} == {k: (g.x, g.y, g.r) for k, g in groups_before.items()}
    new = after[file_id("Garden/Beds/Parsley.md")]
    beds = groups()["f:Beds"]
    assert new.group_id == beds.id
    assert math.hypot(new.x - beds.x, new.y - beds.y) + new.r <= beds.r
    for other in after.values():
        if other.file_id != new.file_id and other.group_id == beds.id:
            assert math.hypot(new.x - other.x, new.y - other.y) >= new.r + other.r
    assert {row[3]: row[4] for row in answer["groups"]}["Beds"] == 3
    with SessionLocal() as db:
        state = db.get(GraphState, (space_id("Garden"), "folders"))
        assert state is not None and state.changed_at is not None and state.version == 2


def test_a_note_in_a_new_folder_gets_a_new_group(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    put(garden, "Garden/Shed/Old/Rake.md", "a rake")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Garden"})
    made = groups()
    assert {"f:Shed", "f:Shed/Old"} <= set(made)
    shed, old, space = made["f:Shed"], made["f:Shed/Old"], made["space"]
    assert old.parent_id == shed.id and shed.parent_id == space.id and old.total == 1 and space.total == 6
    assert math.hypot(shed.x - space.x, shed.y - space.y) + shed.r <= space.r
    assert nodes()[file_id("Garden/Shed/Old/Rake.md")].group_id == old.id


def test_a_moved_note_changes_group_and_a_deleted_one_goes_with_its_empty_group(
    client: TestClient, garden: Path
) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    spade = file_id("Garden/Tools/Spade.md")
    assert client.post("/api/move", json={"source": "Garden/Tools/Spade.md", "destination": "Garden/Beds/Spade.md"}
                       ).status_code == 200
    client.get("/api/graph/overview", params={"space": "Garden"})
    assert nodes()[spade].group_id == groups()["f:Beds"].id
    assert "f:Tools" not in groups()
    assert client.delete("/api/files", params={"path": "Garden/Daily/2026-09-27.md"}).status_code == 200
    client.get("/api/graph/overview", params={"space": "Garden"})
    assert "f:Daily" not in groups()
    assert groups()["space"].total == 4 and groups()["space"].daily == 0


def test_much_at_once_lays_the_map_out_anew(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    with SessionLocal() as db:
        built = db.get(GraphState, (space_id("Garden"), "folders")).built_at  # type: ignore[union-attr]
    for n in range(graphstore.RELAYOUT_MIN + 1):
        put(garden, f"Garden/Import/Note {n}.md", f"note {n}")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Garden"})
    with SessionLocal() as db:
        state = db.get(GraphState, (space_id("Garden"), "folders"))
        assert state is not None and state.built_at is not None and built is not None and state.built_at > built
        assert state.changed_at is None
    assert groups()["f:Import"].total == graphstore.RELAYOUT_MIN + 1


def test_the_tag_cloud_puts_a_note_under_its_first_tag(client: TestClient, garden: Path) -> None:
    answer = client.get("/api/graph/overview", params={"space": "Garden", "cloud": "tags"}).json()
    names = {row[3] for row in answer["groups"] if row[2] == "tag"}
    assert names == {"summer", "herbs", "herbs/kitchen"}
    placed = nodes("tags")
    by_id = {g.id: g for g in groups("tags").values()}
    # Front matter first: Tomatoes has summer, plants and veg, and stands under summer.
    assert by_id[placed[file_id("Garden/Beds/Tomatoes.md")].group_id].key == "t:summer"
    assert by_id[placed[file_id("Garden/Beds/Basil.md")].group_id].key == "t:herbs/kitchen"
    assert by_id[placed[file_id("Garden/Plan.md")].group_id].key == "untagged"
    assert by_id[by_id[placed[file_id("Garden/Beds/Basil.md")].group_id].parent_id].key == "t:herbs"  # type: ignore[index]


def test_changing_the_first_tag_moves_the_note_in_the_tag_cloud(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden", "cloud": "tags"})
    put(garden, "Garden/Plan.md", "The plan #plants")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Garden", "cloud": "tags"})
    by_id = {g.id: g for g in groups("tags").values()}
    assert by_id[nodes("tags")[file_id("Garden/Plan.md")].group_id].key == "t:plants"
    # Spade and the daily note have no tag: two left there, one fewer than before.
    assert groups("tags")["untagged"].total == 2


def test_tag_order_is_read_again_once_for_old_databases(client: TestClient, garden: Path) -> None:
    tomatoes = file_id("Garden/Beds/Tomatoes.md")
    with SessionLocal() as db:
        for tag in db.scalars(select(Tag).where(Tag.file_id == tomatoes)):
            tag.pos = 0
        db.commit()
    assert graphstore.fix_tag_order() == 1
    with SessionLocal() as db:
        order = [t.tag_key for t in db.scalars(select(Tag).where(Tag.file_id == tomatoes).order_by(Tag.pos))]
        assert order == ["summer", "plants", "veg"]
        assert db.get(Setting, graphstore.TAG_ORDER_DONE) is not None
    assert graphstore.fix_tag_order() == 0


def test_locate_and_the_neighbourhood_of_a_note(client: TestClient, garden: Path) -> None:
    located = client.get("/api/graph/locate", params={"path": "Garden/Beds/Basil.md"}).json()
    basil = nodes()[file_id("Garden/Beds/Basil.md")]
    assert (located["x"], located["y"], located["group"]) == (basil.x, basil.y, basil.group_id)
    near = client.get("/api/graph/local", params={"path": "Garden/Beds/Basil.md"}).json()
    depth = {row[1]: row[3] for row in near["nodes"]}
    assert depth == {"Garden/Beds/Basil.md": 0, "Garden/Beds/Tomatoes.md": 1, "Garden/Plan.md": 1}
    wider = client.get("/api/graph/local", params={"path": "Garden/Beds/Basil.md", "depth": 2}).json()
    assert {row[1]: row[3] for row in wider["nodes"]}["Garden/Tools/Spade.md"] == 2
    ids = {row[1]: row[0] for row in wider["nodes"]}
    assert sorted([ids["Garden/Tools/Spade.md"], ids["Garden/Beds/Tomatoes.md"]]) in wider["links"]
    limited = client.get("/api/graph/local", params={"path": "Garden/Beds/Basil.md", "depth": 3, "limit": 2}).json()
    assert len(limited["nodes"]) == 2
    assert client.get("/api/graph/local", params={"path": "Garden/Nope.md"}).status_code == 404
    assert client.get("/api/graph/local", params={"path": "Garden/Beds/Basil.md", "depth": 4}).status_code == 422


def test_changes_are_noticed_on_the_connection() -> None:
    for statement in ('INSERT INTO files (path) VALUES (?)', "UPDATE files SET path=?", "DELETE FROM links WHERE",
                      'INSERT INTO "tags" (file_id)', "INSERT OR REPLACE INTO links"):
        assert graphstore._WRITES.match(statement), statement
    for statement in ("INSERT INTO graph_nodes", "UPDATE graph_groups SET", "SELECT * FROM files",
                      "INSERT INTO filesystem", "DELETE FROM tags_other"):
        assert not graphstore._WRITES.match(statement), statement


def test_the_night_lays_out_what_changed(client: TestClient, garden: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Garden"})
    client.get("/api/graph/overview", params={"space": "Garden", "cloud": "tags"})
    assert graphstore.nightly() == []
    put(garden, "Garden/Beds/Chives.md", "chives")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Garden"})
    assert graphstore.nightly() == [("build", space_id("Garden"), "folders")]


# --- Topics ----------------------------------------------------------------------------------------------------------


WORDS = {
    "kitchen": "recipe dough oven bread flour yeast bake",
    "server": "server docker network backup raid container",
    "garden": "garden soil compost seed frost water",
}


@pytest.fixture
def library(vault: Path, account: object) -> Path:
    for theme, words in WORDS.items():
        for n in range(8):
            put(vault, f"Lib/{theme} {n}.md", f"# {theme} {n}\n\n{words} {words.split()[n % 6]} note {n}")
    put(vault, "Lib/empty.md", "123 456")
    index.scan()
    return vault


def test_topics_group_notes_by_what_they_are_about_and_are_named_by_words(
    client: TestClient, library: Path
) -> None:
    answer = client.get("/api/graph/overview", params={"space": "Lib", "cloud": "topics"}).json()
    by_id = {row[0]: row for row in answer["groups"]}
    placed = nodes("topics")
    for theme, words in WORDS.items():
        homes = {placed[file_id(f"Lib/{theme} {n}.md")].group_id for n in range(8)}
        tops = set()
        for home in homes:
            row = by_id[home]
            while by_id[row[1]][2] != "space":
                row = by_id[row[1]]
            tops.add(row[0])
        assert len(tops) == 1, theme
        name = by_id[tops.pop()][3]
        assert len(name.split(" · ")) == 3 and set(name.split(" · ")) <= set(words.split()) | {theme}
    unsorted = by_id[placed[file_id("Lib/empty.md")].group_id]
    assert unsorted[2] == "unsorted" and unsorted[9] == -1


def test_topics_are_the_same_when_worked_out_again(client: TestClient, library: Path) -> None:
    client.get("/api/graph/overview", params={"space": "Lib", "cloud": "topics"})
    first = {g.key: (g.name, g.color) for g in groups("topics").values()}
    placed = {n.file_id: n.placed for n in nodes("topics").values()}
    assert client.post("/api/graph/topics", params={"space": "Lib"}).status_code == 202
    assert {g.key: (g.name, g.color) for g in groups("topics").values()} == first
    assert {n.file_id: n.placed for n in nodes("topics").values()} == placed


def test_topic_keys_follow_the_notes_they_share(library: Path, account: object) -> None:
    graphstore.build(space_id("Lib"), "topics")
    placed = {n.file_id: n.placed for n in nodes("topics").values()}
    # The same notes under swapped keys before: the new topics take the keys the notes had.
    keys = sorted({k for k in placed.values() if k.startswith("k:")})
    swap = {keys[0]: keys[1], keys[1]: keys[0]}
    previous = {n: swap.get(k, k) for n, k in placed.items()}
    with SessionLocal() as db:
        notes = graphstore._load_notes(db, space_id("Lib"), with_tags=False)
        links = graphstore._load_links(db, space_id("Lib"), set(notes.ids))
        again = topics.compute(db, space_id("Lib"), notes, links, previous)
    assert {n: k for n, k in again.assignment.items()} == {n: k for n, k in previous.items() if k.startswith("k:")}


def test_only_managers_ask_for_topics_again(client: TestClient, library: Path) -> None:
    reader = make_account("reader", MEMBER)
    other = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-reader00"})
    sign_in(other, reader)
    join(client, "Lib", "reader", "read")
    assert other.get("/api/graph/overview", params={"space": "Lib", "cloud": "topics"}).json()["manage"] is False
    assert other.post("/api/graph/topics", params={"space": "Lib"}).status_code == 403
    assert client.get("/api/graph/overview", params={"space": "Lib"}).json()["manage"] is True


# --- Rights ----------------------------------------------------------------------------------------------------------


def test_a_foreign_space_shows_nothing_in_the_graph(client: TestClient, garden: Path) -> None:
    anna_row = make_account("anna", MEMBER)
    anna = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-anna0000"})
    sign_in(anna, anna_row)
    for url, params in [
        ("/api/graph/overview", {"space": "Garden"}),
        ("/api/graph/overview", {"space": "Garden", "cloud": "topics"}),
        ("/api/graph/tiles", {"space": "Garden", "t": ["0:0:0"]}),
        ("/api/graph/locate", {"path": "Garden/Beds/Basil.md"}),
        ("/api/graph/local", {"path": "Garden/Beds/Basil.md"}),
    ]:
        foreign = anna.get(url, params=params)
        missing = anna.get(url, params={k: (v.replace("Garden", "Nowhere") if isinstance(v, str) else v)
                                        for k, v in params.items()})
        assert foreign.status_code == missing.status_code == 404, url
        assert foreign.json() == missing.json()
        assert "Basil" not in foreign.text and "Beds" not in foreign.text
    assert anna.post("/api/graph/topics", params={"space": "Garden"}).status_code == 404
    assert anna.get("/api/graph/overview", params={"space": "garden"}).status_code == 404
    assert anna.get("/api/graph/overview", params={"space": "Garden/Beds"}).status_code == 404


# --- What the interface asks instead of loading every note --------------------------------------------------------


def test_notes_are_found_by_title_and_name_starting_ones_first(client: TestClient, garden: Path) -> None:
    put(garden, "Garden/Beds/Sweet basil.md", "---\ntitle: Sweet Basil\n---\nsweet")
    put(garden, "Garden/100% sure_thing.md", "odd name")
    index.scan()
    found = [hit["path"] for hit in client.get("/api/notes/find", params={"q": "basil"}).json()]
    assert found == ["Garden/Beds/Basil.md", "Garden/Beds/Sweet basil.md"]
    assert [h["path"] for h in client.get("/api/notes/find", params={"q": "BAS", "limit": 1}).json()] == [
        "Garden/Beds/Basil.md"
    ]
    # % and _ are letters here, not wildcards.
    assert [h["path"] for h in client.get("/api/notes/find", params={"q": "0% s"}).json()] == [
        "Garden/100% sure_thing.md"
    ]
    assert client.get("/api/notes/find", params={"q": "e_t"}).json() == [
        {"path": "Garden/100% sure_thing.md", "title": "100% sure_thing", "link": None, "alias": None}
    ]
    assert client.get("/api/notes/find", params={"q": "_"}).json()[0]["path"] == "Garden/100% sure_thing.md"
    assert len(client.get("/api/notes/find", params={"q": "%"}).json()) == 1
    assert len(client.get("/api/notes/find").json()) == 7
    assert client.get("/api/notes/find", params={"q": "basil", "space": "Nowhere"}).json() == []


def test_notes_are_found_by_their_aliases_after_title_and_name(client: TestClient, garden: Path) -> None:
    put(garden, "Garden/Herbs.md", "---\naliases: [Kräuter, Würzpflanzen]\n---\nherbs")
    put(garden, "Garden/Old.md", "---\nalias: Greens\n---\nold style")
    put(garden, "Garden/Odd.md", "---\naliases: 4711\n---\na number")
    put(garden, "Garden/Nested.md", "---\naliases: [[Kräuter]]\n---\nnot a name")
    put(garden, "Garden/Kräutergarten.md", "the title itself")
    index.scan()

    def find(q: str) -> list[tuple[str, str | None]]:
        return [(hit["path"], hit["alias"]) for hit in client.get("/api/notes/find", params={"q": q}).json()]

    # The title beats an alias that fits as well; case and umlauts fold like names.
    assert find("KRÄUTER") == [("Garden/Kräutergarten.md", None), ("Garden/Herbs.md", "Kräuter")]
    assert find("würz") == [("Garden/Herbs.md", "Würzpflanzen")]
    assert find("pflanz") == [("Garden/Herbs.md", "Würzpflanzen")]
    assert find("greens") == [("Garden/Old.md", "Greens")]
    assert find("4711") == [("Garden/Odd.md", "4711")]


def test_folders_are_found_by_their_name_starting_ones_and_shallow_ones_first(client: TestClient, garden: Path) -> None:
    put(garden, "Garden/Old tools/Rake.md", "rake")
    put(garden, "Garden/Shed/Tools/Hoe.png", "not a note, still a file in a folder")
    put(garden, "Garden/Shed/Überdachung/Deep/Roof.md", "a folder only through the one below it")
    put(garden, "Garden/Shed/100%_sure/Note.md", "odd name")
    put(garden, "Garden/Gone/Last.md", "in the bin soon")
    index.scan()
    assert client.delete("/api/files", params={"path": "Garden/Gone/Last.md"}).status_code == 200

    def find(q: str = "", **extra: object) -> list[str]:
        answer = client.get("/api/folders/find", params={"q": q, **extra})
        assert answer.status_code == 200, answer.text
        return [hit["path"] for hit in answer.json()]

    # Starts with it before contains it, then the shallower; a note's name is no folder.
    assert find("tools") == ["Garden/Tools", "Garden/Shed/Tools", "Garden/Old tools"]
    assert find("/TOO", limit=1) == ["Garden/Tools"]
    assert find("überd") == ["Garden/Shed/Überdachung"]
    assert find("deep") == ["Garden/Shed/Überdachung/Deep"]
    assert find("rake") == []
    # A folder whose files are all in the bin is gone from here too.
    assert find("gone") == []
    assert find("garden") == ["Garden"]
    # % and _ are letters, as in the notes' search.
    assert find("0%_") == ["Garden/Shed/100%_sure"]
    # Nothing typed: the spaces.
    assert find() == ["Garden"]
    assert client.get("/api/folders/find", params={"q": "tools"}).json()[0] == {"path": "Garden/Tools", "name": "Tools"}


def test_many_links_are_resolved_at_once(client: TestClient, garden: Path) -> None:
    answer = client.get(
        "/api/resolve/many",
        params={"source": "Garden/Plan.md", "target": ["Basil", "Beds/Tomatoes", "Missing", "Spade#Part", "#Top"]},
    ).json()
    assert answer["found"] == {
        "Basil": "Garden/Beds/Basil.md", "Beds/Tomatoes": "Garden/Beds/Tomatoes.md", "Missing": None,
        "Spade#Part": "Garden/Tools/Spade.md", "#Top": "Garden/Plan.md",
    }


def test_finding_and_resolving_never_reach_a_foreign_space(client: TestClient, garden: Path) -> None:
    anna_row = make_account("anna", MEMBER)
    anna = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-anna0000"})
    sign_in(anna, anna_row)
    assert anna.get("/api/notes/find", params={"q": "basil"}).json() == []
    assert anna.get("/api/notes/find").json() == []
    assert anna.get("/api/notes/find", params={"q": "basil", "space": "Garden"}).json() == []
    foreign_source = anna.get("/api/notes/find", params={"q": "basil", "source": "Garden/Plan.md"})
    assert foreign_source.status_code == 404 and "Basil" not in foreign_source.text
    foreign = anna.get("/api/resolve/many", params={"source": "Garden/Plan.md", "target": ["Basil"]})
    missing = anna.get("/api/resolve/many", params={"source": "Nowhere/Plan.md", "target": ["Basil"]})
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()


def test_suggestions_say_how_a_link_from_the_source_reaches_each_note(client: TestClient, garden: Path) -> None:
    put(garden, "Garden/Tools/Basil.md", "a second basil, among the tools")
    index.scan()
    found = client.get("/api/notes/find", params={"q": "basil", "source": "Garden/Tools/Spade.md"}).json()
    links = {hit["path"]: hit["link"] for hit in found}
    # From Tools, [[Basil]] reaches the Basil next to it; the other needs its path.
    assert links == {"Garden/Tools/Basil.md": "Basil", "Garden/Beds/Basil.md": "Beds/Basil"}
    other = client.get("/api/notes/find", params={"q": "basil", "source": "Garden/Plan.md"}).json()
    # From the top of the space the shorter path wins: [[Basil]] is ambiguous, Obsidian takes the shortest path.
    assert {hit["path"]: hit["link"] for hit in other}["Garden/Beds/Basil.md"] in ("Basil", "Beds/Basil")
    assert all(hit["link"] is None for hit in client.get("/api/notes/find", params={"q": "basil"}).json())
    assert client.get("/api/notes/find", params={"q": "basil", "source": "Nowhere/x.md"}).json() == []


def test_a_note_restored_from_the_trash_has_its_tags_in_order(client: TestClient, garden: Path) -> None:
    # Trashed, its tags go; restored, the note is read again and they come back in the order of the file.
    assert client.delete("/api/files", params={"path": "Garden/Beds/Tomatoes.md"}).status_code == 200
    entry = next(e for e in client.get("/api/trash").json() if e["path"] == "Garden/Beds/Tomatoes.md")
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    index.scan()
    tomatoes = file_id("Garden/Beds/Tomatoes.md")
    with SessionLocal() as db:
        order = [t.tag_key for t in db.scalars(select(Tag).where(Tag.file_id == tomatoes).order_by(Tag.pos))]
    assert order == ["summer", "plants", "veg"]
    client.get("/api/graph/overview", params={"space": "Garden", "cloud": "tags"})
    by_id = {g.id: g for g in groups("tags").values()}
    assert by_id[nodes("tags")[tomatoes].group_id].key == "t:summer"


def test_a_failing_job_is_not_asked_for_again_at_once() -> None:
    worker = graphstore._Worker()
    job = ("update", 999, "folders")
    worker._failed[job] = __import__("time").monotonic()
    worker.ask(job)
    assert worker._jobs == []
    worker._failed[job] -= graphstore.RETRY_SECONDS + 1
    worker.ask(job)
    assert worker._jobs == [job]


def test_typing_in_one_space_leaves_the_map_of_another_alone(client: TestClient, garden: Path) -> None:
    put(garden, "Other/Note.md", "other")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Garden"})
    client.get("/api/graph/overview", params={"space": "Other"})
    before = graphstore.changes(space_id("Garden"))
    put(garden, "Other/Second.md", "second")
    index.scan()
    assert graphstore.changes(space_id("Garden")) == before
    assert graphstore.changes(space_id("Other")) > 0
    note = client.get("/api/note", params={"path": "Other/Note.md"}).json()
    client.put("/api/note", json={"path": "Other/Note.md", "content": "changed", "base_hash": note["hash"]})
    assert graphstore.changes(space_id("Garden")) == before


def test_a_folder_comes_in_pages_and_a_note_knows_its_copies(client: TestClient, garden: Path) -> None:
    for n in range(12):
        put(garden, f"Garden/Flat/Note {n:02d}.md", f"note {n}")
    put(garden, "Garden/Flat/Note 03 (conflict 2026-09-27 101010).md", "copy")
    put(garden, "Garden/Flat/Note 03 extra.md", "not a copy")
    index.scan()
    first = client.get("/api/folder", params={"path": "Garden/Flat", "limit": 5}).json()
    assert [f["name"] for f in first["files"]] == [f"Note {n:02d}.md" for n in range(3)] + [
        "Note 03 (conflict 2026-09-27 101010).md", "Note 03 extra.md"]
    assert first["total_files"] == 14
    rest = client.get("/api/folder", params={"path": "Garden/Flat", "offset": 5, "limit": 50}).json()
    assert len(rest["files"]) == 9
    assert len(client.get("/api/folder", params={"path": "Garden/Flat"}).json()["files"]) == 14
    copies = client.get("/api/note/copies", params={"path": "Garden/Flat/Note 03.md"}).json()
    assert copies == {"paths": ["Garden/Flat/Note 03 (conflict 2026-09-27 101010).md"]}
    back = client.get("/api/note/copies", params={"path": "Garden/Flat/Note 03 (conflict 2026-09-27 101010).md"}).json()
    assert back == {"paths": ["Garden/Flat/Note 03.md"]}
    assert client.get("/api/note/copies", params={"path": "Garden/Flat/Note 04.md"}).json() == {"paths": []}


def test_a_restored_note_never_takes_a_stray_file_of_the_trash_folder(client: TestClient, garden: Path) -> None:
    from app.services import vault

    tomatoes = file_id("Garden/Beds/Tomatoes.md")
    assert client.delete("/api/files", params={"path": "Garden/Beds/Tomatoes.md"}).status_code == 200
    # A file of the same id left in the trash folder (a file gone for good that Windows held open).
    stray = vault.trash_file(tomatoes)
    stray.parent.mkdir(parents=True, exist_ok=True)
    stray.write_bytes(b"somebody else's picture")
    entry = next(e for e in client.get("/api/trash").json() if e["path"] == "Garden/Beds/Tomatoes.md")
    assert client.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert "Tomatoes like [[Basil]]" in (garden / "Garden" / "Beds" / "Tomatoes.md").read_text(encoding="utf-8")


def lies_apart_and_inside(cloud: str = "folders") -> None:
    """Every group inside its parent and clear of its siblings, every note inside its group and clear of the others."""
    stored = groups(cloud)
    by_id = {g.id: g for g in stored.values()}
    for group in stored.values():
        if group.parent_id is None:
            continue
        parent = by_id[group.parent_id]
        assert math.hypot(group.x - parent.x, group.y - parent.y) + group.r <= parent.r + 0.5, group.key
        for other in stored.values():
            if other.parent_id == group.parent_id and other.id < group.id:
                assert math.hypot(group.x - other.x, group.y - other.y) >= group.r + other.r - 0.5, (
                    group.key, other.key)
    placed = list(nodes(cloud).values())
    for note in placed:
        home = by_id[note.group_id]
        assert math.hypot(note.x - home.x, note.y - home.y) + note.r <= home.r + 0.5, note.file_id
        for other in placed:
            if other.group_id == note.group_id and other.file_id < note.file_id:
                assert math.hypot(note.x - other.x, note.y - other.y) >= note.r + other.r - 0.5, (
                    note.file_id, other.file_id)


def test_a_space_filled_note_by_note_grows_with_its_notes(client: TestClient, vault: Path, account: object) -> None:
    """A space laid out while nearly empty and then filled one note at a time (as a helper writing through MCP
    does) used to keep its first tiny circle: new folders piled up at its edge, notes spiralled in its middle,
    and only the night put them in order. Now a new group or note that finds no room lays the map out anew."""
    put(vault, "Lab/Start.md", "start")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Lab"})
    for n in range(24):
        put(vault, f"Lab/{['Net', 'Hosts', 'Apps', 'Apps/Media', 'Backup', 'Plans'][n % 6]}/Note {n}.md", f"note {n}")
        index.scan()
        client.get("/api/graph/overview", params={"space": "Lab"})
        lies_apart_and_inside()
    grown = groups()["space"].r
    graphstore.build(space_id("Lab"), "folders")
    assert grown >= 0.8 * groups()["space"].r, "the circle of the space grew with its notes"


def test_notes_placed_bit_by_bit_add_up_to_a_new_layout(
    client: TestClient, garden: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A big space does not lay itself out for every crowded spot, but the notes placed one by one since the last
    layout add up: past the share, the next pass lays it out anew and starts counting again."""
    monkeypatch.setattr(graphstore, "CROWDED_RELAYOUT_UPTO", 0)
    monkeypatch.setattr(graphstore, "RELAYOUT_MIN", 3)
    client.get("/api/graph/overview", params={"space": "Garden"})

    def state() -> GraphState:
        with SessionLocal() as db:
            found = db.get(GraphState, (space_id("Garden"), "folders"))
            assert found is not None
            db.expunge(found)
        return found

    built = state().built_at
    for n in range(3):
        put(garden, f"Garden/Shed {n}/Rake {n}.md", f"rake {n}")
        index.scan()
        client.get("/api/graph/overview", params={"space": "Garden"})
        assert state().built_at == built and state().placed_since == n + 1, "crowded, but too big to lay out now"
    put(garden, "Garden/Beds/Chives.md", "chives")
    index.scan()
    client.get("/api/graph/overview", params={"space": "Garden"})
    after = state()
    assert after.built_at is not None and built is not None and after.built_at > built
    assert after.placed_since == 0 and after.changed_at is None
    lies_apart_and_inside()


def test_a_spot_counts_as_room_only_inside_its_circle_and_clear_of_the_rest() -> None:
    parent = graphstore._G(1, "space", None, "space", 0.0, 0.0, 100.0)
    assert graphstore._fits(parent, [], 50.0, 0.0, 40.0)
    assert not graphstore._fits(parent, [], 70.0, 0.0, 40.0), "over the edge"
    assert not graphstore._fits(parent, [(0.0, 0.0, 20.0)], 50.0, 0.0, 40.0), "on top of another"
    assert graphstore._fits(parent, [(-40.0, 0.0, 10.0)], 50.0, 0.0, 40.0)
