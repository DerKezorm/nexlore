"""Favorites: per account, only what may be read, following moves, going with the trash; headings, searches and groups."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import favorites, index

from .conftest import make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> tuple[TestClient, TestClient]:
    """anna manages "Garden" (Beds/Roses.md, Plan.md) and lets bob read it."""
    anna, bob = person("anna"), person("bob")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    (vault / "Garden" / "Beds").mkdir()
    (vault / "Garden" / "Beds" / "Roses.md").write_text("# Roses\n", encoding="utf-8")
    (vault / "Garden" / "Plan.md").write_text("# The plan\n", encoding="utf-8")
    index.scan()
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    return anna, bob


def listed(client: TestClient) -> list[tuple[str, str, str]]:
    answer = client.get("/api/favorites")
    assert answer.status_code == 200
    return [(item["path"], item["kind"], item["title"]) for item in answer.json()]


def test_each_account_has_its_own_in_the_order_they_came(people: tuple[TestClient, TestClient]) -> None:
    anna, bob = people
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 204
    assert anna.put("/api/favorites", json={"path": "Garden/Beds"}).status_code == 204
    # Twice is once.
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 204
    assert listed(anna) == [("Garden/Plan.md", "note", "Plan"), ("Garden/Beds", "folder", "Beds")]
    assert listed(bob) == []
    # Reading is enough for a favorite of one's own.
    assert bob.put("/api/favorites", json={"path": "Garden/Beds/Roses.md"}).status_code == 204
    assert listed(bob) == [("Garden/Beds/Roses.md", "note", "Roses")]
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md", "on": False}).status_code == 204
    assert listed(anna) == [("Garden/Beds", "folder", "Beds")]


def test_nothing_that_is_not_there_or_may_not_be_read(people: tuple[TestClient, TestClient]) -> None:
    anna, bob = people
    assert anna.put("/api/favorites", json={"path": "Garden/Nowhere.md"}).status_code == 404
    carl = person("carl")
    assert carl.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 404
    # Taken away the right: the favorite is not listed, and back with the right.
    assert bob.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 204
    assert anna.delete("/api/spaces/Garden/members/bob").status_code in (200, 204)
    assert listed(bob) == []
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    assert listed(bob) == [("Garden/Plan.md", "note", "Plan")]


def test_they_follow_a_move_and_go_with_the_trash(people: tuple[TestClient, TestClient]) -> None:
    anna, _ = people
    anna.put("/api/favorites", json={"path": "Garden/Beds"})
    anna.put("/api/favorites", json={"path": "Garden/Beds/Roses.md"})
    anna.put("/api/favorites", json={"path": "Garden/Plan.md"})
    assert anna.post("/api/move", json={"source": "Garden/Beds", "destination": "Garden/Plots"}).status_code == 200
    assert anna.post("/api/move", json={"source": "Garden/Plan.md", "destination": "Garden/Plan 2027.md"}).status_code == 200
    assert [path for path, _, _ in listed(anna)] == ["Garden/Plots", "Garden/Plots/Roses.md", "Garden/Plan 2027.md"]
    assert anna.delete("/api/files", params={"path": "Garden/Plots"}).status_code == 200
    assert [path for path, _, _ in listed(anna)] == ["Garden/Plan 2027.md"]
    assert anna.delete("/api/files", params={"path": "Garden/Plan 2027.md"}).status_code == 200
    assert listed(anna) == []


def test_a_neighbour_with_a_like_name_stays(people: tuple[TestClient, TestClient], vault: Path) -> None:
    anna, _ = people
    (vault / "Garden" / "Bedside").mkdir()
    anna.put("/api/favorites", json={"path": "Garden/Bedside"})
    anna.put("/api/favorites", json={"path": "Garden/Beds"})
    assert anna.post("/api/move", json={"source": "Garden/Beds", "destination": "Garden/Plots"}).status_code == 200
    assert anna.delete("/api/files", params={"path": "Garden/Plots"}).status_code == 200
    assert [path for path, _, _ in listed(anna)] == ["Garden/Bedside"]


def test_there_is_a_limit(people: tuple[TestClient, TestClient], vault: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    anna, _ = people
    monkeypatch.setattr(favorites, "MAX", 1)
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 204
    refused = anna.put("/api/favorites", json={"path": "Garden/Beds"})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (422, "too_many_favorites")


def test_a_trashed_favorite_does_not_count_any_more(
    people: tuple[TestClient, TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    anna, _ = people
    monkeypatch.setattr(favorites, "MAX", 1)
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 204
    assert anna.delete("/api/files", params={"path": "Garden/Plan.md"}).status_code == 200
    # Gone with the note: room for the next one.
    assert anna.put("/api/favorites", json={"path": "Garden/Beds"}).status_code == 204


def full(client: TestClient) -> list[dict]:
    answer = client.get("/api/favorites")
    assert answer.status_code == 200
    return answer.json()


def test_a_heading_and_a_search_are_kept_and_may_sit_in_a_group(people: tuple[TestClient, TestClient]) -> None:
    anna, bob = people
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md#The  plan", "section": "  Work "}).status_code == 204
    assert anna.put("/api/favorites", json={"path": "?tag:garden  roses", "section": "Work"}).status_code == 204
    assert anna.put("/api/favorites", json={"path": "Garden/Beds"}).status_code == 204
    assert full(anna) == [
        {"path": "Garden/Plan.md#The plan", "kind": "heading", "title": "The plan", "note": "Garden/Plan.md", "section": "Work"},
        {"path": "?tag:garden roses", "kind": "search", "title": "tag:garden roses", "section": "Work"},
        {"path": "Garden/Beds", "kind": "folder", "title": "Beds", "section": ""},
    ]
    # A group is changed by saying it again; left out, it stays; empty takes it out.
    assert anna.put("/api/favorites", json={"path": "Garden/Beds", "section": "Later"}).status_code == 204
    assert anna.put("/api/favorites", json={"path": "?tag:garden roses"}).status_code == 204
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md#The plan", "section": ""}).status_code == 204
    assert [(item["path"], item["section"]) for item in full(anna)] == [
        ("Garden/Plan.md#The plan", ""), ("?tag:garden roses", "Work"), ("Garden/Beds", "Later")]
    # Another account sees none of it.
    assert full(bob) == []


def test_a_heading_needs_its_note_and_the_right_to_read_it(people: tuple[TestClient, TestClient], vault: Path) -> None:
    anna, _ = people
    assert anna.put("/api/favorites", json={"path": "Garden/Nowhere.md#Top"}).status_code == 404
    # A folder has no headings, not even one whose name ends like a note's.
    (vault / "Garden" / "Odd.md").mkdir()
    assert anna.put("/api/favorites", json={"path": "Garden/Odd.md#Top"}).status_code == 404
    carl = person("carl")
    assert carl.put("/api/favorites", json={"path": "Garden/Plan.md#The plan"}).status_code == 404
    for bad in ("Garden/Plan.md#   ", "Garden/Plan.md#" + "x" * (favorites.MAX_HEADING + 1), "?   ", "?" + "y" * (favorites.MAX_QUERY + 1)):
        answer = anna.put("/api/favorites", json={"path": bad})
        assert (answer.status_code, answer.json()["detail"]["code"]) == (422, "bad_favorite"), bad
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md", "section": "x" * (favorites.MAX_SECTION + 1)}).status_code == 422


def test_a_heading_follows_its_note_and_goes_with_it(people: tuple[TestClient, TestClient]) -> None:
    anna, bob = people
    # The note itself renamed: its heading follows.
    assert anna.put("/api/favorites", json={"path": "Garden/Plan.md#The plan"}).status_code == 204
    assert anna.post("/api/move", json={"source": "Garden/Plan.md", "destination": "Garden/Plan 2027.md"}).status_code == 200
    assert [item["path"] for item in full(anna)] == ["Garden/Plan 2027.md#The plan"]
    assert bob.put("/api/favorites", json={"path": "Garden/Beds/Roses.md#Roses"}).status_code == 204
    assert anna.post("/api/move", json={"source": "Garden/Beds", "destination": "Garden/Plots"}).status_code == 200
    assert [item["path"] for item in full(bob)] == ["Garden/Plots/Roses.md#Roses"]
    # Not readable any more: not listed, as with a note.
    assert anna.delete("/api/spaces/Garden/members/bob").status_code in (200, 204)
    assert full(bob) == []
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    assert anna.delete("/api/files", params={"path": "Garden/Plots/Roses.md"}).status_code == 200
    assert full(bob) == []
