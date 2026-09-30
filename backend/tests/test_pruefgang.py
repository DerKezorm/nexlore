"""What the review before 1.0.0 found (PG numbers in the project's notes), each as a test that failed before."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.services import index, settings_service

from .test_mcp import World, call, failure, world  # noqa: F401  (the fixture is used by name)
from .test_shares import share, site, token_of  # noqa: F401

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


# --- O5: brakes, passwords, bolts ---------------------------------------------------------------------------------


def _sender(address: str) -> TestClient:
    return TestClient(app, base_url="http://testserver", client=(address, 50000),
                      headers={"X-Nexlore-Client": "tab-stranger"})


def test_one_guesser_does_not_lock_the_other_readers_of_a_page_out(site: TestClient) -> None:  # noqa: F811
    token = token_of(share(site, "Garden/Public", password="rose garden key"))
    guesser, reader = _sender("198.51.100.7"), _sender("198.51.100.8")
    codes = [guesser.post(f"/api/public/{token}/unlock", json={"password": "guess"}).status_code for _ in range(8)]
    assert 429 in codes
    assert reader.post(f"/api/public/{token}/unlock", json={"password": "rose garden key"}).status_code == 204


def test_many_senders_together_still_meet_the_brake(site: TestClient) -> None:  # noqa: F811
    token = token_of(share(site, "Garden/Public", password="rose garden key"))
    for n in range(40):
        _sender(f"198.51.100.{n + 10}").post(f"/api/public/{token}/unlock", json={"password": "guess"})
    late = _sender("198.51.100.200").post(f"/api/public/{token}/unlock", json={"password": "rose garden key"})
    assert late.status_code == 429


def test_a_public_page_needs_a_real_password(site: TestClient) -> None:  # noqa: F811
    for weak in ("x", "abc1234", "          "):
        made = site.post("/api/shares", json={"path": "Garden/Public", "password": weak})
        assert made.status_code == 422, weak
        assert made.json()["detail"]["code"] == "share_password_short"
    assert site.post("/api/shares", json={"path": "Garden/Public", "password": "rose garden"}).status_code == 201
    assert site.post("/api/shares", json={"path": "Garden/Public"}).status_code == 201


def test_password_sign_in_stays_on_until_there_is_a_provider(client: TestClient, account: Account) -> None:
    refused = client.put("/api/settings", json={"password_login": False})
    assert (refused.status_code, refused.json()["detail"]["code"]) == (409, "provider_first")
    with SessionLocal() as db:
        settings_service.save(db, {"oidc_issuer": "https://id.example.com", "oidc_client_id": "nexlore"})
    assert client.put("/api/settings", json={"password_login": False}).status_code == 200
