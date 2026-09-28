"""What the blind review before the first release found (M8), each as a test that failed before the repair."""

from __future__ import annotations

import os
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import insert
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.main import ROUTERS, app
from app.models import Account, McpKey
from app.services import backups, index, logs, mcp, settings_service

from .conftest import PASSWORD, make_account, sign_in

HUGE = 10**30


def _int_params(route: APIRoute) -> tuple[list[str], list[str], list[str]]:
    dependant = route.dependant
    path_ints = [param.name for param in dependant.path_params if param.field_info.annotation is int]
    path_others = [param.name for param in dependant.path_params if param.field_info.annotation is not int]
    query_ints = [
        param.alias for param in dependant.query_params
        if param.field_info.annotation in (int, int | None)
    ]
    return path_ints, path_others, query_ints


def test_a_number_too_large_for_the_database_is_refused_not_a_server_error(
    client: TestClient, operator: Account, vault: Path
) -> None:
    (vault / "S").mkdir()
    (vault / "S" / "a.md").write_bytes(b"# a\n")
    index.scan()
    tried = 0
    routes = [route for module in ROUTERS for route in module.router.routes if isinstance(route, APIRoute)]
    for route in routes:
        path_ints, path_others, query_ints = _int_params(route)
        if not path_ints and not query_ints:
            continue
        path = route.path
        for name in path_ints:
            path = path.replace("{" + name + "}", str(HUGE))
        for name in path_others:
            path = path.replace("{" + name + "}", "S").replace("{" + name + ":path}", "S/a.md")
        query = {name: str(HUGE) for name in query_ints}
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            answer = client.request(method, path, params=query, json={})
            assert answer.status_code < 500, (method, route.path, answer.status_code)
            tried += 1
    # A floor: the routes with numbers are many; none may go missing from this test unseen.
    assert tried >= 20


def test_a_nul_in_the_search_finds_nothing_instead_of_failing(client: TestClient, operator: Account, vault: Path) -> None:
    (vault / "S").mkdir()
    (vault / "S" / "a.md").write_bytes(b"# a\n\nzucchini\n")
    index.scan()
    for query in ("\x00", "zuc\x00", 'zuc"\x00*'):
        answer = client.get("/api/search", params={"q": query})
        assert answer.status_code == 200, query
    # The NUL is left out: what stays is searched for.
    assert [hit["path"] for hit in client.get("/api/search", params={"q": "zuc\x00chini"}).json()] == ["S/a.md"]
    assert [hit["path"] for hit in client.get("/api/search", params={"q": "zucchini\x00"}).json()] == ["S/a.md"]


@pytest.fixture
def normal_mode_afterwards() -> Iterator[None]:
    yield
    logs.apply_mode(logs.DEFAULT_MODE)


@pytest.mark.parametrize("mode", ["detailed", "trace"])
def test_the_deepest_log_levels_hold_no_note_text_and_no_hash(
    client: TestClient, operator: Account, vault: Path, mode: str, normal_mode_afterwards: None
) -> None:
    """SQLAlchemy writes every statement with its values from INFO on: note texts, password and key hashes."""
    (vault / "S").mkdir()
    index.scan()
    assert client.put("/api/logs/level", json={"mode": mode}).status_code == 200
    made = client.post("/api/notes", json={"folder": "S", "title": "Private", "content": "quetzalcoatl-secret"})
    assert made.status_code in (200, 201), made.text
    with SessionLocal() as db:
        settings_service.save(db, {"mcp_allowed": True})
    token = client.post("/api/mcp/keys", json={"name": "k", "level": "read"}).json()["token"]
    # A statement that fails names its values in its exception, and exceptions reach the log.
    with SessionLocal() as db, pytest.raises(IntegrityError) as failed:
        db.execute(insert(McpKey).values(account_id=operator.id, name="x", level="read",
                                         token_hash=mcp.digest(token), prefix="p"))
    assert mcp.digest(token) not in str(failed.value)
    text = logs.log_file().read_text(encoding="utf-8")
    assert "quetzalcoatl" not in text
    assert mcp.digest(token) not in text
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
    assert row.password_hash not in text


