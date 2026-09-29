"""Mentions without a link, linking one, and cleaning up a space.

The world: ``anna`` manages ``Garden`` and ``Kitchen``; ``bob`` may write in ``Garden`` and only read ``Kitchen``;
``carl`` has ``Diary`` alone. The note ``Garden/Compost heap.md`` (alias ``Heap``) is named in several places.
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
from app.services.mentions import places_in, wiki_for

from .conftest import make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def note(client: TestClient, folder: str, title: str, content: str) -> None:
    made = client.post("/api/notes", json={"folder": folder, "title": title, "content": content})
    assert made.status_code == 201, made.text


def read(vault: Path, rel: str) -> str:
    return (vault / rel).read_bytes().decode("utf-8")


# --- The text ---------------------------------------------------------------------------------------------------


def test_a_name_is_found_as_a_whole_word_outside_code_links_tags_and_addresses() -> None:
    content = (
        "---\ntitle: Compost heap notes\n---\n"
        "The compost heap is warm. The Compost Heaps are not it.\n"
        "`compost heap` and [[Compost heap]] and [the heap](Compost%20heap.md) and #heap\n"
        "```\ncompost heap\n```\n"
        "%% compost heap %% and https://example.com/?q=heap heap\n"
        "Heap, again: a heap.\n"
    )
    found = places_in(content, ["Compost heap", "Heap"])
    assert [(line, column, words) for line, column, _, words in found] == [
        (4, 4, "compost heap"),
        # "https://example.com/?q=heap" is an address; the word after it stands alone.
        (9, 51, "heap"),
        (10, 0, "Heap"),
        (10, 15, "heap"),
    ]
    # The offset in the file is where the words are.
    for _, _, start, words in found:
        assert content[start : start + len(words)] == words


def test_the_link_keeps_the_words_where_they_differ_from_the_name() -> None:
    assert wiki_for("Compost heap", "Compost heap") == "[[Compost heap]]"
    assert wiki_for("Compost heap", "compost heap") == "[[Compost heap|compost heap]]"
    assert wiki_for("Garden/Compost heap", "Heap") == "[[Garden/Compost heap|Heap]]"


# --- Over the API -------------------------------------------------------------------------------------------------


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    for space in ("Garden", "Kitchen"):
        assert anna.post("/api/spaces", json={"name": space}).status_code == 201
    assert carl.post("/api/spaces", json={"name": "Diary"}).status_code == 201
    note(anna, "Garden", "Compost heap", "---\naliases: [Heap]\n---\nWarm and brown. The heap grows.\n")
    note(anna, "Garden", "Beds", "Dig beside the compost heap.\r\nThe [[Compost heap]] again.\r\n")
    note(anna, "Garden", "Busy", "Typing about the compost heap.\n")
    note(anna, "Garden", "Alone", "Nothing to see.\n")
    note(anna, "Garden", "Broken", "See [[Nowhere]] and ![[missing.png]].\n")
    note(anna, "Kitchen", "Peel", "Peel goes to the heap.\n")
    note(carl, "Diary", "Secret", "My compost heap.\n")
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "write"}).status_code == 200
    assert anna.put("/api/spaces/Kitchen/members/bob", json={"role": "read"}).status_code == 200
    return {"anna": anna, "bob": bob, "carl": carl}


def test_mentions_come_from_readable_notes_only_and_say_where_the_link_may_be_written(
    people: dict[str, TestClient],
) -> None:
    bob = people["bob"]
    answer = bob.get("/api/mentions", params={"path": "Garden/Compost heap.md"})
    assert answer.status_code == 200, answer.text
    places = answer.json()["places"]
    assert [(p["path"], p["line"], p["column"], p["words"], p["writable"]) for p in places] == [
        ("Garden/Beds.md", 1, 15, "compost heap", True),
        ("Garden/Busy.md", 1, 17, "compost heap", True),
        ("Kitchen/Peel.md", 1, 17, "heap", False),
    ]
    beds = places[0]
    assert (beds["before"], beds["after"], beds["link"]) == ("Dig beside the ", ".", "Compost heap")
    # From another space the link needs the space's name.
    assert places[2]["link"] == "Garden/Compost heap"
    # carl reads none of it.
    assert people["carl"].get("/api/mentions", params={"path": "Garden/Compost heap.md"}).status_code == 404


def test_linking_a_mention_writes_only_those_words_and_refuses_what_it_should(
    people: dict[str, TestClient], vault: Path
) -> None:
    anna, bob = people["anna"], people["bob"]
    target = "Garden/Compost heap.md"
    body = {"source": "Garden/Beds.md", "target": target, "line": 1, "column": 15, "words": "compost heap"}
    # The place moved (another column): nothing written.
    assert bob.post("/api/mentions/link", json={**body, "column": 14}).json()["detail"]["code"] == "mention_moved"
    # The same place, other words: nothing written either.
    changed = {**body, "words": "Compost heap"}
    assert bob.post("/api/mentions/link", json=changed).json()["detail"]["code"] == "mention_moved"
    answer = bob.post("/api/mentions/link", json=body)
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"link": "[[Compost heap|compost heap]]"}
    assert read(vault, "Garden/Beds.md") == "Dig beside the [[Compost heap|compost heap]].\r\nThe [[Compost heap]] again.\r\n"
    with SessionLocal() as db:
        beds = db.scalar(select(File).where(File.path == "Garden/Beds.md"))
        newest = db.scalars(select(Version).where(Version.file_id == beds.id).order_by(Version.id.desc())).first()
        assert (newest.source, newest.author) == (index.APP, "bob")
    # Linked now: no longer a mention, and a second try finds nothing there.
    paths_left = [p["path"] for p in bob.get("/api/mentions", params={"path": target}).json()["places"]]
    assert "Garden/Beds.md" not in paths_left
    assert bob.post("/api/mentions/link", json=body).status_code == 409
    # Someone editing: left alone.
    assert anna.post("/api/locks", json={"path": "Garden/Busy.md"}).status_code == 200
    busy = {"source": "Garden/Busy.md", "target": target, "line": 1, "column": 17, "words": "compost heap"}
    assert bob.post("/api/mentions/link", json=busy).json()["detail"]["code"] == "note_locked"
    assert read(vault, "Garden/Busy.md") == "Typing about the compost heap.\n"
    # A reader of the other space may not write there.
    peel = {"source": "Kitchen/Peel.md", "target": target, "line": 1, "column": 17, "words": "heap"}
    assert bob.post("/api/mentions/link", json=peel).status_code == 403
    assert anna.post("/api/mentions/link", json=peel).json() == {"link": "[[Garden/Compost heap|heap]]"}
    assert read(vault, "Kitchen/Peel.md") == "Peel goes to the [[Garden/Compost heap|heap]].\n"


def test_cleaning_up_lists_lonely_notes_and_links_to_nothing(people: dict[str, TestClient]) -> None:
    bob = people["bob"]
    answer = bob.get("/api/cleanup", params={"space": "Garden"})
    assert answer.status_code == 200, answer.text
    found = answer.json()
    # Compost heap is linked from Beds; Broken links out, only to nothing: lonely too.
    assert [row["path"] for row in found["lonely"]] == ["Garden/Alone.md", "Garden/Broken.md", "Garden/Busy.md"]
    assert found["lonely_total"] == 3
    assert [(row["target"], row["line"], row["kind"]) for row in found["broken"]] == [
        ("missing.png", 1, "embed"), ("Nowhere", 1, "wiki"),
    ]
    assert found["broken_total"] == 2
    assert people["carl"].get("/api/cleanup", params={"space": "Garden"}).status_code == 404
    assert bob.get("/api/cleanup", params={"space": "Nowhere"}).status_code == 404
