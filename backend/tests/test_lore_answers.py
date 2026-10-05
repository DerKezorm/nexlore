# ruff: noqa: F811
# The fixtures of test_lore.py are used by name here (pytest finds them through the import).
"""What happens with an answer of Lore: saved as a note of its own (its sources as links, where one may write), or,
for a conversation about a note, proposed for that note, to be compared and taken over like any proposal. Same world
as ``test_lore.py``; always against a stand-in service."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Proposal, Version

from .test_ai import Service
from .test_lore import STRATEGY, World, ask, note, service, world  # noqa: F401

ANSWER = "Stündlich als Snapshots [1], die Fotos jede Nacht [2]. Siehe [9].\n\n!missing: wann die Kopie zuletzt geprüft wurde"
REVISED = STRATEGY + "\n## Prüfen\n\n- [ ] Offsite-Kopie prüfen\n"


def answering(service: Service, *, revised: str = REVISED) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        from .test_ai_shared import flowing

        body = json.loads(request.content)
        if body["messages"][0]["content"].startswith("You change a note"):
            return flowing(revised)
        return flowing(ANSWER)

    service.answer = answer


def last_answer(client: TestClient, got: list[tuple[str, Any]]) -> tuple[int, int]:
    done = got[-1][1]
    return done["conversation"], done["message"]


def test_an_answer_becomes_a_note_next_to_its_first_source_with_links_to_every_source(
    world: World, service: Service, vault: Path
) -> None:
    answering(service)
    talk, message = last_answer(world.anna, ask(world.anna, "Wie oft machen wir Backups?"))
    saved = world.anna.post(f"/api/lore/conversations/{talk}/note", json={"message": message})
    assert saved.status_code == 201, saved.text
    path = saved.json()["path"]
    assert path.startswith("Wissen/") and path.endswith(".md")
    text = (vault / path).read_text(encoding="utf-8")
    assert "> [!question] Wie oft machen wir Backups?" in text
    assert "Snapshots [[Wissen/Backup-Strategie|1]]" in text
    # A number that is no source stays as it was.
    assert "Siehe [9]." in text
    assert "> [!warning] wann die Kopie zuletzt geprüft wurde" in text and "!missing" not in text
    assert "## Sources" in text and "1. [[Wissen/Backup-Strategie|Backup-Strategie" in text
    assert "title: 'Lore: Wie oft machen wir Backups?'" in text or 'title: "Lore: Wie oft machen wir Backups?"' in text
    with SessionLocal() as db:
        sources = list(db.scalars(select(Version.source).order_by(Version.id.desc()).limit(1)))
    assert sources == ["lore"]


def test_a_reader_saves_where_they_may_write_or_is_told_there_is_nowhere(world: World, service: Service) -> None:
    answering(service)
    talk, message = last_answer(world.bob, ask(world.bob, "Wie oft machen wir Backups?"))
    nowhere = world.bob.post(f"/api/lore/conversations/{talk}/note", json={"message": message})
    assert (nowhere.status_code, nowhere.json()["detail"]["code"]) == (409, "lore_nowhere")
    assert world.bob.post("/api/spaces", json={"name": "Bob"}).status_code == 201
    saved = world.bob.post(f"/api/lore/conversations/{talk}/note", json={"message": message})
    assert saved.status_code == 201 and saved.json()["path"].startswith("Bob/")


def test_only_a_written_answer_of_the_own_conversation_is_saved(world: World, service: Service) -> None:
    answering(service)
    talk, message = last_answer(world.anna, ask(world.anna, "Wie oft machen wir Backups?"))
    assert world.bob.post(f"/api/lore/conversations/{talk}/note", json={"message": message}).status_code == 404
    assert world.anna.post(f"/api/lore/conversations/{talk}/note", json={"message": message - 1}).status_code == 404
    service.answer = lambda request: httpx.Response(401, json={"error": {"message": "no"}})
    ask(world.anna, "Und noch einmal?", conversation=talk)
    failed = world.anna.get(f"/api/lore/conversations/{talk}").json()["messages"][-1]["id"]
    assert world.anna.post(f"/api/lore/conversations/{talk}/note", json={"message": failed}).status_code == 404


def test_an_answer_about_a_note_is_proposed_for_it_and_taken_over_like_any_proposal(
    world: World, service: Service, vault: Path
) -> None:
    answering(service)
    talk, message = last_answer(world.anna, ask(world.anna, "Was fehlt hier?", note="Wissen/Backup-Strategie.md"))
    before = (vault / "Wissen/Backup-Strategie.md").read_bytes()
    proposed = world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": message})
    assert proposed.status_code == 201, proposed.text
    assert proposed.json()["path"] == "Wissen/Backup-Strategie.md"
    # Nothing changed yet: it waits on the note.
    assert (vault / "Wissen/Backup-Strategie.md").read_bytes() == before
    sent = json.loads(service.requests[-1].content)
    assert sent["messages"][0]["content"].startswith("You change a note")
    assert "Alles, was zählt" in sent["messages"][1]["content"] and ANSWER in sent["messages"][1]["content"]
    waiting = world.anna.get("/api/proposals/note", params={"path": "Wissen/Backup-Strategie.md"}).json()
    assert [(item["lore"], item["by"], item["message"]) for item in waiting] == [
        (True, "anna", "Lore: Was fehlt hier?"),
    ]
    taken = world.anna.post(f"/api/proposals/{waiting[0]['id']}/take")
    assert taken.status_code == 200, taken.text
    assert (vault / "Wissen/Backup-Strategie.md").read_text(encoding="utf-8").endswith("- [ ] Offsite-Kopie prüfen\n")


def test_a_readers_proposal_from_lore_waits_for_a_writer(world: World, service: Service) -> None:
    answering(service)
    talk, message = last_answer(world.bob, ask(world.bob, "Was fehlt hier?", note="Wissen/Backup-Strategie.md"))
    assert world.bob.post(f"/api/lore/conversations/{talk}/propose", json={"message": message}).status_code == 201
    waiting = world.anna.get("/api/proposals/note", params={"path": "Wissen/Backup-Strategie.md"}).json()
    assert [(item["lore"], item["by"]) for item in waiting] == [(True, "bob")]
    assert world.bob.post(f"/api/proposals/{waiting[0]['id']}/take").status_code in (403, 404)


def test_a_proposal_needs_a_note_and_a_change(world: World, service: Service) -> None:
    answering(service)
    talk, message = last_answer(world.anna, ask(world.anna, "Wie oft machen wir Backups?"))
    refused = world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": message})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "lore_not_about_a_note")
    answering(service, revised="```markdown\n" + STRATEGY + "```")
    talk, message = last_answer(world.anna, ask(world.anna, "Was fehlt hier?", note="Wissen/Backup-Strategie.md"))
    same = world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": message})
    assert (same.status_code, same.json()["detail"]["code"]) == (409, "lore_nothing_to_change")
    with SessionLocal() as db:
        assert db.scalar(select(Proposal.id).limit(1)) is None


def test_a_note_with_crlf_keeps_its_line_endings_in_the_proposal(world: World, service: Service, vault: Path) -> None:
    note(world.anna, "Wissen", "Fenster", "# Fenster\r\n\r\nZwei Flügel.\r\n")
    answering(service, revised="# Fenster\n\nZwei Flügel.\n\nDichtung neu.\n")
    talk, message = last_answer(world.anna, ask(world.anna, "Was fehlt hier?", note="Wissen/Fenster.md"))
    assert world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": message}).status_code == 201
    with SessionLocal() as db:
        content = db.scalar(select(Proposal.content))
    assert content == "# Fenster\r\n\r\nZwei Flügel.\r\n\r\nDichtung neu.\r\n".encode()


def test_from_the_corner_an_answer_is_proposed_for_the_note_open_there(world: World, service: Service) -> None:
    answering(service)
    # Asked without a note, then the window was opened on one: the proposal goes to that note.
    talk, message = last_answer(world.anna, ask(world.anna, "Wie oft machen wir Backups?"))
    proposed = world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": message, "note": "Wissen/ZFS-Pool.md"})
    assert proposed.status_code == 201, proposed.text
    assert proposed.json()["path"] == "Wissen/ZFS-Pool.md"
    assert "Zwei Platten im Spiegel" in json.loads(service.requests[-1].content)["messages"][1]["content"]
    # Begun at one note, the window now open on another: the one open counts.
    talk, message = last_answer(world.anna, ask(world.anna, "Was fehlt hier?", note="Wissen/Backup-Strategie.md"))
    other = world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": message, "note": "Wissen/ZFS-Pool.md"})
    assert other.status_code == 201 and other.json()["path"] == "Wissen/ZFS-Pool.md"


def test_a_proposal_for_a_note_one_may_not_read_is_refused_like_a_missing_one(world: World, service: Service) -> None:
    answering(service)
    talk, message = last_answer(world.bob, ask(world.bob, "Wie oft machen wir Backups?"))
    hidden = world.bob.post(f"/api/lore/conversations/{talk}/propose", json={"message": message, "note": "Privat/Gehalt.md"})
    unknown = world.bob.post(f"/api/lore/conversations/{talk}/propose", json={"message": message, "note": "Privat/Nichts.md"})
    assert (hidden.status_code, hidden.json()) == (unknown.status_code, unknown.json())
    assert hidden.status_code == 404
    # A note that is gone from a space one may read: not found too, not "the conversation is about no note".
    gone = world.bob.post(f"/api/lore/conversations/{talk}/propose", json={"message": message, "note": "Wissen/Nichts.md"})
    assert (gone.status_code, gone.json()) == (hidden.status_code, hidden.json())
    with SessionLocal() as db:
        assert db.scalar(select(Proposal.id).limit(1)) is None