def test_a_text_for_a_note_that_is_not_utf8_goes_into_a_copy(client: TestClient, operator: Account, vault: Path) -> None:
    """The page shows such a note read only, but the server took a save from anybody and replaced its bytes."""
    (vault / "S").mkdir()
    original = b"caf" + bytes([0xE9, 0xFF, 0x80]) + b" latin\r\n"
    (vault / "S" / "old.md").write_bytes(original)
    index.scan()
    note = client.get("/api/note", params={"path": "S/old.md"}).json()
    assert note["readonly"] is True
    saved = client.put("/api/note", json={"path": "S/old.md", "content": "overwritten", "base_hash": note["hash"]})
    assert saved.status_code == 200
    assert saved.json()["conflict"] is not None
    assert (vault / "S" / "old.md").read_bytes() == original
    copy = saved.json()["conflict"]
    assert vault.joinpath(*copy.split("/")).read_bytes() == b"overwritten"


def test_a_backup_is_downloaded_by_the_operator_with_the_password_only(
    client: TestClient, operator: Account, vault: Path
) -> None:
    """There was no way to get a backup off the machine it was made on, short of a shell on the host."""
    (vault / "S").mkdir()
    (vault / "S" / "a.md").write_bytes(b"# a\n")
    index.scan()
    name = client.post("/api/backups", json={"note": "for elsewhere"}).json()["name"]
    wrong = client.post(f"/api/backups/{name}/download", json={"password": "not it"})
    assert wrong.status_code == 401 and wrong.json()["detail"]["code"] == "wrong_password"
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None and row.failed_logins == 1
    right = client.post(f"/api/backups/{name}/download", json={"password": PASSWORD})
    assert right.status_code == 200
    assert right.headers["content-type"] == "application/zip"
    assert name in right.headers["content-disposition"]
    assert right.content == backups.path_of(name).read_bytes()
    # A name of the right form that is not there.
    other = name[:-5] + ("0" if name[-5] != "0" else "1") + name[-4:]
    missing = client.post(f"/api/backups/{other}/download", json={"password": PASSWORD})
    assert missing.status_code == 404
    member = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-member00"})
    sign_in(member, make_account("anna"))
    assert member.post(f"/api/backups/{name}/download", json={"password": PASSWORD}).status_code == 403


def _staged(vault: Path) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """A vault of three spaces, a backup of it, then changes: what the vault holds now, and what the backup holds."""
    for space in ("A", "B", "C"):
        (vault / space).mkdir()
        (vault / space / "n.md").write_bytes(f"backup {space}\n".encode())
    index.scan()
    archive = backups.create()
    for space in ("A", "B", "C"):
        (vault / space / "n.md").write_bytes(f"now {space}\n".encode())
    index.scan()
    backups.stage_restore(archive.name)

    def files(root: Path) -> dict[str, bytes]:
        return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}

    return files(vault), files(backups.pending_folder() / "vault")


