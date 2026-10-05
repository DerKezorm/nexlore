# ruff: noqa: F811
# The fixtures of test_lore.py are used by name here (pytest finds them through the import).
"""Lore looks further herself when the model can call tools (L6): search_notes and read_source, a few rounds at most,
the last one without tools so that she must answer; a model that turns tools down is asked again without and
remembered. Every round looks only where the asker may read. Always against a stand-in service."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services import ai, lore

from .test_ai import Service
from .test_ai_shared import flowing
from .test_lore import World, ask, service, world  # noqa: F401


@pytest.fixture(autouse=True)
def _forget_tools() -> Iterator[None]:
    ai._takes_tools.clear()
    yield
    ai._takes_tools.clear()


def calling(name: str, arguments: dict[str, Any]) -> httpx.Response:
    """A flowing answer that asks for a tool, its arguments in two pieces as services send them."""
    raw = json.dumps(arguments)
    pieces = [
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-1", "type": "function",
                                                "function": {"name": name, "arguments": raw[:5]}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": raw[5:]}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ]
    lines = [f"data: {json.dumps(piece)}" for piece in pieces] + ["data: [DONE]"]
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="\n\n".join(lines).encode())


def bodies(service: Service) -> list[dict[str, Any]]:
    return [json.loads(request.content) for request in service.requests]


def test_lore_searches_further_and_cites_what_she_found(world: World, service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if not any(message["role"] == "tool" for message in body["messages"]):
            return calling("search_notes", {"words": "Paperless zurückgeholt"})
        return flowing("Die Übung dauerte 38 Minuten [2].")

    service.answer = answer
    # Nothing of the question is in the index: what she cites, she looked up herself.
    got = ask(world.anna, "Wie lange dauerte es?")
    assert got[0][1]["sources"] == []
    names = [name for name, _ in got]
    assert names[0] == "start" and "sources" in names and names[-1] == "done"
    first, second = bodies(service)
    assert first["tools"] == lore.TOOLS and "search_notes finds more" in first["messages"][0]["content"]
    tool = second["messages"][-1]
    assert tool["role"] == "tool" and tool["tool_call_id"] == "call-1" and "38 Minuten" in tool["content"]
    assert second["messages"][-2]["tool_calls"][0]["function"] == {
        "name": "search_notes", "arguments": json.dumps({"words": "Paperless zurückgeholt"}),
    }
    found = dict(got)["sources"]
    assert [source["title"] for source in found["sources"]] == ["Restore-Übung"]
    assert found["trace"]["steps"] == [{"tool": "search", "words": "Paperless zurückgeholt", "found": 1}]
    talk = got[-1][1]["conversation"]
    kept = world.anna.get(f"/api/lore/conversations/{talk}").json()["messages"][1]
    assert kept["text"] == "Die Übung dauerte 38 Minuten [2]."
    assert [source["title"] for source in kept["sources"]] == ["Restore-Übung"]


def test_a_source_is_read_whole_and_only_one_that_is_there(world: World, service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        tools = [message for message in body["messages"] if message["role"] == "tool"]
        if not tools:
            return calling("read_source", {"n": 1})
        if len(tools) == 1:
            return calling("read_source", {"n": 99})
        return flowing("Fertig [1].")

    service.answer = answer
    ask(world.anna, "Was steht zur Backup-Strategie?")
    last = bodies(service)[-1]["messages"]
    results = [message["content"] for message in last if message["role"] == "tool"]
    assert "Brot backen" in results[0] and results[0].startswith("[1] Backup-Strategie")
    assert results[1] == "There is no such source."


def test_a_search_of_lore_looks_only_where_the_asker_may_read(world: World, service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if not any(message["role"] == "tool" for message in body["messages"]):
            return calling("search_notes", {"words": "Gehaltsliste Betrag"})
        return flowing("Nichts gefunden.")

    service.answer = answer
    ask(world.bob, "Wie hoch ist das Gehalt?", spaces=[1, 2, 3, 4, 5])
    for body in bodies(service):
        assert "4711" not in json.dumps(body, ensure_ascii=False)
    assert bodies(service)[-1]["messages"][-1]["content"] == "Nothing new was found for these words."


def test_after_the_last_round_lore_must_answer_without_tools(world: World, service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "tools" in body:
            return calling("search_notes", {"words": "noch mehr"})
        return flowing("Genug gesucht.")

    service.answer = answer
    got = ask(world.anna, "Wie oft machen wir Backups?")
    sent = bodies(service)
    assert len(sent) == lore.MAX_STEPS + 1
    assert all("tools" in body for body in sent[:-1]) and "tools" not in sent[-1]
    assert "search_notes finds more" not in sent[-1]["messages"][0]["content"]
    assert "".join(data["t"] for name, data in got if name == "delta") == "Genug gesucht."


def test_a_model_without_tools_is_asked_again_without_and_remembered(world: World, service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "tools" in body:
            return httpx.Response(400, json={"error": {"message": "This model does not support tools."}})
        return flowing("Stündlich [1].")

    service.answer = answer
    got = ask(world.anna, "Wie oft machen wir Backups?")
    assert got[-1][0] == "done"
    assert ["tools" in body for body in bodies(service)] == [True, False]
    ask(world.anna, "Und die Fotos?")
    assert ["tools" in body for body in bodies(service)] == [True, False, False]


def test_the_rounds_of_one_question_count_once(world: World, service: Service, client: TestClient) -> None:
    assert client.put("/api/settings", json={"ai_per_minute": 1}).status_code == 200
    rounds = iter([calling("search_notes", {"words": "Fotos"}), calling("search_notes", {"words": "Pool"})])
    service.answer = lambda request: next(rounds, None) or flowing("Fertig.")
    got = ask(world.anna, "Wie oft machen wir Backups?")
    assert got[-1][0] == "done" and len(service.requests) == 3
    again = ask(world.anna, "Noch eine?")
    assert again[-1] == ("error", {"code": "ai_too_often", "values": {}})


def test_what_she_finds_further_is_numbered_after_what_she_had(world: World, service: Service) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if not any(message["role"] == "tool" for message in body["messages"]):
            return calling("search_notes", {"words": "Paperless zurückgeholt"})
        return flowing("Stündlich [1], zuletzt geübt [2].")

    service.answer = answer
    got = ask(world.anna, "Wie oft gibt es Snapshots?")
    had = got[0][1]["sources"]
    assert had and [source["n"] for source in had] == list(range(1, len(had) + 1))
    found = dict(got)["sources"]["sources"]
    added = [source for source in found if source["title"] == "Restore-Übung"]
    assert [source["n"] for source in added] == [len(had) + 1]
    assert [source["n"] for source in found] == list(range(1, len(found) + 1))
