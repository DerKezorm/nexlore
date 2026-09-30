"""What the review before 1.0.0 found (PG numbers in the project's notes), each as a test that failed before."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.services import index, settings_service

from .conftest import make_account, sign_in
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


# --- O1: an account joins only when it says yes; what the operator does is seen -------------------------------------


def _person(name: str) -> tuple[TestClient, Account]:
    row = make_account(name)
    person = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(person, row)
    return person, row


def _spaces(person: TestClient) -> list[str]:
    return [space["name"] for space in person.get("/api/spaces").json()]


def test_naming_an_account_invites_it_and_it_decides(client: TestClient, account: Account) -> None:
    anna, _ = _person("anna")
    bob, _ = _person("bob")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    asked = anna.put("/api/spaces/Garden/members/bob", json={"role": "write"})
    assert asked.status_code == 202 and asked.json()["invited"] is True
    assert "Garden" not in _spaces(bob)
    assert [row["name"] for row in anna.get("/api/spaces/Garden/members").json()["members"]] == ["anna"]
    [invite] = bob.get("/api/notices").json()
    assert (invite["kind"], invite["space"], invite["role"], invite["actor"]) == ("invite", "Garden", "write", "anna")
    assert bob.post(f"/api/notices/{invite['id']}/accept").json() == {"space": "Garden"}
    assert "Garden" in _spaces(bob)
    assert bob.get("/api/notices").json() == []
    # Accepted once: gone.
    assert bob.post(f"/api/notices/{invite['id']}/accept").status_code == 404


def test_a_declined_invitation_leaves_nothing(client: TestClient, account: Account) -> None:
    anna, _ = _person("anna")
    bob, _ = _person("bob")
    anna.post("/api/spaces", json={"name": "Garden"})
    anna.put("/api/spaces/Garden/members/bob", json={"role": "read"})
    [invite] = bob.get("/api/notices").json()
    assert anna.post(f"/api/notices/{invite['id']}/decline").status_code == 404  # not anna's to answer
    assert bob.post(f"/api/notices/{invite['id']}/decline").status_code == 204
    assert "Garden" not in _spaces(bob)
    assert bob.get("/api/notices").json() == []


def test_a_manager_learns_nothing_about_names_outside(client: TestClient, account: Account) -> None:
    anna, _ = _person("anna")
    _person("bob")
    anna.post("/api/spaces", json={"name": "Garden"})
    known = anna.put("/api/spaces/Garden/members/bob", json={"role": "read"})
    unknown = anna.put("/api/spaces/Garden/members/nobody", json={"role": "read"})
    operator = anna.put("/api/spaces/Garden/members/tester", json={"role": "read"})
    assert known.status_code == unknown.status_code == operator.status_code == 202
    assert {key for key in known.json() if key != "name"} == {key for key in unknown.json() if key != "name"}
    removed = [anna.delete(f"/api/spaces/Garden/members/{name}") for name in ("bob", "nobody")]
    assert [(answer.status_code, answer.json()["detail"]["code"]) for answer in removed] == [(404, "not_a_member")] * 2


def test_what_the_operator_does_in_a_space_of_others_is_told(client: TestClient, account: Account) -> None:
    anna, _ = _person("anna")
    carl, _ = _person("carl")
    anna.post("/api/spaces", json={"name": "Garden"})
    # The operator puts carl in: allowed, and both anna and carl are told.
    assert client.put("/api/spaces/Garden/members/carl", json={"role": "read"}).status_code == 200
    assert "Garden" in _spaces(carl)
    told = [(row["kind"], row["subject"], row["actor"]) for row in anna.get("/api/notices").json()]
    assert told == [("operator_added", "carl", "tester")]
    assert [row["kind"] for row in carl.get("/api/notices").json()] == ["operator_added"]
    client.put("/api/spaces/Garden/members/carl", json={"role": "write"})
    assert anna.get("/api/notices").json()[0]["kind"] == "operator_role"
    # Taking the members out makes the space the operator's: the ones taken out are told.
    assert client.delete("/api/spaces/Garden/members/carl").status_code == 204
    assert client.delete("/api/spaces/Garden/members/anna").status_code == 204
    assert "operator_removed" in [row["kind"] for row in anna.get("/api/notices").json()]
    seen = anna.get("/api/notices").json()[0]["id"]
    assert anna.post(f"/api/notices/{seen}/decline").status_code == 204
    assert seen not in [row["id"] for row in anna.get("/api/notices").json()]


def test_the_operator_who_invites_into_its_own_space_stays_in_it(client: TestClient, account: Account, vault: Path) -> None:
    (vault / "Disk").mkdir()
    index.scan()
    bob, _ = _person("bob")
    assert client.put("/api/spaces/Disk/members/bob", json={"role": "write"}).status_code == 202
    [invite] = bob.get("/api/notices").json()
    bob.post(f"/api/notices/{invite['id']}/accept")
    members = {row["name"]: row["role"] for row in client.get("/api/spaces/Disk/members").json()["members"]}
    assert members == {"tester": "manage", "bob": "write"}
