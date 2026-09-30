"""What the review before 1.0.0 found (PG numbers in the project's notes), each as a test that failed before."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.models import Account
from app.services import index

from .test_mcp import World, call, failure, world  # noqa: F401  (the fixture is used by name)

# --- O3: hard input answers without a server error ------------------------------------------------------------------


def test_json_nested_deeper_than_the_stack_is_a_parse_error_at_mcp(world: World) -> None:  # noqa: F811
    token = world.key()
    deep = b"[" * 200_000 + b"]" * 200_000
    answer = TestClient(app).post("/api/mcp", content=deep, headers={"Authorization": f"Bearer {token}"})
    assert answer.status_code == 400
    assert answer.json()["error"]["code"] == -32700


def test_a_body_that_is_not_json_answers_with_a_code(client: TestClient, account: Account) -> None:
    # Broken JSON is FastAPI's 422 with a code already; JSON nested too deep for the parser is its bare 400.
    broken = client.post("/api/notes", content=b"{nope", headers={"Content-Type": "application/json"})
    deep = client.post("/api/notes", content=b"[" * 200_000 + b"]" * 200_000,
                       headers={"Content-Type": "application/json"})
    for answer in (broken, deep):
        assert answer.status_code in (400, 422)
        assert answer.json()["detail"]["code"] == "invalid_input"


def test_control_characters_in_a_title_never_reach_the_file(client: TestClient, account: Account, vault: Path) -> None:
    (vault / "S").mkdir()
    index.scan()
    made = client.post("/api/notes", json={"folder": "S", "title": "a\x00b\x1fc\x7fd"})
    assert made.status_code == 201, made.text
    data = (vault / made.json()["path"]).read_bytes()
    assert not any(byte < 0x20 and byte not in (0x0A, 0x0D, 0x09) or byte == 0x7F for byte in data), data


def test_a_month_that_does_not_exist_is_refused_not_a_server_error(client: TestClient, account: Account) -> None:
    assert client.get("/api/calendar", params={"month": "2026-13", "today": "2026-09-30"}).status_code == 422
    assert client.get("/api/calendar", params={"month": "2026-00", "today": "2026-09-30"}).status_code == 422
    assert client.get("/api/calendar", params={"month": "2026-09", "today": "2026-13-45"}).status_code < 500
    assert client.get("/api/calendar", params={"month": "2026-12", "today": "2026-09-30"}).status_code == 200


def test_an_empty_title_at_mcp_says_it_is_empty(world: World) -> None:  # noqa: F811
    token = world.key("write")
    said = failure(call(token, "create_note", folder="Garden", title="   ", content="x"))
    assert "empty" in said and "255" not in said

