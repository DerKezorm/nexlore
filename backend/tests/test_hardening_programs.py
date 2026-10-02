"""Security review before 1.0.0: what programs may do (MCP keys, connectors, API tokens) and how their access ends."""

from __future__ import annotations

import threading
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import McpKey, McpRequest, OAuthClient, utcnow
from app.services import mcp, settings_service

from .test_api_tokens import api
from .test_mcp import World, call, failure, rpc, switch, value, world  # noqa: F401  (the fixture is used by name)
from .test_oauth import REDIRECT, register, signed_in, stranger


def refresh(client_id: str, token: str):
    return stranger().post("/api/oauth/token", data={"grant_type": "refresh_token", "refresh_token": token,
                                                     "client_id": client_id})


def works(access: str) -> bool:
    return rpc(access, "tools/list").status_code == 200


# --- Requests waiting for approval ------------------------------------------------------------------------------------


def waiting_request(world: World, title: str) -> tuple[str, int]:
    token = world.key("write", ask=True)
    result = value(call(token, "create_note", folder="Garden", title=title, content="once"))
    return token, int(result["request"])


def test_six_approvals_at_once_run_the_tool_once(world: World) -> None:  # noqa: F811
    _token, request_id = waiting_request(world, "Asked")
    answers: list[int] = []
    start = threading.Barrier(6)

    def approve() -> None:
        own = TestClient(world.anna.app, base_url="http://testserver", headers=dict(world.anna.headers),
                         cookies=dict(world.anna.cookies))
        start.wait()
        answers.append(own.post(f"/api/mcp/requests/{request_id}/approve", json={}).status_code)

    threads = [threading.Thread(target=approve) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answers) == [200] + [409] * 5
    made = [path for path in (world.vault / "Garden").iterdir() if path.name.startswith("Asked")]
    assert len(made) == 1


def test_approving_and_declining_at_once_leave_one_decision(world: World) -> None:  # noqa: F811
    _token, request_id = waiting_request(world, "Either")
    answers: dict[str, int] = {}
    start = threading.Barrier(2)

    def decide(how: str) -> None:
        own = TestClient(world.anna.app, base_url="http://testserver", headers=dict(world.anna.headers),
                         cookies=dict(world.anna.cookies))
        start.wait()
        answers[how] = own.post(f"/api/mcp/requests/{request_id}/{how}", json={}).status_code

    threads = [threading.Thread(target=decide, args=(how,)) for how in ("approve", "decline")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answers.values()) == [200, 409]
    exists = any(path.name.startswith("Either") for path in (world.vault / "Garden").iterdir())
    with SessionLocal() as db:
        status = db.get(McpRequest, request_id).status  # type: ignore[union-attr]
    assert exists == (status == "done")
    assert status in ("done", "declined")


def test_one_program_fills_at_most_half_of_the_waiting_room(world: World) -> None:  # noqa: F811
    busy = world.key("write", ask=True)
    for number in range(50):
        assert "request" in value(call(busy, "create_note", folder="Garden", title=f"N{number}", content="x"))
    assert "50 requests waiting" in failure(call(busy, "create_note", folder="Garden", title="N50", content="x"))
    other = world.key("write", ask=True)
    assert "request" in value(call(other, "create_note", folder="Garden", title="Other", content="x"))


# --- No operator powers through a program -------------------------------------------------------------------------------


def test_the_operators_key_cannot_withdraw_somebody_elses_public_page(world: World) -> None:  # noqa: F811
    switch(shares_allowed=True)
    made = world.anna.post("/api/shares", json={"path": "Garden/Plan.md"})
    assert made.status_code == 201, made.text
    share_id = made.json()["id"]
    key = world.operator.post("/api/mcp/keys", json={"name": "operator's agent", "level": "write"})
    assert key.status_code == 201, key.text
    rights = world.operator.put(f"/api/mcp/keys/{key.json()['key']['id']}/rights",
                                json={"rights": {"remove_share": "allow", "remove_member": "allow"}})
    assert rights.status_code == 200, rights.text
    token = key.json()["token"]
    assert failure(call(token, "remove_share", share=share_id)) == "Not found."
    assert failure(call(token, "remove_member", space="Garden", name="anna"))
    assert [share["id"] for share in world.anna.get("/api/shares", params={"path": "Garden/Plan.md"}).json()] == [
        share_id]
    # In the interface the operator still may (design answer PG-1, and every member is told).
    assert world.operator.delete(f"/api/shares/{share_id}").status_code == 204


# --- A program that read an older state ---------------------------------------------------------------------------------


