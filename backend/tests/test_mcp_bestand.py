"""Test "Bestand" for MCP (the shared module mcp 1.1.0, Entwurf MCP-Modul, "Alte Zugänge"): the database of 1.16.0
(``tests/bestand``) with what 1.16.0 wrote for AI programs, written into it the way 1.16.0 wrote it before the start: a
key made in the interface (and one with a right of its own), a connector with its current and its spent refresh
token, a waiting request, MCP opened by the operator. Then the start of the running version, as a container after an
update. Afterwards the key works and keeps the rights it had (changing asks, deleting denied, its own right kept), the
connector refreshes at the address it knows and its spent token still ends it, the request can be decided, and a
revoked key no longer takes its requests along.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import secrets
import shutil
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent / "bestand"))

from bauen import TAB, dump_datei, manifest_datei

from app.config import get_settings
from app.db import SessionLocal, engine
from app.main import app
from app.models import Account, McpKey, McpRequest
from app.security import brake
from app.services import mcp, totp

from .conftest import sign_in

MANIFEST = json.loads(manifest_datei().read_text(encoding="utf-8"))
ADDRESS = MANIFEST["oeffentliche_adresse"]
SPACE = MANIFEST["raum"]
REDIRECT = "https://connector.example.com/callback"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _when(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d %H:%M:%S.%f")


@pytest.fixture
def older(vault: Path):
    """The 1.16.0 database with MCP rows as 1.16.0 wrote them, then the start of the running version."""
    engine.dispose()
    target = get_settings().database_path
    for rest in ("", "-wal", "-shm"):
        Path(str(target) + rest).unlink(missing_ok=True)
    now = datetime.now(UTC)
    tokens = {name: prefix + secrets.token_urlsafe(32) for name, prefix in
              (("key", "nxl_"), ("own", "nxl_"), ("access", "nxl_"), ("refresh", "nxr_"), ("spent", "nxr_"))}
    connection = sqlite3.connect(str(target))
    try:
        connection.executescript(gzip.decompress(dump_datei().read_bytes()).decode("utf-8"))
        connection.execute("UPDATE auth_sessions SET expires_at = datetime('now', '+30 days')")
        owner = connection.execute("SELECT id FROM accounts WHERE role = 'operator' ORDER BY id LIMIT 1").fetchone()[0]
        connection.execute("INSERT OR REPLACE INTO settings VALUES ('mcp_allowed', 'true')")
        connection.execute("INSERT OR REPLACE INTO settings VALUES ('mcp_max_level', '\"write\"')")
        for name, rights in (("key", None), ("own", json.dumps({"create_note": "allow"}))):
            connection.execute(
                "INSERT INTO mcp_keys (account_id, name, level, token_hash, prefix, spaces, created_at, tool_rights,"
                " kind) VALUES (?, ?, 'write', ?, ?, NULL, ?, ?, 'key')",
                (owner, f"old {name}", _hash(tokens[name]), tokens[name][:8], _when(now), rights),
            )
        connection.execute("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
                            ("nxo_older", "Older connector", json.dumps([REDIRECT]), _when(now)))
        connection.execute(
            "INSERT INTO mcp_keys (account_id, name, level, token_hash, prefix, spaces, created_at, kind, client_id,"
            " refresh_hash, expires_at, refresh_old_hash, signed_in_at) VALUES (?, 'Older connector', 'read', ?, ?,"
            " NULL, ?, 'oauth', 'nxo_older', ?, ?, ?, ?)",
            (owner, _hash(tokens["access"]), tokens["access"][:8], _when(now), _hash(tokens["refresh"]),
             _when(now + timedelta(hours=1)), _hash(tokens["spent"]), _when(now)),
        )
        key_id = connection.execute("SELECT id FROM mcp_keys WHERE name = 'old key'").fetchone()[0]
        arguments = json.dumps({"content": "Beans", "folder": SPACE, "title": "Asked before"}, sort_keys=True,
                               separators=(",", ":"))
        connection.execute(
            "INSERT INTO mcp_requests (account_id, key_id, key_name, tool, arguments, digest, status, result,"
            " created_at, expires_at) VALUES (?, ?, 'old key', 'create_note', ?, ?, 'waiting', '', ?, ?)",
            (owner, key_id, arguments, _hash(arguments), _when(now), _when(now + timedelta(hours=24))),
        )
        connection.commit()
    finally:
        connection.close()
    for path, text in MANIFEST["tresor"].items():
        file = vault / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
    with TestClient(app, base_url=ADDRESS, headers=TAB):
        pass
    brake.forget()
    totp.forget()
    mcp.forget()
    with SessionLocal() as db:
        operator = db.get(Account, owner)
        assert operator is not None
        db.expunge(operator)
    yield {"tokens": tokens, "owner": operator, "key_id": key_id}
    shutil.rmtree(vault, ignore_errors=True)
    vault.mkdir(parents=True, exist_ok=True)


def _rpc(token: str, method: str, params: dict | None = None) -> object:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return TestClient(app, base_url=ADDRESS).post("/api/mcp", json=body, headers={"Authorization": f"Bearer {token}"})


def _tools(token: str) -> set[str]:
    return {tool["name"] for tool in _rpc(token, "tools/list").json()["result"]["tools"]}


def _browser(account: Account) -> TestClient:
    client = TestClient(app, base_url=ADDRESS, headers=TAB)
    sign_in(client, account)
    return client


def test_mcp_stays_open_and_the_key_of_before_works_with_the_rights_it_had(older) -> None:
    tokens = older["tokens"]
    assert _rpc(tokens["key"], "initialize", {"protocolVersion": "2025-06-18"}).status_code == 200
    seen = _tools(tokens["key"])
    # Reading and changing are there; deleting, sharing and members were denied by default and stay so.
    assert {"read_note", "create_note", "write_note"} <= seen
    assert not seen & {"trash_note", "invite_member", "create_share"}
    # Changing asks, as it did.
    asked = _rpc(tokens["key"], "tools/call", {"name": "create_note", "arguments": {
        "folder": SPACE, "title": "Asks", "content": "x"}}).json()["result"]["structuredContent"]
    assert asked["status"] == "waiting"
    # A right the key had set itself stays: create_note runs at once.
    made = _rpc(tokens["own"], "tools/call", {"name": "create_note", "arguments": {
        "folder": SPACE, "title": "Runs", "content": "x"}}).json()["result"]
    assert not made["isError"], made
    assert "trash_note" not in _tools(tokens["own"])


def test_the_connector_of_before_refreshes_and_its_spent_token_still_ends_it(older) -> None:
    tokens = older["tokens"]
    stranger = TestClient(app, base_url=ADDRESS)
    renewed = stranger.post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": "nxo_older",
                                                      "refresh_token": tokens["refresh"]})
    assert renewed.status_code == 200, renewed.text
    assert _rpc(renewed.json()["access_token"], "ping").status_code == 200
    copy = stranger.post("/api/oauth/token", data={"grant_type": "refresh_token", "client_id": "nxo_older",
                                                   "refresh_token": tokens["spent"]})
    assert copy.status_code == 400 and copy.json()["error"] == "invalid_grant"
    assert _rpc(renewed.json()["access_token"], "ping").status_code == 401
    with SessionLocal() as db:
        assert db.query(McpKey).filter(McpKey.client_id == "nxo_older").count() == 0


def test_the_waiting_request_of_before_is_decided_and_outlives_its_key(older) -> None:
    owner = _browser(older["owner"])
    listed = owner.get("/api/mcp/requests").json()
    request_id = next(row["id"] for row in listed if row["status"] == "waiting" and row["key_name"] == "old key")
    shown = owner.get(f"/api/connections/mcp/requests/{request_id}")
    assert shown.status_code == 200 and shown.json()["tool"] == "create_note"
    done = owner.post(f"/api/mcp/requests/{request_id}/approve", json={})
    assert done.status_code == 200 and done.json()["status"] == "done", done.text
    # Another request of the same key, then the key revoked: the request stays and runs nothing when allowed.
    asked = _rpc(older["tokens"]["key"], "tools/call", {"name": "create_note", "arguments": {
        "folder": SPACE, "title": "After revoking", "content": "x"}}).json()["result"]["structuredContent"]
    assert owner.delete(f"/api/mcp/keys/{older['key_id']}").status_code == 204
    with SessionLocal() as db:
        assert db.get(McpRequest, asked["request"]) is not None
    failed = owner.post(f"/api/mcp/requests/{asked['request']}/approve", json={})
    assert failed.status_code == 200 and failed.json()["status"] == "failed"
