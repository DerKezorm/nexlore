"""Who has a note open: others see each other, the one editing marked, the gone ones not, and only readers.

The world: ``anna`` manages ``Garden``; ``bob`` may read it; ``carl`` has ``Diary`` alone.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import presence

from .conftest import make_account, sign_in

PATH = "Garden/Beds.md"


def person(name: str, tab: str | None = None) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{(tab or name):0<8}"})
    sign_in(client, make_account(name))
    return client


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    presence.forget()
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    assert carl.post("/api/spaces", json={"name": "Diary"}).status_code == 201
    assert anna.post("/api/notes", json={"folder": "Garden", "title": "Beds", "content": "Dig.\n"}).status_code == 201
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    yield {"anna": anna, "bob": bob, "carl": carl}
    presence.forget()


def here(client: TestClient) -> list[dict]:
    answer = client.post("/api/presence", json={"path": PATH})
    assert answer.status_code == 200, answer.text
    return answer.json()["people"]


def test_those_with_the_note_open_see_each_other_and_not_themselves(people: dict[str, TestClient]) -> None:
    anna, bob = people["anna"], people["bob"]
    assert here(anna) == []
    assert [p["name"] for p in here(bob)] == ["anna"]
    assert [(p["name"], p["writing"]) for p in here(anna)] == [("bob", False)]
    # carl may not read the note: he learns nothing, and is seen by nobody.
    assert people["carl"].post("/api/presence", json={"path": PATH}).status_code == 404
    assert [p["name"] for p in here(anna)] == ["bob"]


def test_the_tab_holding_the_lock_is_shown_writing_and_a_second_tab_counts_once(people: dict[str, TestClient]) -> None:
    anna, bob = people["anna"], people["bob"]
    anna_again = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-anna0002"})
    anna_again.cookies.update(anna.cookies)
    # The writing tab is seen first; the reading one after it must not take the pencil away.
    here(anna_again)
    here(anna)
    assert anna_again.post("/api/locks", json={"path": PATH}).status_code == 200
    assert here(bob) == [{"id": here(bob)[0]["id"], "name": "anna", "avatar": None, "writing": True}]


def test_a_page_that_left_or_went_quiet_is_gone(people: dict[str, TestClient], monkeypatch: pytest.MonkeyPatch) -> None:
    anna, bob = people["anna"], people["bob"]
    here(anna)
    assert anna.delete("/api/presence", params={"path": PATH}).status_code == 204
    assert here(bob) == []
    here(anna)
    clock = presence._now()
    monkeypatch.setattr(presence, "_now", lambda: clock + presence.STALE_SECONDS + 1)
    assert here(bob) == []
