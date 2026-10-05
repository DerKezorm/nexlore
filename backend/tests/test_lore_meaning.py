# ruff: noqa: F811
# The fixtures of test_lore.py are used by name here (pytest finds them through the import).
"""Finding notes by their meaning (L7): only with one service for all and a model for it; vectors read in a little at
a time and again when a note changes; a question finds notes that mean it although its words are not in them; similar
notes beside a note; and never a note from a space the asker may not read. The stand-in turns texts into vectors by
the words they share, so "nearest" is predictable."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, LoreVector
from app.services import index, meaning, rights

from .test_ai import Service
from .test_ai_shared import flowing
from .test_lore import World, ask, note, service, world  # noqa: F401

DIMS = 64
#: Words the stand-in counts as one meaning: a question with "Wiederherstellung" lands near "restore" notes.
SAME = {"wiederherstellung": "restore", "zurückholen": "restore", "zurückgeholt": "restore", "restore": "restore",
        "übung": "restore"}


def vector_of(text: str) -> list[float]:
    numbers = [0.0] * DIMS
    for raw in text.lower().replace(".", " ").replace(",", " ").split():
        word = SAME.get(raw, raw)
        numbers[int(hashlib.md5(word.encode()).hexdigest(), 16) % DIMS] += 1.0
    return numbers


def answering(service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/embeddings"):
            texts = json.loads(request.content)["input"]
            return httpx.Response(200, json={"data": [{"index": i, "embedding": vector_of(text)}
                                                      for i, text in enumerate(texts)]})
        return flowing("Antwort [1].")

    service.answer = answer


@pytest.fixture
def meaningful(world: World, service: Service, client: TestClient) -> Iterator[World]:
    answering(service)
    assert client.put("/api/ai/shared", json={"embed_model": "embed-stand-in"}).status_code == 200
    with SessionLocal() as db:
        meaning.catch_up(db)
    yield world


def embedded(service: Service) -> list[str]:
    return [text for request in service.requests if request.url.path.endswith("/embeddings")
            for text in json.loads(request.content)["input"]]


def test_with_each_on_their_own_nothing_is_read_in(world: World, service: Service, client: TestClient) -> None:
    answering(service)
    assert client.put("/api/settings", json={"ai_mode": "own"}).status_code == 200
    assert client.put("/api/ai/shared", json={"embed_model": "embed-stand-in"}).status_code == 200
    with SessionLocal() as db:
        assert meaning.catch_up(db) == 0
    assert embedded(service) == []


def test_every_note_is_read_in_once_and_again_when_it_changes(meaningful: World, service: Service,
                                                              client: TestClient, vault: Path) -> None:
    sent = embedded(service)
    assert len(sent) == 4 and any(text.startswith("Gehalt\n") for text in sent)
    progress = client.get("/api/ai/shared").json()
    assert progress["meaning"] == {"done": 4, "total": 4} and progress["meaning_on"] is True
    with SessionLocal() as db:
        assert meaning.catch_up(db) == 0
    note(meaningful.anna, "Wissen", "Neu", "# Neu\n\nEtwas Neues.\n")
    with SessionLocal() as db:
        assert meaning.catch_up(db) == 1
    assert embedded(service)[-1].startswith("Neu\n")
    # A note changed outside: read in again, that one only.
    target = vault / "Wissen" / "ZFS-Pool.md"
    target.write_text("# ZFS-Pool\n\nDrei Platten jetzt.\n", encoding="utf-8")
    index.scan()
    with SessionLocal() as db:
        assert meaning.catch_up(db) == 1
    assert "Drei Platten jetzt." in embedded(service)[-1]
    # Another model: the old vectors go, everything is read in again.
    assert client.put("/api/ai/shared", json={"embed_model": "other"}).status_code == 200
    # Reading in starts at once, in the background; whatever it left is done here, after it.
    with SessionLocal() as db:
        meaning.catch_up(db)
    assert client.get("/api/ai/shared").json()["meaning"] == {"done": 5, "total": 5}
    with SessionLocal() as db:
        assert set(db.scalars(select(LoreVector.model))) == {"other"}


def test_a_question_finds_a_note_by_its_meaning_and_says_so(meaningful: World, service: Service,
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    # The stand-in's vectors are coarse: one shared word of ten is "near" here.
    monkeypatch.setattr(meaning, "NEAR", 0.1)
    # No word of the question is in "Restore-Übung", but "Wiederherstellung" means "restore" to the stand-in.
    got = ask(meaningful.anna, "Klappte die Wiederherstellung?")
    start = got[0][1]
    assert "Restore-Übung" in [source["title"] for source in start["sources"]]
    assert "Restore-Übung" in start["trace"]["meant"]
    assert embedded(service)[-1] == "Klappte die Wiederherstellung?"
    events = meaningful.anna.get("/api/ai/events").json()
    assert "lore_meaning" in [event["task"] for event in events]


def test_meaning_never_reaches_into_a_space_one_may_not_read(meaningful: World, service: Service) -> None:
    got = ask(meaningful.bob, "Gehalt Tresor Betrag")
    assert all(not source["path"].startswith("Privat/") for source in got[0][1]["sources"])
    with SessionLocal() as db:
        privat = db.scalar(select(LoreVector.file_id).limit(1))
    assert privat is not None
    near = meaningful.bob.get("/api/lore/similar", params={"path": "Wissen/Backup-Strategie.md"}).json()
    assert near["on"] is True and all(not item["path"].startswith("Privat/") for item in near["notes"])
    assert meaningful.bob.get("/api/lore/similar", params={"path": "Privat/Gehalt.md"}).status_code == 404


def test_a_question_takes_only_the_notes_close_to_the_best() -> None:
    found = [meaning.Near(1, 0.81), meaning.Near(2, 0.76), meaning.Near(3, 0.6), meaning.Near(4, 0.4)]
    assert [near.file_id for near in meaning.close_to_best(found)] == [1, 2]
    assert meaning.close_to_best([]) == []


def test_similar_notes_are_the_nearest_others(meaningful: World, service: Service) -> None:
    near = meaningful.anna.get("/api/lore/similar", params={"path": "Wissen/Restore-Übung.md"}).json()
    titles = [item["title"] for item in near["notes"]]
    assert "Restore-Übung" not in titles and len(titles) <= meaning.SIMILAR
    scores = [item["score"] for item in near["notes"]]
    assert scores == sorted(scores, reverse=True)


def test_without_a_model_lore_keeps_to_the_words(world: World, service: Service, client: TestClient) -> None:
    answering(service)
    assert client.get("/api/ai/shared").json()["meaning_on"] is False
    ask(world.anna, "Klappte die Wiederherstellung?")
    assert embedded(service) == []
    assert world.anna.get("/api/lore/similar", params={"path": "Wissen/Restore-Übung.md"}).json() == {
        "on": False, "notes": [],
    }


def test_a_failing_service_stops_reading_in_and_lore_still_answers(world: World, service: Service,
                                                                   client: TestClient) -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/embeddings"):
            return httpx.Response(404, json={"error": {"message": "no embeddings here"}})
        return flowing("Antwort [1].")

    service.answer = broken
    assert client.put("/api/ai/shared", json={"embed_model": "embed-stand-in"}).status_code == 200
    with SessionLocal() as db:
        assert meaning.catch_up(db) == 0
    got = ask(world.anna, "Wie oft machen wir Backups?")
    assert got[-1][0] == "done"


def test_vectors_are_normalised_and_bad_answers_are_refused(meaningful: World, service: Service) -> None:
    with SessionLocal() as db:
        row = db.scalars(select(LoreVector)).first()
        import numpy as np

        assert math.isclose(float(np.linalg.norm(np.frombuffer(row.vector, dtype=np.float32))), 1.0, rel_tol=1e-4)

    for odd in (
        [{"index": 0, "embedding": [1.0, 2.0]}],
        [{"index": 0, "embedding": [1.0, 2.0]}, {"index": 1, "embedding": [1.0]}],
    ):
        service.answer = lambda request, data=odd: httpx.Response(200, json={"data": data})
        with SessionLocal() as db, pytest.raises(meaning.MeaningError):
            meaning.embed(db, ["a", "b"])


def test_switching_the_model_off_takes_every_vector_away(meaningful: World, client: TestClient) -> None:
    with SessionLocal() as db:
        assert len(db.scalars(select(LoreVector)).all()) == 4
    assert client.put("/api/ai/shared", json={"embed_model": ""}).status_code == 200
    with SessionLocal() as db:
        assert db.scalars(select(LoreVector)).all() == []


def test_without_the_switch_of_ask_lore_nothing_is_read_in(world: World, service: Service, client: TestClient) -> None:
    answering(service)
    assert client.put("/api/settings", json={"lore_allowed": False}).status_code == 200
    assert client.put("/api/ai/shared", json={"embed_model": "embed-stand-in"}).status_code == 200
    with SessionLocal() as db:
        assert meaning.enabled(db) is False
        assert meaning.catch_up(db) == 0
    assert embedded(service) == []


def test_a_question_brings_only_the_notes_near_the_best_one(meaningful: World, monkeypatch: pytest.MonkeyPatch) -> None:
    # Every note counts as near: what is left out, the spread to the best one leaves out.
    monkeypatch.setattr(meaning, "NEAR", -1.0)
    with SessionLocal() as db:
        anna = db.scalar(select(Account).where(Account.name == "anna"))
        assert anna is not None
        spaces = set(rights.readable_ids(db, anna))
        found = meaning.question_near(db, anna, "Wiederherstellung Paperless", spaces, limit=10, leave_out=set())
    assert found and all(near.score >= found[0].score - meaning.SPREAD for near in found)
    with SessionLocal() as db:
        every = meaning.nearest(db, meaning.embed(db, ["Wiederherstellung Paperless"])[0], spaces, limit=10, leave_out=set())
    assert len(every) > len(found)


def test_every_call_to_the_service_checks_against_certificates_loaded_once(world: World, service: Service,
                                                                           client: TestClient,
                                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    """A client of its own loads the certificates again: under Windows 0.9 s for each batch of vectors and each
    question to Lore (measured 05.10.2026). Every client of the AI service gets the one context of ``ai.tls``."""
    answering(service)
    given: list[object] = []
    real = httpx.Client

    class Seen(real):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            given.append(kwargs.get("verify"))
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", Seen)
    assert client.put("/api/ai/shared", json={"embed_model": "embed-stand-in"}).status_code == 200
    with SessionLocal() as db:  # waits for the reading the card started, if it still runs
        meaning.catch_up(db)
    assert embedded(service)
    ask(client, "Wie oft läuft die Sicherung?")
    assert len(given) >= 2
    assert all(each is meaning.ai.tls() for each in given)
