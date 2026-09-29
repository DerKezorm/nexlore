"""Quick capture into the inbox note of a space.

The world: ``anna`` manages ``Garden`` and writes German; ``bob`` may only read ``Garden``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.inbox import entry, name_for, put_in

from .conftest import make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def read(vault: Path, rel: str) -> str:
    return (vault / rel).read_bytes().decode("utf-8")


# --- The text ---------------------------------------------------------------------------------------------------


def test_an_entry_is_one_list_item_with_its_time_and_further_lines_under_it() -> None:
    assert entry("  Buy seeds  ", "2026-09-29 22:41") == "- 2026-09-29 22:41 Buy seeds\n"
    assert entry("Call Bo\r\nabout the fence\n\nand the gate", "2026-09-29 22:41") == (
        "- 2026-09-29 22:41 Call Bo\n  about the fence\n\n  and the gate\n"
    )


@pytest.mark.parametrize(
    ("before", "after"),
    [
        ("", "- NEW\n"),
        ("# Inbox\n", "# Inbox\n\n- NEW\n"),
        ("# Inbox", "# Inbox\n\n- NEW\n"),
        ("# Inbox\n\n- old\n", "# Inbox\n\n- NEW\n- old\n"),
        ("---\ntags: [x]\n---\n# Inbox\n\n- old\n", "---\ntags: [x]\n---\n# Inbox\n\n- NEW\n- old\n"),
        ("# Inbox\r\n\r\n- old\r\n", "# Inbox\r\n\r\n- NEW\r\n- old\r\n"),
        ("Some words first.\n", "- NEW\n\nSome words first.\n"),
        ("# Inbox\nA line.\n", "# Inbox\n\n- NEW\n\nA line.\n"),
    ],
)
def test_the_newest_entry_goes_on_top_after_front_matter_and_heading(before: str, after: str) -> None:
    assert put_in(before, "- NEW\n") == after


def test_the_inbox_is_named_in_the_language_of_the_account() -> None:
    assert name_for("de") == "Eingang"
    assert name_for("de-AT") == "Eingang"
    assert name_for("en") == "Inbox"
    assert name_for("") == "Inbox"
    assert name_for(None) == "Inbox"


# --- Over the API -------------------------------------------------------------------------------------------------


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob = person("anna"), person("bob")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    assert anna.put("/api/spaces/Garden/members/bob", json={"role": "read"}).status_code == 200
    assert anna.put("/api/me/language", json={"language": "de"}).status_code == 200
    return {"anna": anna, "bob": bob}


def test_capturing_makes_the_inbox_then_puts_the_newest_on_top(people: dict[str, TestClient], vault: Path) -> None:
    anna = people["anna"]
    first = anna.post("/api/inbox", json={"space": "Garden", "text": "Buy seeds", "stamp": "2026-09-29 08:00"})
    assert first.status_code == 200, first.text
    assert first.json() == {"path": "Garden/Eingang.md"}
    assert read(vault, "Garden/Eingang.md") == "# Eingang\n\n- 2026-09-29 08:00 Buy seeds\n"
    again = anna.post("/api/inbox", json={"space": "Garden", "text": "Water beds", "stamp": "2026-09-29 09:30"})
    assert again.json() == {"path": "Garden/Eingang.md"}
    assert read(vault, "Garden/Eingang.md") == "# Eingang\n\n- 2026-09-29 09:30 Water beds\n- 2026-09-29 08:00 Buy seeds\n"
    # The note is known at once, with its text searchable.
    assert [hit["path"] for hit in anna.get("/api/search", params={"q": "Water"}).json()] == ["Garden/Eingang.md"]


def test_an_inbox_that_is_there_is_used_whatever_its_language(people: dict[str, TestClient], vault: Path) -> None:
    anna = people["anna"]
    made = anna.post("/api/notes", json={"folder": "Garden", "title": "Inbox", "content": "# Inbox\r\n\r\n- old\r\n"})
    assert made.status_code == 201, made.text
    answer = anna.post("/api/inbox", json={"space": "Garden", "text": "New", "stamp": "2026-09-29 10:00"})
    assert answer.json() == {"path": "Garden/Inbox.md"}
    assert read(vault, "Garden/Inbox.md") == "# Inbox\r\n\r\n- 2026-09-29 10:00 New\r\n- old\r\n"


def test_capturing_refuses_readers_empty_words_bad_times_and_an_inbox_being_edited(
    people: dict[str, TestClient], vault: Path
) -> None:
    anna, bob = people["anna"], people["bob"]
    good = {"space": "Garden", "text": "x", "stamp": "2026-09-29 10:00"}
    assert bob.post("/api/inbox", json=good).status_code == 403
    assert anna.post("/api/inbox", json={**good, "text": "   "}).json()["detail"]["code"] == "empty"
    assert anna.post("/api/inbox", json={**good, "stamp": "tomorrow"}).status_code == 422
    assert anna.post("/api/inbox", json={**good, "space": "Garden/Deep"}).status_code == 422
    assert anna.post("/api/inbox", json=good).status_code == 200
    assert anna.post("/api/locks", json={"path": "Garden/Eingang.md"}).status_code == 200
    busy = anna.post("/api/inbox", json={**good, "text": "later"})
    assert busy.status_code == 409 and busy.json()["detail"]["code"] == "note_locked"
    assert "later" not in read(vault, "Garden/Eingang.md")
