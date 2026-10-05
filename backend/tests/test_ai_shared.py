"""One AI service for all (Frag Lore, design answer 05.10.2026) and answers that flow: the operator chooses "own" or
"shared", members then use the operator's service without seeing its address or key, their own accesses rest, and a
conversation hands its answer on piece by piece. Always against a stand-in service, never with a real key."""

from __future__ import annotations

import json
from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account as AccountRow
from app.services import ai

from .test_ai import KEY, NOTE, Service, open_lock, person, set_up

SHARED_KEY = "sk-shared-stand-in"


def flowing(text: str, *, usage: bool = True) -> httpx.Response:
    """A stand-in answer as a flowing service sends it: a line per piece, then the count, then the end."""
    lines = [
        "data: " + json.dumps({"choices": [{"delta": {"content": text[start : start + 5]}}]})
        for start in range(0, len(text), 5)
    ]
    lines.insert(0, ": a comment the reader skips")
    lines.insert(1, "data: " + json.dumps({"choices": [{"delta": {"role": "assistant"}}]}))
    if usage:
        lines.append("data: " + json.dumps({"choices": [], "usage": {"prompt_tokens": 40, "completion_tokens": 9}}))
    lines.append("data: [DONE]")
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="\n\n".join(lines).encode())


@pytest.fixture
def service() -> Iterator[Service]:
    stand_in = Service()
    ai.transport = httpx.MockTransport(stand_in.handle)
    ai.pace.forget()
    yield stand_in
    ai.transport = None


def share(operator: TestClient, **values: str) -> None:
    open_lock(operator)
    assert operator.put("/api/settings", json={"ai_mode": "shared", "lore_allowed": True}).status_code == 200
    body = {"url": "http://ai.example.test/v1", "model": "shared-model", "key": SHARED_KEY, **values}
    answer = operator.put("/api/ai/shared", json=body)
    assert answer.status_code == 200, answer.text


def test_each_on_their_own_is_where_it_starts(client: TestClient, account: object, service: Service) -> None:
    open_lock(client)
    assert client.get("/api/settings").json()["ai_mode"] == "own"
    anna = person("anna")
    state = anna.get("/api/ai").json()
    assert (state["mode"], state["ready"], state["shared"]) == ("own", False, {"model": "", "complete": False})


def test_one_for_all_lets_every_member_ask_without_an_access_of_their_own(
    client: TestClient, account: object, service: Service
) -> None:
    share(client)
    anna = person("anna")
    assert anna.get("/api/auth/me").json()["ai_ready"] is True
    done = anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert done.status_code == 200, done.text
    sent = service.requests[-1]
    assert sent.headers["authorization"] == f"Bearer {SHARED_KEY}"
    assert service.last_body()["model"] == "shared-model"
    assert [event["model"] for event in anna.get("/api/ai/events").json()] == ["shared-model"]


def test_a_member_sees_the_model_of_the_service_for_all_but_neither_its_address_nor_its_key(
    client: TestClient, account: object, service: Service
) -> None:
    share(client)
    anna = person("anna")
    seen = anna.get("/api/ai")
    assert seen.json()["shared"] == {"model": "shared-model", "complete": True}
    assert "ai.example.test" not in seen.text and SHARED_KEY not in seen.text
    assert anna.get("/api/ai/shared").status_code == 403
    assert anna.put("/api/ai/shared", json={"model": "mine"}).status_code == 403
    assert anna.post("/api/ai/shared/models", json={}).status_code == 403
    assert anna.put("/api/settings", json={"ai_mode": "own"}).status_code == 403
    # The operator sees whether a key is there, never the key.
    operator_view = client.get("/api/ai/shared")
    assert {key: operator_view.json()[key] for key in ("url", "model", "key_set", "complete")} == {
        "url": "http://ai.example.test/v1/", "model": "shared-model", "key_set": True, "complete": True,
    }
    assert SHARED_KEY not in operator_view.text


def test_the_own_access_rests_while_one_serves_all_and_comes_back_unchanged(
    client: TestClient, account: object, service: Service
) -> None:
    open_lock(client)
    anna = person("anna")
    set_up(anna)
    share(client)
    anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert service.requests[-1].headers["authorization"] == f"Bearer {SHARED_KEY}"
    assert anna.get("/api/ai").json()["access"]["model"] == "model-a"
    assert client.put("/api/settings", json={"ai_mode": "own"}).status_code == 200
    anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert service.requests[-1].headers["authorization"] == f"Bearer {KEY}"
    assert service.last_body()["model"] == "model-a"


def test_a_service_for_all_without_its_model_is_named_as_the_reason(
    client: TestClient, account: object, service: Service
) -> None:
    share(client, model="")
    anna = person("anna")
    assert anna.get("/api/auth/me").json()["ai_ready"] is False
    refused = anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "ai_shared_incomplete")
    assert service.requests == []


def test_the_lock_still_stands_above_the_service_for_all(client: TestClient, account: object, service: Service) -> None:
    share(client)
    assert client.put("/api/settings", json={"ai_allowed": False}).status_code == 200
    anna = person("anna")
    assert anna.get("/api/auth/me").json()["ai_ready"] is False
    refused = anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (403, "ai_off")


