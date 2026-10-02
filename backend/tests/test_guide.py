"""The space "nexlore" with the guide: made at the first setup of an empty vault in the language chosen then, made
again by the operator next to what is there, never overwriting; every link in it leads somewhere, every picture is
there, and both languages carry the same notes."""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.services import guide

from .conftest import SETUP_CODE, make_account, sign_in

PASSWORD = "a long enough password"
#: The one link that leads nowhere on purpose: it shows what a missing link looks like.
MISSING = {"de": {"Eine Idee für später"}, "en": {"An idea for later"}}


@pytest.fixture
def welcome() -> Iterator[None]:
    """The guide at the first start switched on, as in a real installation (the tests switch it off otherwise)."""
    settings = get_settings()
    before = settings.welcome_guide
    settings.welcome_guide = True
    yield
    settings.welcome_guide = before


def notes_of(client: TestClient, space: str) -> dict[str, str]:
    found: dict[str, str] = {}
    stack = [space]
    while stack:
        folder = client.get("/api/folder", params={"path": stack.pop(), "limit": 500}).json()
        stack += [entry["path"] for entry in folder["folders"]]
        found.update({entry["path"]: entry["name"] for entry in folder["files"]})
    return found


@pytest.mark.parametrize(("language", "welcome_note", "template"), [("de", "00 Willkommen.md", "Besprechung"), ("en", "00 Welcome.md", "Meeting")])
def test_the_first_start_makes_the_guide_in_the_language_chosen(
    client: TestClient, vault: Path, welcome: None, language: str, welcome_note: str, template: str
) -> None:
    made = client.post("/api/setup", json={"code": SETUP_CODE, "name": "boss", "password": PASSWORD, "language": language})
    assert made.status_code == 200
    spaces = {space["name"]: space["role"] for space in client.get("/api/spaces").json()}
    assert spaces == {"nexlore": "manage"}
    assert (vault / "nexlore" / welcome_note).is_file()
    # The tasks are due from today on: the calendar and the task list show them now.
    today = datetime.now().astimezone().date()
    tasks = client.get("/api/tasks", params={"status": "open", "space": "nexlore", "today": today.isoformat()}).json()
    due = sorted(task["due"] for task in tasks["items"] if task.get("due"))
    assert due[0] == today.isoformat() and (today + timedelta(days=7)).isoformat() in due
    # The template is offered, its placeholders left for the new note.
    templates = client.get("/api/templates", params={"space": "nexlore"}).json()
    assert [item["path"] for item in templates] == [f"nexlore/Templates/{template}.md"]
    assert "{{title}}" in (vault / "nexlore" / "Templates" / f"{template}.md").read_text(encoding="utf-8")


def test_every_link_leads_somewhere_and_every_picture_is_there(
    client: TestClient, account: object, vault: Path, welcome: None
) -> None:
    for language in guide.LANGUAGES:
        name = guide.create(None, language)
        for path in notes_of(client, name):
            if not path.endswith(".md"):
                continue
            links = client.get("/api/links", params={"path": path}).json()["outgoing"]
            missing = {link["target"].split("#")[0] for link in links if link["kind"] != "markdown" and link["path"] is None}
            assert missing <= MISSING[language], (path, missing)
            for picture in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", (vault / path).read_text(encoding="utf-8")):
                assert (vault / name / picture).is_file(), (path, picture)


def test_it_is_not_made_when_the_vault_has_notes_already(client: TestClient, vault: Path, welcome: None) -> None:
    (vault / "Mine").mkdir()
    (vault / "Mine" / "Note.md").write_text("# Note\n", encoding="utf-8")
    assert client.post("/api/setup", json={"code": SETUP_CODE, "name": "boss", "password": PASSWORD, "language": "de"}).status_code == 200
    assert not (vault / "nexlore").exists()


def test_the_operator_makes_it_again_next_to_what_is_there(client: TestClient, account: object, vault: Path) -> None:
    first = client.post("/api/settings/guide", json={"language": "de"})
    assert (first.status_code, first.json()) == (201, {"space": "nexlore"})
    changed = vault / "nexlore" / "00 Willkommen.md"
    changed.write_text("# Mine now\n", encoding="utf-8")
    second = client.post("/api/settings/guide", json={"language": "en"})
    assert second.json() == {"space": "nexlore 2"}
    assert changed.read_text(encoding="utf-8") == "# Mine now\n"
    assert (vault / "nexlore 2" / "00 Welcome.md").is_file()
    member = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-member00"})
    sign_in(member, make_account("anna"))
    assert member.post("/api/settings/guide", json={}).status_code == 403
    # Not in anna's spaces: the operator's alone.
    assert member.get("/api/spaces").json() == []


def test_both_languages_carry_the_same_notes_pictures_and_tasks() -> None:
    def shape(language: str) -> tuple[int, int, int, int]:
        root = guide.ROOT / language
        notes = [path for path in root.rglob("*.md")]
        pictures = [path for path in root.rglob("*") if path.suffix in (".webp", ".png")]
        tasks = sum(path.read_text(encoding="utf-8").count("- [") for path in notes)
        days = sum(len(re.findall("⟦", path.read_text(encoding="utf-8"))) for path in notes)
        return len(notes), len(pictures), tasks, days

    assert shape("de") == shape("en")


def test_days_are_filled_in_from_the_day_it_is_made() -> None:
    assert guide.fill("due 📅 ⟦+0⟧, later ⟦+10⟧, {{date}} stays", date(2026, 12, 25)) == "due 📅 2026-12-25, later 2027-01-04, {{date}} stays"


def test_switched_off_the_first_start_makes_nothing(client: TestClient, vault: Path) -> None:
    assert get_settings().welcome_guide is False
    assert client.post("/api/setup", json={"code": SETUP_CODE, "name": "boss", "password": PASSWORD, "language": "de"}).status_code == 200
    assert not (vault / "nexlore").exists()
