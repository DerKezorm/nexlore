"""New since the last visit, and proposals from readers.

The world: ``anna`` writes in ``Garden`` (she made it), ``bob`` reads it, ``carl`` has nothing to do with it.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import index

from .conftest import make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def note(client: TestClient, title: str, content: str) -> dict:
    made = client.post("/api/notes", json={"folder": "Garden", "title": title, "content": content})
    assert made.status_code == 201, made.text
    return made.json()


def save(client: TestClient, path: str, content: str) -> None:
    current = client.get("/api/note", params={"path": path}).json()
    saved = client.put("/api/note", json={"path": path, "content": content, "base_hash": current["hash"]})
    assert saved.status_code == 200, saved.text


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    # Written before, from outside: their first versions are the texts everybody saw.
    (vault / "Garden" / "Beds.md").write_bytes(b"# Beds\n\nTomatoes.\n")
    (vault / "Garden" / "Seeds.md").write_bytes(b"# Seeds\n\nBasil.\n")
    index.scan()
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    return {"anna": anna, "bob": bob, "carl": carl}


def paths_of(client: TestClient) -> list[str]:
    return [row["path"] for row in client.get("/api/news").json()["notes"]]


def test_new_is_what_others_changed_after_the_last_visit(people: dict[str, TestClient], vault: Path) -> None:
    anna, bob, carl = people["anna"], people["bob"], people["carl"]
    # Asked the first time: from now on; what was there before is not new.
    assert paths_of(bob) == []
    save(anna, "Garden/Beds.md", "# Beds\n\nTomatoes and beans.\n")
    news = bob.get("/api/news").json()
    assert news["count"] == 1
    assert [(row["path"], row["author"]) for row in news["notes"]] == [("Garden/Beds.md", "anna")]
    # Opened: the answer names the change and the text bob saw last; after it, not new any more.
    opened = bob.post("/api/recent", json={"path": "Garden/Beds.md"}).json()["news"]
    assert opened["author"] == "anna" and opened["since_version"] is not None
    old = bob.get(f"/api/versions/{opened['since_version']}").json()
    assert "beans" not in old["content"]
    assert paths_of(bob) == []
    assert bob.post("/api/recent", json={"path": "Garden/Beds.md"}).json()["news"] is None
    # The own changes never count; a change from outside does, without an author.
    save(anna, "Garden/Beds.md", "# Beds\n\nTomatoes, beans, peas.\n")
    assert paths_of(anna) == []
    (vault / "Garden" / "Seeds.md").write_bytes(b"# Seeds\n\nBasil and thyme.\n")
    index.scan()
    assert sorted((row["path"], row["author"]) for row in bob.get("/api/news").json()["notes"]) == [
        ("Garden/Beds.md", "anna"), ("Garden/Seeds.md", ""),
    ]
    # Nobody else's business.
    assert paths_of(carl) == []
    # All marked as seen at once.
    assert bob.post("/api/news/seen").status_code == 204
    assert paths_of(bob) == []


def test_a_reader_proposes_and_a_writer_takes_it_over(people: dict[str, TestClient], vault: Path) -> None:
    anna, bob, carl = people["anna"], people["bob"], people["carl"]
    current = bob.get("/api/note", params={"path": "Garden/Seeds.md"}).json()
    made = bob.post("/api/proposals", json={
        "path": "Garden/Seeds.md", "content": "# Seeds\n\nBasil and dill.\n", "base_hash": current["hash"], "message": "Dill too",
    })
    assert made.status_code == 201, made.text
    proposal = made.json()
    assert (proposal["by"], proposal["status"], proposal["message"]) == ("bob", "open", "Dill too")
    # The writer sees it on the note and waiting for her; carl sees nothing, bob sees only his own.
    on_note = anna.get("/api/proposals/note", params={"path": "Garden/Seeds.md"}).json()
    assert [(row["by"], row["content"]) for row in on_note] == [("bob", "# Seeds\n\nBasil and dill.\n")]
    assert [row["id"] for row in anna.get("/api/proposals").json()["waiting"]] == [proposal["id"]]
    assert carl.get("/api/proposals/note", params={"path": "Garden/Seeds.md"}).status_code == 404
    assert carl.post(f"/api/proposals/{proposal['id']}/take").status_code == 404
    # A reader does not decide, not even on his own.
    assert bob.post(f"/api/proposals/{proposal['id']}/take").status_code == 403
    taken = anna.post(f"/api/proposals/{proposal['id']}/take")
    assert taken.status_code == 200 and taken.json()["conflict"] is None
    assert (vault / "Garden" / "Seeds.md").read_bytes() == b"# Seeds\n\nBasil and dill.\n"
    assert anna.post(f"/api/proposals/{proposal['id']}/take").status_code == 409
    mine = bob.get("/api/proposals").json()["mine"]
    assert [(row["status"], row["decided_by"]) for row in mine] == [("taken", "anna")]
    versions = anna.get("/api/versions", params={"path": "Garden/Seeds.md"}).json()
    assert versions[0]["source"] == "proposal" and versions[0]["author"] == "anna"


def test_a_proposal_on_a_changed_note_goes_into_a_conflict_copy_and_one_can_be_declined(
    people: dict[str, TestClient], vault: Path
) -> None:
    anna, bob = people["anna"], people["bob"]
    current = bob.get("/api/note", params={"path": "Garden/Beds.md"}).json()
    first = bob.post("/api/proposals", json={"path": "Garden/Beds.md", "content": "# Beds\n\nBob's.\n", "base_hash": current["hash"]}).json()
    second = bob.post("/api/proposals", json={"path": "Garden/Beds.md", "content": "# Beds\n\nOther.\n", "base_hash": current["hash"]}).json()
    save(anna, "Garden/Beds.md", "# Beds\n\nAnna's own change.\n")
    taken = anna.post(f"/api/proposals/{first['id']}/take").json()
    assert taken["conflict"] and "conflict" in taken["conflict"]
    assert (vault / "Garden" / "Beds.md").read_bytes() == b"# Beds\n\nAnna's own change.\n"
    assert anna.post(f"/api/proposals/{second['id']}/decline").status_code == 204
    assert [row["status"] for row in bob.get("/api/proposals").json()["mine"]] == ["declined", "taken"]
    # Withdrawn by its proposer, never by anybody else.
    third = bob.post("/api/proposals", json={"path": "Garden/Beds.md", "content": "x", "base_hash": current["hash"]}).json()
    assert anna.delete(f"/api/proposals/{third['id']}").status_code == 404
    assert bob.delete(f"/api/proposals/{third['id']}").status_code == 204