def test_the_operators_address_may_be_at_home_without_a_list_and_a_members_may_not(
    client: TestClient, account: object, service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ai, "resolver", lambda host, port: ["192.168.1.20"])
    share(client, url="http://ollama.home.test:11434/v1")
    anna = person("anna")
    assert anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE}).status_code == 200
    assert client.post("/api/ai/shared/models", json={}).status_code == 200
    # Link-local stays refused, the operator's address too.
    monkeypatch.setattr(ai, "resolver", lambda host, port: ["169.254.169.254"])
    refused = anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert refused.json()["detail"]["code"] == "ai_address_refused"
    # A member's own address at home still needs the operator's list.
    monkeypatch.setattr(ai, "resolver", lambda host, port: ["192.168.1.20"])
    assert client.put("/api/settings", json={"ai_mode": "own"}).status_code == 200
    set_up(anna)
    refused = anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE})
    assert refused.json()["detail"]["code"] == "ai_address_private"


def test_the_operator_sets_how_often_an_account_may_ask(client: TestClient, account: object, service: Service) -> None:
    share(client)
    assert client.put("/api/settings", json={"ai_per_minute": 2}).status_code == 200
    assert client.put("/api/settings", json={"ai_per_minute": 0}).status_code == 422
    anna = person("anna")
    assert [anna.post("/api/ai/run", json={"task": "spelling", "text": NOTE}).status_code for _ in range(3)] == [
        200, 200, 429,
    ]


# --- Answers that flow ------------------------------------------------------------------------------------------------


def row_of(name: str) -> AccountRow:
    member = person(name)
    member.close()
    with SessionLocal() as db:
        found = db.query(AccountRow).filter(AccountRow.name == name).one()
        db.expunge(found)
    return found


def talk(name: str, heard: list[str]) -> ai.Spoken:
    with SessionLocal() as db:
        row = db.query(AccountRow).filter(AccountRow.name == name).one()
        return ai.converse(
            db, row, messages=[{"role": "system", "content": "rules"}, {"role": "user", "content": "How often?"}],
            temperature=0.3, heard=heard.append,
        )


def test_a_conversation_hands_its_answer_on_piece_by_piece(client: TestClient, account: object, service: Service) -> None:
    share(client)
    row_of("anna")
    service.answer = lambda request: flowing("Every hour, see [1].")
    heard: list[str] = []
    spoken = talk("anna", heard)
    assert spoken.text == "Every hour, see [1]."
    assert len(heard) > 2 and "".join(heard) == spoken.text
    assert (spoken.tokens_in, spoken.tokens_out) == (40, 9)
    sent = service.last_body()
    assert sent["stream"] is True and sent["model"] == "shared-model"
    assert service.requests[-1].headers["accept"] == "text/event-stream"
    with SessionLocal() as db:
        row = db.query(AccountRow).filter(AccountRow.name == "anna").one()
        kept = ai.events(db, row)
    assert [(event["task"], event["tokens_out"], event["error"]) for event in kept] == [("lore", 9, "")]
    assert kept[0]["body"]["messages"][1]["content"] == "How often?"


def test_a_service_that_does_not_flow_is_heard_all_at_once(client: TestClient, account: object, service: Service) -> None:
    share(client)
    row_of("anna")
    heard: list[str] = []
    spoken = talk("anna", heard)
    # The echo answers with the question in capitals, as one JSON answer.
    assert spoken.text == "HOW OFTEN?" and heard == ["HOW OFTEN?"]
    assert (spoken.tokens_in, spoken.tokens_out) == (11, 7)


def test_a_conversation_without_temperature_is_asked_once_more_and_a_refusal_is_kept(
    client: TestClient, account: object, service: Service
) -> None:
    share(client)
    row_of("anna")
    asked: list[dict] = []

    def picky(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        asked.append(body)
        if "temperature" in body:
            return httpx.Response(400, json={"error": {"message": "`temperature` is deprecated for this model."}})
        return flowing("Fine.", usage=False)

    service.answer = picky
    heard: list[str] = []
    assert talk("anna", heard).text == "Fine."
    assert ["temperature" in body for body in asked] == [True, False]

    service.answer = lambda request: httpx.Response(401, json={"error": {"message": "bad key"}})
    with pytest.raises(ai.AiError) as refused:
        talk("anna", [])
    assert refused.value.code == "ai_key_refused"
    service.answer = lambda request: flowing("   ")
    with pytest.raises(ai.AiError) as empty:
        talk("anna", [])
    assert empty.value.code == "ai_empty"
    with SessionLocal() as db:
        row = db.query(AccountRow).filter(AccountRow.name == "anna").one()
        errors = [event["error"] for event in ai.events(db, row)]
    assert errors == ["ai_empty", "ai_key_refused", ""]


def test_a_flowing_answer_has_a_limit(client: TestClient, account: object, service: Service,
                                      monkeypatch: pytest.MonkeyPatch) -> None:
    share(client)
    row_of("anna")
    monkeypatch.setattr(ai, "MAX_ANSWER", 200)
    service.answer = lambda request: flowing("x" * 2000)
    with pytest.raises(ai.AiError) as refused:
        talk("anna", [])
    assert refused.value.code == "ai_unreadable"
