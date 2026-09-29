"""Comments in the margin: threads on words of a note, in the database and never in the file.

The world: ``anna`` manages ``Garden``; ``bob`` may write there, ``dora`` only read; ``carl`` has ``Diary`` alone.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.comments import mentioned

from .conftest import make_account, sign_in

NOTE = "# Beds\n\nDig the long bed in spring.\n"


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob, carl, dora = person("anna"), person("bob"), person("carl"), person("dora")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    assert carl.post("/api/spaces", json={"name": "Diary"}).status_code == 201
    assert anna.post("/api/notes", json={"folder": "Garden", "title": "Beds", "content": NOTE}).status_code == 201
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "write"}).status_code == 200
    assert anna.put("/api/spaces/Garden/members/dora", json={"role": "read"}).status_code == 200
    return {"anna": anna, "bob": bob, "carl": carl, "dora": dora}


PATH = "Garden/Beds.md"


def start(client: TestClient, body: str, quote: str = "long bed") -> int:
    made = client.post("/api/comments", json={"path": PATH, "quote": quote, "before": "Dig the ", "after": " in spring.", "body": body})
    assert made.status_code == 201, made.text
    return made.json()["id"]


def threads(client: TestClient) -> list[dict]:
    answer = client.get("/api/comments", params={"path": PATH})
    assert answer.status_code == 200, answer.text
    return answer.json()["threads"]


def test_a_reader_starts_a_thread_and_others_answer_and_the_file_stays_as_it_was(
    people: dict[str, TestClient], vault: Path
) -> None:
    dora, bob = people["dora"], people["bob"]
    thread = start(dora, "Which bed is the long one?")
    assert bob.post(f"/api/comments/{thread}/replies", json={"path": PATH, "body": "The one by the fence."}).status_code == 201
    found = threads(people["anna"])
    assert len(found) == 1
    assert found[0]["quote"] == "long bed" and found[0]["before"] == "Dig the " and found[0]["after"] == " in spring."
    assert [(c["author"], c["body"]) for c in found[0]["comments"]] == [
        ("dora", "Which bed is the long one?"), ("bob", "The one by the fence."),
    ]
    assert (vault / "Garden" / "Beds.md").read_bytes().decode() == NOTE
    # Only what one may read: carl sees no note there at all.
    assert people["carl"].get("/api/comments", params={"path": PATH}).status_code == 404
    assert people["carl"].post("/api/comments", json={"path": PATH, "quote": "x", "body": "y"}).status_code == 404


def test_own_words_are_changed_and_taken_back_and_a_manager_may_take_back_any(people: dict[str, TestClient]) -> None:
    dora, bob, anna = people["dora"], people["bob"], people["anna"]
    thread = start(dora, "First words")
    answer = bob.post(f"/api/comments/{thread}/replies", json={"path": PATH, "body": "bob's answer"}).json()["id"]
    assert bob.put(f"/api/comments/{thread}", json={"path": PATH, "body": "not his"}).status_code == 403
    assert dora.put(f"/api/comments/{thread}", json={"path": PATH, "body": "Better words"}).status_code == 200
    first = threads(anna)[0]["comments"][0]
    assert first["body"] == "Better words" and first["edited_at"] is not None
    assert threads(dora)[0]["comments"][0]["mine"] is True and threads(bob)[0]["comments"][0]["mine"] is False
    # bob may write, but takes back only his own; anna manages and takes back any.
    assert bob.delete(f"/api/comments/{thread}", params={"path": PATH}).status_code == 403
    assert bob.delete(f"/api/comments/{answer}", params={"path": PATH}).status_code == 204
    second = start(dora, "Another")
    assert anna.delete(f"/api/comments/{second}", params={"path": PATH}).status_code == 204
    # The first of a thread takes the thread along.
    reply = bob.post(f"/api/comments/{thread}/replies", json={"path": PATH, "body": "again"}).json()["id"]
    assert dora.delete(f"/api/comments/{thread}", params={"path": PATH}).status_code == 204
    assert threads(anna) == []
    assert anna.delete(f"/api/comments/{reply}", params={"path": PATH}).status_code == 404


def test_a_thread_is_closed_by_its_starter_or_a_writer_and_open_ones_come_first(people: dict[str, TestClient]) -> None:
    dora, bob, anna = people["dora"], people["bob"], people["anna"]
    first = start(anna, "anna's")
    second = start(dora, "dora's")
    # dora may only read: she closes her own thread, not anna's.
    assert dora.post(f"/api/comments/{first}/resolve", json={"path": PATH, "done": True}).status_code == 403
    assert dora.post(f"/api/comments/{second}/resolve", json={"path": PATH, "done": True}).status_code == 204
    found = threads(bob)
    assert [(t["id"], t["resolved"], t["resolved_by"]) for t in found] == [(first, False, ""), (second, True, "dora")]
    assert [t["may_resolve"] for t in threads(dora)] == [False, True]
    assert bob.post(f"/api/comments/{second}/resolve", json={"path": PATH, "done": False}).status_code == 204
    assert all(not t["resolved"] for t in threads(anna))
    # The older one closed: the open one comes first all the same.
    assert bob.post(f"/api/comments/{first}/resolve", json={"path": PATH, "done": True}).status_code == 204
    assert [t["id"] for t in threads(anna)] == [second, first]


def test_words_are_needed_and_the_quote_must_be_short(people: dict[str, TestClient]) -> None:
    anna = people["anna"]
    empty = anna.post("/api/comments", json={"path": PATH, "quote": "long bed", "body": "   "})
    assert empty.status_code == 422 and empty.json()["detail"]["code"] == "empty"
    assert anna.post("/api/comments", json={"path": PATH, "quote": "", "body": "x"}).status_code == 422
    assert anna.post("/api/comments", json={"path": PATH, "quote": "x" * 501, "body": "x"}).status_code == 422
    assert anna.post("/api/comments", json={"path": PATH, "quote": "q", "body": "x" * 5001}).status_code == 422
    assert anna.post("/api/comments/99999/replies", json={"path": PATH, "body": "x"}).status_code == 404


def test_names_for_at_are_those_who_may_read_the_space(people: dict[str, TestClient]) -> None:
    assert people["dora"].get("/api/comments/people", params={"path": PATH}).json() == ["anna", "bob", "dora"]
    assert people["dora"].get("/api/comments/people", params={"path": PATH, "q": "o"}).json() == ["bob", "dora"]
    assert "carl" not in people["dora"].get("/api/comments/people", params={"path": PATH, "q": "c"}).json()


def test_a_name_with_at_comes_up_as_new_for_that_account_until_it_opens_the_note(people: dict[str, TestClient]) -> None:
    anna, bob, dora = people["anna"], people["bob"], people["dora"]
    anna.get("/api/news")  # anna's "since" starts now
    thread = start(dora, "@anna can you look? and @nobody")
    news = anna.get("/api/news").json()
    assert [(m["thread"], m["path"], m["author"]) for m in news["mentions"]] == [(thread, PATH, "dora")]
    # Not for the one who wrote it, nor for somebody not named.
    assert bob.get("/api/news").json()["mentions"] == []
    dora.get("/api/news")
    start(dora, "@dora a note to myself")
    assert dora.get("/api/news").json()["mentions"] == []
    # Opened: seen.
    assert anna.post("/api/recent", json={"path": PATH}).status_code == 200
    assert anna.get("/api/news").json()["mentions"] == []
    # A closed thread asks nobody.
    bob.post(f"/api/comments/{thread}/replies", json={"path": PATH, "body": "@anna again"})
    assert len(anna.get("/api/news").json()["mentions"]) == 1
    assert bob.post(f"/api/comments/{thread}/resolve", json={"path": PATH, "done": True}).status_code == 204
    assert anna.get("/api/news").json()["mentions"] == []


def test_mentions_are_whole_names() -> None:
    assert mentioned("@anna, and @bob.") == {"anna", "bob"}
    assert mentioned("mail@example.com and @@x") == set()
    assert mentioned("@Anna-Lena") == {"anna-lena"}


def test_comments_follow_their_note_when_it_moves_and_go_with_it(people: dict[str, TestClient]) -> None:
    anna = people["anna"]
    start(anna, "stays with the note")
    moved = anna.post("/api/move", json={"source": PATH, "destination": "Garden/Old beds.md"})
    assert moved.status_code == 200, moved.text
    assert len(anna.get("/api/comments", params={"path": "Garden/Old beds.md"}).json()["threads"]) == 1
