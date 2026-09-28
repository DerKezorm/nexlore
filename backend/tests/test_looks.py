"""Symbols and colours of spaces and folders: who may set them, who sees them, and that they follow a folder that
moves and go with one that is trashed."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

from .conftest import make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> tuple[TestClient, TestClient, TestClient]:
    """anna manages "Garden" (with a folder "Beds/Roses"), bob reads it, carl has nothing to do with it."""
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    assert anna.post("/api/folders", json={"parent": "Garden", "name": "Beds"}).status_code == 201
    assert anna.post("/api/folders", json={"parent": "Garden/Beds", "name": "Roses"}).status_code == 201
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    return anna, bob, carl


def looks_of(client: TestClient) -> dict:
    answer = client.get("/api/looks")
    assert answer.status_code == 200
    return answer.json()["looks"]


def test_a_writer_sets_symbol_and_colour_and_every_reader_sees_them(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, bob, carl = people
    assert anna.put("/api/looks", json={"path": "Garden", "icon": "leaf", "color": "#a3e635"}).status_code == 204
    assert anna.put("/api/looks", json={"path": "Garden/Beds", "icon": "home", "color": None}).status_code == 204
    expected = {"": {"icon": "leaf", "color": "#a3e635"}, "Beds": {"icon": "home", "color": None}}
    assert looks_of(anna)["Garden"] == expected
    assert looks_of(bob)["Garden"] == expected
    # Not even the name of the space reaches somebody outside it.
    assert "Garden" not in looks_of(carl)
    # The choice comes with the lists to choose from.
    listed = anna.get("/api/looks").json()
    assert "leaf" in listed["icons"] and "#a3e635" in listed["colors"]


def test_reading_is_not_enough_to_change_them_and_a_stranger_finds_nothing(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, bob, carl = people
    assert bob.put("/api/looks", json={"path": "Garden/Beds", "icon": "star"}).status_code == 403
    assert carl.put("/api/looks", json={"path": "Garden/Beds", "icon": "star"}).status_code == 404
    assert "Beds" not in looks_of(anna).get("Garden", {})


def test_only_known_symbols_and_colours_and_only_folders_that_are_there(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, _, _ = people
    assert anna.put("/api/looks", json={"path": "Garden", "icon": "skull"}).status_code == 422
    assert anna.put("/api/looks", json={"path": "Garden", "color": "red"}).status_code == 422
    assert anna.put("/api/looks", json={"path": "Garden/Nowhere", "icon": "star"}).status_code == 404
    # Neither symbol nor colour: back to what nexlore works out.
    assert anna.put("/api/looks", json={"path": "Garden", "icon": "star"}).status_code == 204
    assert anna.put("/api/looks", json={"path": "Garden", "icon": None, "color": None}).status_code == 204
    assert looks_of(anna).get("Garden", {}) == {}


def test_they_follow_a_folder_that_moves_and_go_with_one_in_the_trash(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, _, _ = people
    assert anna.post("/api/folders", json={"parent": "Garden", "name": "Sheds"}).status_code == 201
    anna.put("/api/looks", json={"path": "Garden/Beds", "icon": "home"})
    anna.put("/api/looks", json={"path": "Garden/Beds/Roses", "icon": "heart", "color": "#fb7185"})
    anna.put("/api/looks", json={"path": "Garden/Sheds", "icon": "tool"})
    assert anna.post("/api/move", json={"source": "Garden/Beds", "destination": "Garden/Plots"}).status_code == 200
    assert looks_of(anna)["Garden"] == {
        "Plots": {"icon": "home", "color": None},
        "Plots/Roses": {"icon": "heart", "color": "#fb7185"},
        "Sheds": {"icon": "tool", "color": None},
    }
    assert anna.delete("/api/files", params={"path": "Garden/Plots"}).status_code == 200
    assert looks_of(anna)["Garden"] == {"Sheds": {"icon": "tool", "color": None}}
