"""Tags renamed in every note that carries them, the notes of a tag, and the notes an account opened last.

The world: ``anna`` manages ``Garden`` and ``Kitchen``; ``bob`` may write in ``Garden`` and only read ``Kitchen``;
``carl`` has ``Diary`` alone. A rename by bob changes Garden, leaves Kitchen (counted) and never touches Diary.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import File, Version
from app.services import index
from app.services.tagrename import rename_in, valid

from .conftest import make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def note(client: TestClient, folder: str, title: str, content: str) -> None:
    made = client.post("/api/notes", json={"folder": folder, "title": title, "content": content})
    assert made.status_code == 201, made.text


# --- The text ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("Plan #project and #project/garden, not #projects.\n", "Plan #work and #work/garden, not #projects.\n"),
        ("Case: #Project and #PROJECT/Beds\n", "Case: #work and #work/Beds\n"),
        ("---\ntags: [project, 'project/x', \"#project\", other]\n---\nbody\n", "---\ntags: [work, 'work/x', \"#work\", other]\n---\nbody\n"),
        ("---\ntitle: x\ntags:\n  - project\n  - other\n- project/y\nnext: project\n---\n", "---\ntitle: x\ntags:\n  - work\n  - other\n- work/y\nnext: project\n---\n"),
        ("---\ntags: project, other project/z\n---\n", "---\ntags: work, other work/z\n---\n"),
        ("---\r\ntags:\r\n  - project\r\n---\r\nText #project\r\n", "---\r\ntags:\r\n  - work\r\n---\r\nText #work\r\n"),
        # Not tags: in code, in a comment, in a link, a heading's hashes.
        ("`#project` and\n```\n#project\n```\n%%#project%% [[#project]] # project\n", "`#project` and\n```\n#project\n```\n%%#project%% [[#project]] # project\n"),
    ],
)
def test_the_tag_is_renamed_where_it_is_a_tag_and_nowhere_else(before: str, after: str) -> None:
    assert rename_in(before, "project", "work") == after


def test_a_new_name_must_be_a_tag() -> None:
    assert valid("work") and valid("work/garden-beds") and valid("Über_1")
    for bad in ["", "two words", "a//b", "/a", "2026", "a#b", "x" * 256]:
        assert not valid(bad), bad


# --- Renaming over the API ----------------------------------------------------------------------------------------


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    for space in ("Garden", "Kitchen"):
        assert anna.post("/api/spaces", json={"name": space}).status_code == 201
    assert carl.post("/api/spaces", json={"name": "Diary"}).status_code == 201
    note(anna, "Garden", "Beds", "---\ntags: [project]\n---\nDig #project/beds\n")
    note(anna, "Garden", "Seeds", "Buy #project seeds\n")
    note(anna, "Garden", "Busy", "Typing #project\n")
    note(anna, "Kitchen", "Jam", "Cook #project\n")
    note(carl, "Diary", "Secret", "Mine #project\n")
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "write"}).status_code == 200
    assert anna.put("/api/spaces/Kitchen/members/bob", json={"role": "read"}).status_code == 200
    return {"anna": anna, "bob": bob, "carl": carl}


def read(vault: Path, rel: str) -> str:
    return (vault / rel).read_text(encoding="utf-8")


def test_a_rename_writes_where_the_account_may_write_and_skips_a_note_being_edited(
    people: dict[str, TestClient], vault: Path
) -> None:
    anna, bob = people["anna"], people["bob"]
    assert anna.post("/api/locks", json={"path": "Garden/Busy.md"}).status_code == 200
    answer = bob.post("/api/tags/rename", json={"old": "#project", "new": "work"})
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"changed": 2, "locked": 1, "read_only": 1}
    assert read(vault, "Garden/Beds.md") == "---\ntags: [work]\n---\nDig #work/beds\n"
    assert read(vault, "Garden/Seeds.md") == "Buy #work seeds\n"
    assert read(vault, "Garden/Busy.md") == "Typing #project\n"
    assert read(vault, "Kitchen/Jam.md") == "Cook #project\n"
    assert read(vault, "Diary/Secret.md") == "Mine #project\n"
    # Read in again at once: the tag list knows the new name; the version says who renamed.
    tags = {row["tag"]: row["count"] for row in bob.get("/api/tags").json()}
    assert tags["work"] == 2 and tags["work/beds"] == 1 and tags["project"] == 2
    with SessionLocal() as db:
        seeds = db.scalar(select(File).where(File.path == "Garden/Seeds.md"))
        newest = db.scalars(select(Version).where(Version.file_id == seeds.id).order_by(Version.id.desc())).first()
        assert (newest.source, newest.author) == (index.RENAME, "bob")


def test_a_rename_refuses_names_that_are_no_tags_and_a_reader_changes_nothing(
    people: dict[str, TestClient], vault: Path
) -> None:
    bob, carl = people["bob"], people["carl"]
    assert bob.post("/api/tags/rename", json={"old": "project", "new": "two words"}).status_code == 422
    assert bob.post("/api/tags/rename", json={"old": "project", "new": "project"}).status_code == 422
    # carl sees none of these notes: nothing counted, nothing changed, only his own.
    assert carl.post("/api/tags/rename", json={"old": "project", "new": "mine"}).json() == {
        "changed": 1, "locked": 0, "read_only": 0,
    }
    assert read(vault, "Garden/Seeds.md") == "Buy #project seeds\n"


def test_the_notes_of_a_tag_include_the_ones_below_and_only_readable_ones(people: dict[str, TestClient]) -> None:
    bob = people["bob"]
    found = [row["path"] for row in bob.get("/api/tags/notes", params={"tag": "#Project"}).json()]
    assert found == ["Garden/Beds.md", "Garden/Busy.md", "Kitchen/Jam.md", "Garden/Seeds.md"]
    assert [row["path"] for row in bob.get("/api/tags/notes", params={"tag": "project/beds"}).json()] == ["Garden/Beds.md"]
    assert bob.get("/api/tags/notes", params={"tag": "proj"}).json() == []
    exact = bob.get("/api/tags/notes", params={"tag": "project", "exact": True}).json()
    assert [row["path"] for row in exact] == ["Garden/Beds.md", "Garden/Busy.md", "Kitchen/Jam.md", "Garden/Seeds.md"]
    assert bob.get("/api/tags/notes", params={"tag": "project/beds", "exact": True}).json()[0]["path"] == "Garden/Beds.md"


# --- Opened last --------------------------------------------------------------------------------------------------


def test_the_notes_opened_last_come_newest_first_once_each_and_only_readable_ones(
    people: dict[str, TestClient], vault: Path
) -> None:
    anna, bob = people["anna"], people["bob"]
    for path in ["Garden/Beds.md", "Kitchen/Jam.md", "Garden/Beds.md", "Garden/Seeds.md"]:
        assert bob.post("/api/recent", json={"path": path}).status_code == 200
    assert [row["path"] for row in bob.get("/api/recent").json()] == ["Garden/Seeds.md", "Garden/Beds.md", "Kitchen/Jam.md"]
    # Per account.
    assert anna.get("/api/recent").json() == []
    # A space bob may not read: as if the note were not there.
    assert bob.post("/api/recent", json={"path": "Diary/Secret.md"}).status_code == 404
    # Out of the space: out of the list. A note in the trash: out as well.
    assert anna.delete("/api/spaces/Kitchen/members/bob").status_code in (200, 204)
    assert anna.request("DELETE", "/api/files", params={"path": "Garden/Seeds.md"}).status_code in (200, 204)
    assert [row["path"] for row in bob.get("/api/recent").json()] == ["Garden/Beds.md"]


def test_only_the_last_thirty_are_kept(people: dict[str, TestClient]) -> None:
    anna = people["anna"]
    for number in range(35):
        note(anna, "Garden", f"N{number:02}", "x")
        assert anna.post("/api/recent", json={"path": f"Garden/N{number:02}.md"}).status_code == 200
    shown = [row["path"] for row in anna.get("/api/recent", params={"limit": 30}).json()]
    assert shown[0] == "Garden/N34.md" and shown[-1] == "Garden/N05.md" and len(shown) == 30
    with SessionLocal() as db:
        from app.models import RecentNote

        assert len(db.scalars(select(RecentNote)).all()) == 30