def test_a_text_read_in_a_state_no_longer_kept_ends_in_a_conflict_copy(world: World) -> None:  # noqa: F811
    from .test_api_tokens import World as ApiWorld

    switch(api_tokens_allowed=True)
    token = ApiWorld.token(world, "write")  # type: ignore[arg-type]
    read = api(token, "GET", "/api/v1/note", params={"path": "Garden/Plan.md"}).json()
    human = world.anna.put("/api/note", json={"path": "Garden/Plan.md", "content": "# Plan\n\nThe human's words.\n",
                                              "base_hash": read["hash"]})
    assert human.status_code == 200, human.text
    written = api(token, "PUT", "/api/v1/note", json={"path": "Garden/Plan.md", "content": "The program's words.\n",
                                                       "base_hash": read["hash"]})
    assert written.status_code == 200, written.text
    assert written.json()["saved"] is False and written.json()["conflict"]
    assert "The human's words." in (world.vault / "Garden" / "Plan.md").read_text(encoding="utf-8")
    copy = world.vault / written.json()["conflict"]
    assert copy.read_text(encoding="utf-8") == "The program's words.\n"


# --- Connectors (OAuth) ---------------------------------------------------------------------------------------------------


def test_a_new_password_or_signing_out_everywhere_ends_every_connector(world: World) -> None:  # noqa: F811
    client, tokens = signed_in(world)
    assert works(tokens["access_token"])
    assert world.anna.post("/api/auth/logout-all").status_code == 204
    assert not works(tokens["access_token"])
    assert refresh(client["client_id"], tokens["refresh_token"]).status_code == 400


def test_a_refresh_token_brought_twice_ends_the_connector(world: World) -> None:  # noqa: F811
    client, first = signed_in(world)
    second = refresh(client["client_id"], first["refresh_token"])
    assert second.status_code == 200
    assert refresh(client["client_id"], first["refresh_token"]).status_code == 400
    assert refresh(client["client_id"], second.json()["refresh_token"]).status_code == 400
    assert not works(second.json()["access_token"])


def test_a_connector_signs_in_again_after_ninety_days_or_a_month_idle(world: World) -> None:  # noqa: F811
    client, tokens = signed_in(world)
    with SessionLocal() as db:
        key = db.scalar(select(McpKey).where(McpKey.kind == "oauth"))
        assert key is not None
        key.signed_in_at = utcnow() - timedelta(days=91)
        db.commit()
    assert refresh(client["client_id"], tokens["refresh_token"]).status_code == 400
    client, tokens = signed_in(world)
    with SessionLocal() as db:
        key = db.scalar(select(McpKey).where(McpKey.kind == "oauth", McpKey.client_id == client["client_id"]))
        assert key is not None
        key.expires_at = utcnow() - timedelta(days=31)
        db.commit()
    assert refresh(client["client_id"], tokens["refresh_token"]).status_code == 400


def test_switching_connectors_off_stops_their_tokens_at_once(world: World) -> None:  # noqa: F811
    _client, tokens = signed_in(world)
    assert works(tokens["access_token"])
    switch(mcp_oauth_allowed=False)
    assert not works(tokens["access_token"])
    switch(mcp_oauth_allowed=True)


def test_a_locked_account_gets_no_new_tokens(world: World) -> None:  # noqa: F811
    client, tokens = signed_in(world)
    with SessionLocal() as db:
        key = db.scalar(select(McpKey).where(McpKey.kind == "oauth"))
        assert key is not None
        from app.models import Account

        account = db.get(Account, key.account_id)
        assert account is not None
        account.locked_until = utcnow() + timedelta(minutes=10)
        db.commit()
    assert refresh(client["client_id"], tokens["refresh_token"]).status_code == 400


def test_one_sender_registers_a_few_connectors_an_hour(world: World) -> None:  # noqa: F811
    answers = [stranger().post("/api/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code
               for _ in range(11)]
    assert answers[:10] == [201] * 10 and answers[-1] == 429


def test_a_connector_registered_in_the_last_hour_is_never_pushed_out(world: World, monkeypatch) -> None:  # noqa: F811
    from app.routers import oauth

    monkeypatch.setattr(oauth, "MAX_CLIENTS", 3)
    first = register()["client_id"]
    for _ in range(4):
        from app.security import brake

        brake.forget()
        register()
    with SessionLocal() as db:
        assert db.get(OAuthClient, first) is not None


def test_what_names_the_server_is_never_kept_by_a_cache(world: World) -> None:  # noqa: F811
    for path in ("/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"):
        assert stranger().get(path).headers.get("cache-control") == "no-store"


def test_the_consent_page_answers_for_an_ordinary_flow(world: World) -> None:  # noqa: F811
    # The flow still works end to end after all of the above.
    _client, tokens = signed_in(world)
    assert works(tokens["access_token"])
    with SessionLocal() as db:
        assert settings_service.get(db, "mcp_oauth_allowed") is True
    assert mcp.TOKEN_PREFIX in tokens["access_token"]
