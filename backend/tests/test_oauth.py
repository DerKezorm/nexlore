"""Connectors sign in for MCP with OAuth (block Y): discovery, registration, consent, tokens, refresh.

The world of ``test_mcp``: anna writes in ``Garden``, bob's ``Secret`` is not hers. A made-up connector registers
with a redirect address on example.com and goes through the flow as an AI program would, PKCE included.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import McpKey, OAuthCode, utcnow
from app.routers import oauth

from .test_mcp import World, call, rpc, switch, value

REDIRECT = "https://connector.example.com/api/mcp/auth_callback"


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    oauth.forget()
    return World(client, vault)


def stranger() -> TestClient:
    return TestClient(app, base_url="http://testserver")


def register(redirects: list[str] | None = None, **extra: object) -> dict:
    answer = stranger().post("/api/oauth/register", json={"redirect_uris": redirects or [REDIRECT],
                                                          "client_name": "Made-up connector", **extra})
    assert answer.status_code == 201, answer.text
    return answer.json()


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def agree(world: World, client_id: str, challenge: str, **choice: object) -> dict[str, list[str]]:
    body = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
            "code_challenge_method": "S256", "state": "xyz", "approve": True, "level": "write"} | choice
    answer = world.anna.post("/api/oauth/authorize", json=body)
    assert answer.status_code == 200, answer.text
    target = answer.json()["redirect"]
    assert target.startswith(REDIRECT + "?")
    return parse_qs(urlsplit(target).query)


def trade(client_id: str, code: str, verifier: str, redirect: str = REDIRECT):
    return stranger().post("/api/oauth/token", data={"grant_type": "authorization_code", "code": code,
                                                     "redirect_uri": redirect, "client_id": client_id,
                                                     "code_verifier": verifier})


def signed_in(world: World, **choice: object) -> tuple[dict, dict]:
    client = register()
    verifier, challenge = pkce()
    back = agree(world, client["client_id"], challenge, **choice)
    tokens = trade(client["client_id"], back["code"][0], verifier)
    assert tokens.status_code == 200, tokens.text
    return client, tokens.json()


# --- Discovery ---------------------------------------------------------------------------------------------------------


def test_discovery_leads_from_the_401_to_the_sign_in(world: World) -> None:
    challenge = rpc("nothing", "ping").headers["www-authenticate"]
    assert 'resource_metadata="http://testserver/.well-known/oauth-protected-resource"' in challenge
    resource = stranger().get("/.well-known/oauth-protected-resource").json()
    assert resource["resource"] == "http://testserver/api/mcp"
    assert resource["authorization_servers"] == ["http://testserver"]
    assert stranger().get("/.well-known/oauth-protected-resource/api/mcp").json() == resource
    server = stranger().get("/.well-known/oauth-authorization-server").json()
    assert server["authorization_endpoint"] == "http://testserver/oauth/authorize"
    assert server["token_endpoint"] == "http://testserver/api/oauth/token"
    assert server["registration_endpoint"] == "http://testserver/api/oauth/register"
    assert server["code_challenge_methods_supported"] == ["S256"]
    assert server["token_endpoint_auth_methods_supported"] == ["none"]


def test_the_public_address_wins_over_the_request(world: World) -> None:
    switch(public_url="https://notes.example.com")
    assert stranger().get("/.well-known/oauth-protected-resource").json()["resource"] == "https://notes.example.com/api/mcp"


def test_nothing_of_it_while_mcp_or_connectors_are_off(world: World) -> None:
    switch(mcp_oauth_allowed=False)
    assert stranger().get("/.well-known/oauth-protected-resource").status_code == 404
    assert stranger().get("/.well-known/oauth-authorization-server").status_code == 404
    assert stranger().post("/api/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 403
    assert rpc("nothing", "ping").headers["www-authenticate"] == "Bearer"
    switch(mcp_oauth_allowed=True, mcp_allowed=False)
    assert stranger().get("/.well-known/oauth-authorization-server").status_code == 404


# --- Registration ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("address", [
    "http://connector.example.com/callback",  # plain http, not the own machine
    "https://connector.example.com/callback#x",  # a fragment
    "https://user:pass@connector.example.com/callback",  # a user in the address
    "javascript:alert(1)",
    "ftp://connector.example.com/x",
    "https:///no-host",
    # Review before 1.0.0: these gave 500 or were stored.
    "http://[::1/cb",
    "https://[abc/cb",
    "http://[::1]evil.com/cb",
    "https://[::1]x/cb",
    "http://localhost:8080:evil.com/cb",
    "https://*.example.com/cb",
    "https://аpple.example/cb",  # a Cyrillic letter that looks Latin: only names in ASCII (punycode)
])
def test_registration_refuses_unsafe_return_addresses(world: World, address: str) -> None:
    answer = stranger().post("/api/oauth/register", json={"redirect_uris": [address]})
    assert answer.status_code == 400 and answer.json()["error"] == "invalid_redirect_uri"


def test_registration_takes_https_and_the_own_machine_and_only_public_clients(world: World) -> None:
    made = register([REDIRECT, "http://localhost:43123/callback", "http://127.0.0.1/callback"])
    assert made["client_id"].startswith("nxo_") and made["token_endpoint_auth_method"] == "none"
    secret = stranger().post("/api/oauth/register", json={"redirect_uris": [REDIRECT],
                                                          "token_endpoint_auth_method": "client_secret_basic"})
    assert secret.status_code == 400


def test_registration_is_braked(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(oauth, "REGISTER_PER_MINUTE", 2)
    register()
    register()
    assert stranger().post("/api/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 429


# --- Consent -----------------------------------------------------------------------------------------------------------


def test_the_consent_page_needs_an_account_a_known_client_its_address_and_pkce(world: World) -> None:
    client = register()
    _, challenge = pkce()
    asked = {"client_id": client["client_id"], "redirect_uri": REDIRECT, "code_challenge": challenge,
             "code_challenge_method": "S256"}
    assert stranger().get("/api/oauth/authorize", params=asked).status_code == 401
    info = world.anna.get("/api/oauth/authorize", params=asked).json()
    assert info["client_name"] == "Made-up connector" and info["redirect_host"] == "connector.example.com"
    assert [space["name"] for space in info["spaces"]] == ["Garden"]
    assert world.anna.get("/api/oauth/authorize", params=asked | {"client_id": "nxo_unknown"}).status_code == 400
    elsewhere = asked | {"redirect_uri": "https://thief.example.com/cb"}
    assert world.anna.get("/api/oauth/authorize", params=elsewhere).json()["detail"]["code"] == "oauth_redirect"
    assert world.anna.get("/api/oauth/authorize", params=asked | {"code_challenge_method": "plain"}).status_code == 400
    # The answer to the consent is a change: a page elsewhere cannot send it (no tab header).
    plain = TestClient(app, base_url="http://testserver")
    plain.cookies = world.anna.cookies
    body = asked | {"approve": True, "level": "read", "state": ""}
    assert plain.post("/api/oauth/authorize", json=body).status_code == 400


def test_declining_sends_the_program_away_without_a_code(world: World) -> None:
    client = register()
    _, challenge = pkce()
    back = agree(world, client["client_id"], challenge, approve=False)
    assert back["error"] == ["access_denied"] and back["state"] == ["xyz"] and "code" not in back


def test_the_level_and_spaces_stay_within_what_is_allowed(world: World) -> None:
    client = register()
    _, challenge = pkce()
    base = {"client_id": client["client_id"], "redirect_uri": REDIRECT, "code_challenge": challenge,
            "code_challenge_method": "S256", "approve": True}
    switch(mcp_max_level="read")
    assert world.anna.post("/api/oauth/authorize", json=base | {"level": "write"}).status_code == 403
    switch(mcp_max_level="write")
    secret = {space["name"]: space["id"] for space in world.bob.get("/api/spaces").json()}["Secret"]
    assert world.anna.post("/api/oauth/authorize", json=base | {"level": "read", "spaces": [secret]}).status_code == 422


# --- Tokens ------------------------------------------------------------------------------------------------------------


def test_the_whole_way_gives_a_key_that_acts_as_the_account(world: World) -> None:
    _, tokens = signed_in(world)
    assert tokens["token_type"] == "Bearer" and tokens["expires_in"] == 3600
    assert tokens["access_token"].startswith("nxl_") and tokens["refresh_token"].startswith("nxr_")
    assert [space["name"] for space in value(call(tokens["access_token"], "list_spaces"))] == ["Garden"]
    keys = world.anna.get("/api/mcp/keys").json()["keys"]
    connector = [key for key in keys if key["kind"] == "oauth"]
    assert len(connector) == 1 and connector[0]["name"] == "Made-up connector" and connector[0]["level"] == "write"
    # Rights per tool as for every key: changing asks first.
    waiting = value(call(tokens["access_token"], "create_note", folder="Garden", title="x", content="x"))
    assert waiting["status"] == "waiting"


def test_a_code_is_traded_once_with_its_verifier_and_its_address(world: World) -> None:
    client = register()
    verifier, challenge = pkce()
    code = agree(world, client["client_id"], challenge)["code"][0]
    assert trade(client["client_id"], code, "x" * 50).json()["error"] == "invalid_grant"
    # The failed try used it up.
    assert trade(client["client_id"], code, verifier).json()["error"] == "invalid_grant"
    code = agree(world, client["client_id"], challenge)["code"][0]
    assert trade(client["client_id"], code, verifier, "https://connector.example.com/other").status_code == 400
    code = agree(world, client["client_id"], challenge)["code"][0]
    other = register()
    assert trade(other["client_id"], code, verifier).json()["error"] == "invalid_grant"
    code = agree(world, client["client_id"], challenge)["code"][0]
    assert trade(client["client_id"], code, verifier).status_code == 200
    assert trade(client["client_id"], code, verifier).json()["error"] == "invalid_grant"
    assert trade("nxo_unknown", code, verifier).status_code == 401


def test_a_code_runs_out(world: World) -> None:
    client = register()
    verifier, challenge = pkce()
    code = agree(world, client["client_id"], challenge)["code"][0]
    with SessionLocal() as db:
        for row in db.query(OAuthCode).all():
            row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert trade(client["client_id"], code, verifier).json()["error"] == "invalid_grant"


def test_refreshing_changes_both_tokens_and_the_old_ones_stop(world: World) -> None:
    client, tokens = signed_in(world)
    fresh = stranger().post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                      "refresh_token": tokens["refresh_token"]})
    assert fresh.status_code == 200, fresh.text
    renewed = fresh.json()
    assert renewed["access_token"] != tokens["access_token"] and renewed["refresh_token"] != tokens["refresh_token"]
    assert rpc(tokens["access_token"], "ping").status_code == 401
    assert rpc(renewed["access_token"], "ping").status_code == 200
    again = stranger().post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                      "refresh_token": tokens["refresh_token"]})
    assert again.json()["error"] == "invalid_grant"
    # Another client cannot use it either.
    other = register()
    stolen = stranger().post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": other["client_id"],
                                                       "refresh_token": renewed["refresh_token"]})
    assert stolen.json()["error"] == "invalid_grant"


def test_an_access_token_runs_out_after_an_hour(world: World) -> None:
    _, tokens = signed_in(world)
    with SessionLocal() as db:
        for key in db.query(McpKey).filter(McpKey.kind == "oauth").all():
            assert key.expires_at is not None and key.expires_at - utcnow() <= timedelta(hours=1)
            key.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert rpc(tokens["access_token"], "ping").status_code == 401


def test_signing_in_again_keeps_the_rights_and_revoking_ends_it(world: World) -> None:
    client, _ = signed_in(world)
    key = next(key for key in world.anna.get("/api/mcp/keys").json()["keys"] if key["kind"] == "oauth")
    assert world.anna.put(f"/api/mcp/keys/{key['id']}/rights", json={"rights": {"create_note": "allow"}}).status_code == 200
    verifier, challenge = pkce()
    code = agree(world, client["client_id"], challenge, level="read")["code"][0]
    second = trade(client["client_id"], code, verifier).json()
    keys = [k for k in world.anna.get("/api/mcp/keys").json()["keys"] if k["kind"] == "oauth"]
    assert len(keys) == 1 and keys[0]["rights"] == {"create_note": "allow"} and keys[0]["level"] == "read"
    assert world.anna.delete(f"/api/mcp/keys/{keys[0]['id']}").status_code == 204
    assert rpc(second["access_token"], "ping").status_code == 401
    refused = stranger().post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                        "refresh_token": second["refresh_token"]})
    assert refused.json()["error"] == "invalid_grant"


def test_a_key_for_some_spaces_sees_only_those(world: World) -> None:
    assert world.anna.post("/api/spaces", json={"name": "Kitchen"}).status_code == 201
    garden = {space["name"]: space["id"] for space in world.anna.get("/api/spaces").json()}["Garden"]
    _, tokens = signed_in(world, spaces=[garden])
    assert [space["name"] for space in value(call(tokens["access_token"], "list_spaces"))] == ["Garden"]


def test_connectors_switched_off_stop_the_token_endpoint(world: World) -> None:
    client = register()
    verifier, challenge = pkce()
    code = agree(world, client["client_id"], challenge)["code"][0]
    switch(mcp_oauth_allowed=False)
    assert trade(client["client_id"], code, verifier).status_code == 403
