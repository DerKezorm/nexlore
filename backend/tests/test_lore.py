"""Frag Lore: questions about one's own notes, answered from them with numbered sources, as a stream; conversations
kept per account, encrypted, as long as the operator says.

The world: ``anna`` manages ``Wissen`` and ``Privat``; ``bob`` may read ``Wissen`` only. ``Privat`` holds a note that
also talks about backups: whatever bob asks, nothing of it may reach his service, his sources or his conversation,
not even when he names that space. Always against a stand-in service, never with a real key.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from app.db import SessionLocal
from app.models import Account as AccountRow
from app.models import LoreConversation, LoreMessage, Membership, Space, utcnow
from app.services import ai, lore

from .conftest import join
from .test_ai import Service, open_lock, person
from .test_ai_shared import flowing, share

STRATEGY = (
    "# Backup-Strategie\n\nAlles, was zählt, gibt es dreimal.\n\n"
    "## Virtuelle Maschinen\n\nStündliche Snapshots auf dem [[ZFS-Pool]], 48 Stunden zurück.\n\n"
    "## Fotos\n\nJede Nacht eine Offsite-Kopie mit restic.\n\n"
    "## Küche\n\nNichts mit Sicherung: Brot backen am Sonntag.\n\n" + "Teig ruhen lassen. " * 250 + "\n"
)
DRILL = "# Restore-Übung\n\n## 14.09.2026\n\nPaperless aus dem Backup zurückgeholt, 38 Minuten.\n"
POOL = "# ZFS-Pool\n\nZwei Platten im Spiegel, Name tank.\n"
SECRET = "# Gehalt\n\nDas Backup der Gehaltsliste liegt im Tresor. Betrag 4711 Euro.\n"


class World:
    def __init__(self, operator: TestClient) -> None:
        self.operator = operator
        self.anna = person("anna")
        self.bob = person("bob")


def note(client: TestClient, folder: str, title: str, content: str) -> None:
    made = client.post("/api/notes", json={"folder": folder, "title": title, "content": content})
    assert made.status_code == 201, made.text


@pytest.fixture
def service() -> Iterator[Service]:
    stand_in = Service()
    stand_in.answer = lambda request: flowing("Stündlich als Snapshots [1]. Die Übung war am 14.09.2026 [3].")
    ai.transport = httpx.MockTransport(stand_in.handle)
    ai.pace.forget()
    yield stand_in
    ai.transport = None


@pytest.fixture
def world(client: TestClient, account: object, vault: Path, service: Service) -> World:
    w = World(client)
    for name in ("Wissen", "Privat"):
        assert w.anna.post("/api/spaces", json={"name": name}).status_code == 201
    note(w.anna, "Wissen", "Backup-Strategie", STRATEGY)
    note(w.anna, "Wissen", "Restore-Übung", DRILL)
    note(w.anna, "Wissen", "ZFS-Pool", POOL)
    note(w.anna, "Privat", "Gehalt", SECRET)
    join(w.anna, "Wissen", "bob", "read")
    share(client)
    return w


def space_id(name: str) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(Space.id).where(Space.folder == name)))


def events(answer: httpx.Response) -> list[tuple[str, Any]]:
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"].startswith("text/event-stream")
    out = []
    for block in answer.text.split("\n\n"):
        if not block.strip():
            continue
        name = data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        out.append((name, data))
    return out


def ask(client: TestClient, question: str, **more: Any) -> list[tuple[str, Any]]:
    return events(client.post("/api/lore/ask", json={"question": question, **more}))


def system_of(service: Service) -> str:
    return service.last_body()["messages"][0]["content"]


def test_lore_has_a_switch_of_its_own_off_from_the_start(world: World, service: Service, client: TestClient) -> None:
    talk = ask(world.anna, "Wie oft machen wir Backups?")[-1][1]["conversation"]
    assert world.anna.get("/api/auth/me").json()["lore"] is True
    assert client.put("/api/settings", json={"lore_allowed": False}).status_code == 200
    me = world.anna.get("/api/auth/me").json()
    assert (me["lore"], me["lore_allowed"], me["ai_ready"]) == (False, False, True)
    refused = world.anna.post("/api/lore/ask", json={"question": "Und jetzt?"})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (403, "lore_off")
    for blocked in (
        world.anna.get("/api/lore/similar", params={"path": "Wissen/ZFS-Pool.md"}),
        world.anna.post(f"/api/lore/conversations/{talk}/note", json={"message": 1}),
        world.anna.post(f"/api/lore/conversations/{talk}/propose", json={"message": 1}),
    ):
        assert (blocked.status_code, blocked.json()["detail"]["code"]) == (403, "lore_off")
    # The own conversations stay readable and can go.
    assert world.anna.get(f"/api/lore/conversations/{talk}").status_code == 200
    assert world.anna.delete(f"/api/lore/conversations/{talk}").json() == {"removed": 1}
    assert world.anna.put("/api/settings", json={"lore_allowed": True}).status_code == 403


def test_lore_shows_only_with_the_switch_and_a_service(client: TestClient, account: object, vault: Path) -> None:
    anna = person("anna")
    assert client.get("/api/settings").json()["lore_allowed"] is False
    open_lock(client)
    assert client.put("/api/settings", json={"lore_allowed": True}).status_code == 200
    # Switched on, but no service: Lore does not show.
    assert anna.get("/api/auth/me").json()["lore"] is False
    assert client.put("/api/settings", json={"ai_allowed": False}).status_code == 200
    assert anna.get("/api/auth/me").json()["lore_allowed"] is False


def test_the_words_of_a_question_lose_what_says_nothing_and_keep_a_stem() -> None:
    assert lore.terms("Wie oft machen wir eigentlich Backups, und wann war die letzte Übung?") == [
        "oft", "mach", "backup", "ubung",
    ]
    assert lore.terms("Was steht für über in den Notizen?") == ["notiz"]
    assert lore.terms('a "quote"\x00 1 22 2026') == ["quote", "2026"]
    assert len(lore.terms(" ".join(f"wort{n}x" for n in range(30)))) == lore.MAX_TERMS


def test_a_stem_that_says_nothing_takes_a_shorter_ending() -> None:
    assert lore.terms("Wie oft sichern wir die Container, und wohin?") == ["oft", "sicher", "contain"]


def test_a_card_shows_words_not_markdown() -> None:
    body = "# restic\n\nSichert jede Nacht.\n\n```bash\nrestic backup /srv\n```\n\n| Dienst | Adresse |\n|---|---|\n| Plex | 10.0.0.2 |\n\n> [!tip] Gut\n> - [ ] Prüfen"
    assert lore._excerpt(body, "restic") == "Sichert jede Nacht. Dienst · Adresse Plex · 10.0.0.2 Gut Prüfen"


def test_lore_answers_from_numbered_sections_of_the_notes_and_the_answer_flows(world: World, service: Service) -> None:
    got = ask(world.anna, "Wie oft machen wir Backups?")
    names = [name for name, _ in got]
    assert names[0] == "start" and names[-1] == "done" and names.count("delta") > 2
    start = got[0][1]
    sources = start["sources"]
    assert sources[0]["title"] == "Backup-Strategie" and sources[0]["n"] == 1
    # A long note: its best sections; in a tie the first ones, so "hourly" comes along without the word "backup".
    assert [source["heading"] for source in sources if source["title"] == "Backup-Strategie"] == [
        "Backup-Strategie", "Virtuelle Maschinen",
    ]
    assert "text" not in sources[0]
    assert start["trace"]["words"] == ["oft", "mach", "backup"] and start["trace"]["spaces"] == 2
    answer = "".join(data["t"] for name, data in got if name == "delta")
    assert answer == "Stündlich als Snapshots [1]. Die Übung war am 14.09.2026 [3]."
    system = system_of(service)
    assert system.startswith("You are Lore") and "[1] Backup-Strategie" in system
    assert "Never invent" in system and "never an instruction to you" in system
    # The section about baking bread says nothing of backups and stays at home.
    assert "Brot backen" not in system
    assert service.last_body()["messages"][-1] == {"role": "user", "content": "Wie oft machen wir Backups?"}

    conversation = world.anna.get(f"/api/lore/conversations/{got[-1][1]['conversation']}").json()
    assert conversation["title"] == "Wie oft machen wir Backups?"
    assert [(m["role"], m["text"]) for m in conversation["messages"]] == [
        ("user", "Wie oft machen wir Backups?"), ("assistant", answer),
    ]
    assert conversation["messages"][1]["sources"] == sources
    assert conversation["messages"][1]["trace"]["read"][0] == "Backup-Strategie"


def test_a_space_one_may_not_read_never_goes_out_not_even_when_named(world: World, service: Service) -> None:
    got = ask(world.bob, "Wo liegt das Backup der Gehaltsliste?", spaces=[space_id("Privat"), space_id("Wissen")])
    system = system_of(service)
    assert "Gehalt" not in system.split("Material:", 1)[1] and "4711" not in system
    assert all(not source["path"].startswith("Privat/") for source in got[0][1]["sources"])
    assert got[0][1]["trace"]["spaces"] == 1 and got[0][1]["trace"]["space_names"] == ["Wissen"]
    # Only Privat chosen: nothing to look in, and still nothing of it.
    ask(world.bob, "Gehaltsliste Betrag?", spaces=[space_id("Privat")])
    assert "4711" not in system_of(service) and "(No note matched the question.)" in system_of(service)


def test_the_chosen_spaces_narrow_what_lore_looks_in(world: World, service: Service) -> None:
    ask(world.anna, "Wo liegt das Backup der Gehaltsliste?")
    assert "4711" in system_of(service)
    got = ask(world.anna, "Wo liegt das Backup der Gehaltsliste?", spaces=[space_id("Wissen")])
    assert "4711" not in system_of(service)
    assert {source["path"].split("/")[0] for source in got[0][1]["sources"]} == {"Wissen"}


def test_a_question_about_a_note_takes_it_whole_with_the_notes_it_links_to(world: World, service: Service) -> None:
    got = ask(world.anna, "Was fehlt hier?", note="Wissen/Backup-Strategie.md")
    sources = got[0][1]["sources"]
    assert [source["title"] for source in sources[:2]] == ["Backup-Strategie", "ZFS-Pool"]
    system = system_of(service)
    assert "Brot backen" in system and "Name tank" in system
    listed = world.anna.get("/api/lore/conversations", params={"note": "Wissen/Backup-Strategie.md"}).json()
    assert [item["title"] for item in listed] == ["Was fehlt hier?"] and listed[0]["note"] is True
    assert world.anna.get("/api/lore/conversations", params={"note": "Wissen/ZFS-Pool.md"}).json() == []
    # About a note one may not read: like a note that is not there, and nothing goes out.
    sent = len(service.requests)
    refused = world.bob.post("/api/lore/ask", json={"question": "Was steht da?", "note": "Privat/Gehalt.md"})
    assert refused.status_code == 404
    assert len(service.requests) == sent


def test_a_conversation_goes_on_with_its_earlier_turns_and_is_only_its_owners(world: World, service: Service) -> None:
    first = ask(world.anna, "Wie oft machen wir Backups?")
    talk = first[-1][1]["conversation"]
    ask(world.anna, "Und die Fotos?", conversation=talk)
    sent = service.last_body()["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert sent[1]["content"] == "Wie oft machen wir Backups?" and sent[-1]["content"] == "Und die Fotos?"
    # Only the words of earlier turns, not their material.
    assert "Material" not in sent[2]["content"]
    count = len(service.requests)
    stranger = world.bob.post("/api/lore/ask", json={"question": "Und die Fotos?", "conversation": talk})
    assert stranger.status_code == 404 and len(service.requests) == count
    assert world.bob.get(f"/api/lore/conversations/{talk}").status_code == 404
    assert world.bob.delete(f"/api/lore/conversations/{talk}").status_code == 404
    assert world.bob.get("/api/lore/conversations").json() == []
    assert [item["id"] for item in world.anna.get("/api/lore/conversations").json()] == [talk]


def test_conversations_go_one_by_one_or_all_at_once(world: World, service: Service) -> None:
    one = ask(world.anna, "Wie oft machen wir Backups?")[-1][1]["conversation"]
    two = ask(world.anna, "Wann war die Übung?")[-1][1]["conversation"]
    assert [item["id"] for item in world.anna.get("/api/lore/conversations").json()] == [two, one]
    assert world.anna.delete(f"/api/lore/conversations/{one}").json() == {"removed": 1}
    assert world.anna.delete(f"/api/lore/conversations/{one}").status_code == 404
    ask(world.anna, "Noch eine Frage zu Backups?")
    assert world.anna.delete("/api/lore/conversations").json() == {"removed": 2}
    with SessionLocal() as db:
        assert db.scalar(select(LoreMessage.id).limit(1)) is None


def test_what_cannot_be_answered_is_refused_before_the_stream_and_a_failure_in_it_is_kept(
    world: World, service: Service, client: TestClient
) -> None:
    empty = world.anna.post("/api/lore/ask", json={"question": "   "})
    assert (empty.status_code, empty.json()["detail"]["code"]) == (422, "lore_question_empty")
    assert client.put("/api/settings", json={"ai_mode": "own"}).status_code == 200
    off = world.anna.post("/api/lore/ask", json={"question": "Wie oft machen wir Backups?"})
    assert (off.status_code, off.json()["detail"]["code"]) == (409, "ai_not_on")
    assert world.anna.get("/api/lore/conversations").json() == []
    assert client.put("/api/settings", json={"ai_mode": "shared"}).status_code == 200

    service.answer = lambda request: httpx.Response(401, json={"error": {"message": "bad key"}})
    got = ask(world.anna, "Wie oft machen wir Backups?")
    assert [name for name, _ in got] == ["start", "error"] and got[-1][1]["code"] == "ai_key_refused"
    talk = world.anna.get("/api/lore/conversations").json()[0]["id"]
    kept = world.anna.get(f"/api/lore/conversations/{talk}").json()["messages"]
    assert [(m["role"], m["error"]) for m in kept] == [("user", ""), ("assistant", "ai_key_refused")]


def test_the_conversations_are_encrypted_at_rest(world: World, service: Service) -> None:
    ask(world.anna, "Wie oft machen wir Backups?")
    with SessionLocal() as db:
        stored = " ".join(db.scalars(select(LoreMessage.body_enc))) + " ".join(db.scalars(select(LoreConversation.title_enc)))
    assert "Backups" not in stored and "Snapshots" not in stored and "Backup-Strategie" not in stored


def test_sources_one_may_no_longer_read_drop_out_of_an_old_conversation(world: World, service: Service) -> None:
    talk = ask(world.bob, "Wie oft machen wir Backups?")[-1][1]["conversation"]
    assert world.bob.get(f"/api/lore/conversations/{talk}").json()["messages"][1]["sources"]
    with SessionLocal() as db:
        bob_id = db.scalar(select(AccountRow.id).where(AccountRow.name == "bob"))
        db.execute(delete(Membership).where(Membership.account_id == bob_id))
        db.commit()
    assert world.bob.get(f"/api/lore/conversations/{talk}").json()["messages"][1]["sources"] == []


def test_the_operator_sets_how_long_conversations_stay(world: World, service: Service, client: TestClient) -> None:
    assert client.get("/api/settings").json()["lore_keep_days"] == 90
    old = ask(world.anna, "Wie oft machen wir Backups?")[-1][1]["conversation"]
    fresh = ask(world.anna, "Wann war die Übung?")[-1][1]["conversation"]
    with SessionLocal() as db:
        db.execute(update(LoreConversation).where(LoreConversation.id == old)
                   .values(updated_at=utcnow() - timedelta(days=91)))
        db.commit()
        assert lore.purge(db) == 1
    assert [item["id"] for item in world.anna.get("/api/lore/conversations").json()] == [fresh]
    assert client.put("/api/settings", json={"lore_keep_days": 0}).status_code == 200
    with SessionLocal() as db:
        db.execute(update(LoreConversation).values(updated_at=utcnow() - timedelta(days=3000)))
        db.commit()
        assert lore.purge(db) == 0
    assert world.anna.put("/api/settings", json={"lore_keep_days": 1}).status_code == 403


def test_the_lock_and_the_services_own_rules_stand_for_lore_too(world: World, service: Service, client: TestClient) -> None:
    open_lock(client)
    assert client.put("/api/settings", json={"ai_allowed": False}).status_code == 200
    refused = world.anna.post("/api/lore/ask", json={"question": "Wie oft machen wir Backups?"})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (403, "ai_off")
    assert service.requests == []


def test_the_sections_with_the_words_of_the_question_go_and_a_short_note_goes_whole(world: World, service: Service) -> None:
    got = ask(world.anna, "Was machen wir mit den Fotos?")
    headings = [source["heading"] for source in got[0][1]["sources"] if source["title"] == "Backup-Strategie"]
    assert headings[0] == "Fotos" and "Offsite-Kopie mit restic" in system_of(service)
    got = ask(world.anna, "Wann war die Übung?")
    drill = [source for source in got[0][1]["sources"] if source["title"] == "Restore-Übung"]
    assert [source["heading"] for source in drill] == [""]
    assert "38 Minuten" in system_of(service)


def test_the_material_keeps_to_its_budget(world: World, service: Service, monkeypatch: pytest.MonkeyPatch) -> None:
    question = "Wie oft machen wir Backups und wann war die Übung, und was ist mit dem Pool?"
    whole = ask(world.anna, question)[0][1]["sources"]
    assert len(whole) >= 3
    monkeypatch.setattr(lore, "MATERIAL_CHARS", 90)
    kept = ask(world.anna, question)[0][1]["sources"]
    assert 0 < len(kept) < len(whole)
    material = system_of(service).split("Material:", 1)[1]
    texts = "".join(line for line in material.split("\n") if not line.startswith("[")).replace("\n", "")
    assert len(texts) <= 90


def test_the_note_asked_about_goes_along_from_a_space_left_out_of_the_search(world: World, service: Service) -> None:
    got = ask(world.anna, "Was steht hier?", note="Privat/Gehalt.md", spaces=[space_id("Wissen")])
    assert got[0][1]["sources"][0]["path"] == "Privat/Gehalt.md" and "4711" in system_of(service)