@pytest.mark.parametrize("step", ["setting the old aside", "bringing the backup in"])
def test_a_restore_that_fails_half_way_puts_the_vault_back_as_it_was(
    vault: Path, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    """Failing while the old files were still being set aside, the way back moved old files among the backup's."""
    now, staged = _staged(vault)
    real_rename, real_move = os.rename, shutil.move
    calls = {"rename": 0, "move": 0}

    def rename(source: object, target: object) -> None:
        calls["rename"] += 1
        if step == "setting the old aside" and calls["rename"] == 2:
            raise PermissionError("held open by another program")
        real_rename(source, target)  # type: ignore[arg-type]

    def move(source: str, target: str) -> object:
        calls["move"] += 1
        if step == "bringing the backup in" and calls["move"] == 2:
            raise PermissionError("held open by another program")
        return real_move(source, target)

    monkeypatch.setattr(os, "rename", rename)
    monkeypatch.setattr(shutil, "move", move)
    with pytest.raises(OSError):
        backups.apply_pending()
    monkeypatch.undo()
    after = {path.relative_to(vault).as_posix(): path.read_bytes() for path in vault.rglob("*") if path.is_file()}
    assert after == now
    pending = backups.pending_folder() / "vault"
    assert {path.relative_to(pending).as_posix(): path.read_bytes() for path in pending.rglob("*") if path.is_file()} == staged
    # And a later start that can move everything restores the backup.
    assert backups.apply_pending() is True
    assert (vault / "B" / "n.md").read_bytes() == b"backup B\n"


def test_mcp_marks_hits_so_that_bold_text_stays_readable_and_refuses_an_unknown_protocol_version(
    client: TestClient, operator: Account, vault: Path
) -> None:
    (vault / "S").mkdir()
    (vault / "S" / "b.md").write_bytes(b"A note about **data intensive applications**.\n")
    index.scan()
    with SessionLocal() as db:
        settings_service.save(db, {"mcp_allowed": True})
    token = client.post("/api/mcp/keys", json={"name": "k", "level": "read"}).json()["token"]
    program = TestClient(app, base_url="http://testserver")
    headers = {"Authorization": f"Bearer {token}"}
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "search", "arguments": {"query": "applications"}}}
    answer = program.post("/api/mcp", json=call, headers=headers).json()["result"]
    text = answer["content"][0]["text"]
    assert "«applications»" in text and "****" not in text, text
    for version, status in (("2025-06-18", 200), ("2024-11-05", 200), ("1999-01-01", 400)):
        ping = program.post("/api/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "ping"},
                            headers=headers | {"MCP-Protocol-Version": version})
        assert ping.status_code == status, version


# --- Acts on another account ask for the operator's password once more (design answer, 28.09.2026) ------------------

ACTS = {
    "password": ("PUT", "/api/accounts/{id}/password", {"password": "a brand new password"}),
    "role": ("PUT", "/api/accounts/{id}/role", {"role": "operator"}),
    "second factor": ("POST", "/api/accounts/{id}/totp/reset", {}),
    "delete": ("DELETE", "/api/accounts/{id}", {}),
}


def _anna_as_she_was() -> tuple[int, tuple[object, ...]]:
    anna = make_account("anna")
    with SessionLocal() as db:
        row = db.get(Account, anna.id)
        assert row is not None
        row.totp_secret_enc = "sealed seed"
        db.commit()
    return anna.id, _state_of(anna.id)


def _state_of(account_id: int) -> tuple[object, ...]:
    with SessionLocal() as db:
        row = db.get(Account, account_id)
        if row is None:
            return ("gone",)
        return (row.role, row.password_hash, row.totp_secret_enc)


def _failures(account_id: int) -> int:
    with SessionLocal() as db:
        row = db.get(Account, account_id)
        assert row is not None
        return row.failed_logins


@pytest.mark.parametrize("act", ACTS)
def test_the_operator_acts_on_another_account_only_with_the_password_once_more(
    client: TestClient, operator: Account, act: str
) -> None:
    """A stolen operator session gave another account a new password (and so its private spaces) in one request."""
    method, path, body = ACTS[act]
    anna_id, before = _anna_as_she_was()
    url = path.format(id=anna_id)
    for given in ({}, {"current_password": ""}, {"current_password": "not the password"}):
        refused = client.request(method, url, json={**body, **given})
        assert refused.status_code == 401 and refused.json()["detail"]["code"] == "wrong_password"
        assert _state_of(anna_id) == before
    # Counted like a failed sign-in, and still signed in.
    assert _failures(operator.id) == 3
    assert client.get("/api/auth/me").status_code == 200
    done = client.request(method, url, json={**body, "current_password": PASSWORD})
    assert done.status_code in (200, 204)
    assert _state_of(anna_id) != before
    assert _failures(operator.id) == 0


def test_an_operator_from_the_provider_is_not_asked_for_a_password_it_has_not_got(
    client: TestClient, operator: Account
) -> None:
    with SessionLocal() as db:
        row = db.get(Account, operator.id)
        assert row is not None
        row.sign_in = "oidc"
        db.commit()
    anna_id, before = _anna_as_she_was()
    assert client.put(f"/api/accounts/{anna_id}/role", json={"role": "operator"}).status_code == 200
    assert _state_of(anna_id) != before
