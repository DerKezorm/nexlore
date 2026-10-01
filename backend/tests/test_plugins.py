"""Plugins (M7): the checked catalog, installing and letting out, switching on per account, the locked frame, and
the few routes a plugin reaches through the page, each with the account's own rights.

The world: the operator ``tester``; ``anna`` writes in ``Garden``; ``bob`` has ``Secret``, which anna may not read.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import File, Version
from app.services import index, plugins, settings_service

from .conftest import join, make_account, sign_in

NOTE = "---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] Dig\n- [ ] Plant\n\n## Done\n\n- [x] Buy seeds\r\n"


def person(name: str) -> TestClient:
    row = make_account(name)
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, row)
    return client


class World:
    def __init__(self, operator: TestClient, vault: Path) -> None:
        self.operator = operator
        self.vault = vault
        self.anna = person("anna")
        self.bob = person("bob")
        assert self.anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
        assert self.bob.post("/api/spaces", json={"name": "Secret"}).status_code == 201
        (vault / "Garden" / "Board.md").write_bytes(NOTE.encode())
        (vault / "Garden" / "Beds.md").write_bytes(b"# Beds\n\n#veg in rows\n")
        (vault / "Secret" / "Hidden.md").write_bytes(b"# Hidden\n\n#veg secret rows\n")
        index.scan()

    def ready(self, plugin_id: str, who: TestClient | None = None) -> None:
        """Installed, let out and switched on for anna (or ``who``)."""
        assert self.operator.post(f"/api/admin/plugins/{plugin_id}/install").status_code == 200
        assert self.operator.put(f"/api/admin/plugins/{plugin_id}", json={"approved": True}).status_code == 200
        assert (who or self.anna).put(f"/api/plugins/{plugin_id}/enabled", json={"enabled": True}).status_code == 200


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    return World(client, vault)


# --- The catalog -------------------------------------------------------------------------------------------------------


def test_the_catalog_holds_four_plugins_with_their_pinned_hashes() -> None:
    entries = plugins.catalog()
    assert sorted(entry.manifest["id"] for entry in entries) == ["kanban", "query", "rediscover", "toc"]
    for entry in entries:
        assert entry.manifest["name"]["en"] and entry.manifest["name"]["de"]
        assert entry.manifest["strings"]["en"].keys() == entry.manifest["strings"]["de"].keys(), entry.manifest["id"]


def test_a_changed_catalog_file_is_left_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    copy = tmp_path / "catalog"
    shutil.copytree(plugins.CATALOG_DIR, copy)
    (copy / "toc" / "main.js").write_bytes((copy / "toc" / "main.js").read_bytes() + b"\n// one line more\n")
    monkeypatch.setattr(plugins, "CATALOG_DIR", copy)
    assert "toc" not in [entry.manifest["id"] for entry in plugins.catalog()]
    with pytest.raises(plugins.PluginError):
        plugins.from_catalog("toc")


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"id": "Bad Id"}, "id"),
        ({"version": "one"}, "version"),
        ({"permissions": ["network"]}, "permission"),
        ({"place": {"block": "dataview"}}, "language"),
        ({"place": {"panel": True, "block": "x"}}, "exactly one"),
        ({"name": {"de": "nur deutsch"}}, "English"),
    ],
)
def test_a_manifest_is_checked(change: dict, fragment: str) -> None:
    good = {"id": "mine", "version": "1.0.0", "name": {"en": "Mine"}, "permissions": [], "place": {"panel": True}}
    with pytest.raises(plugins.PluginError) as caught:
        plugins.check_manifest({**good, **change})
    assert fragment in caught.value.text
    assert plugins.check_manifest(good)["id"] == "mine"


def test_code_that_would_break_out_of_its_script_is_refused() -> None:
    with pytest.raises(plugins.PluginError):
        plugins.check_code(b"console.log('</script><script>alert(1)')")
    with pytest.raises(plugins.PluginError):
        plugins.check_code(b"x" * (plugins.MAX_CODE + 1))


# --- Installing, letting out, switching on ------------------------------------------------------------------------------


def test_only_the_operator_installs_and_nothing_is_on_until_let_out_and_switched_on(world: World) -> None:
    assert world.anna.post("/api/admin/plugins/toc/install").status_code == 403
    assert world.operator.post("/api/admin/plugins/toc/install").status_code == 200
    assert world.anna.get("/api/plugins").json() == []  # installed, not let out
    assert world.anna.put("/api/plugins/toc/enabled", json={"enabled": True}).status_code == 404
    assert world.operator.put("/api/admin/plugins/toc", json={"approved": True}).status_code == 200
    listed = world.anna.get("/api/plugins").json()
    assert [(item["id"], item["enabled"]) for item in listed] == [("toc", False)]
    assert world.anna.get("/api/plugins/toc/frame").status_code == 404  # not switched on
    assert world.anna.put("/api/plugins/toc/enabled", json={"enabled": True}).status_code == 200
    assert world.anna.get("/api/plugins/toc/frame").status_code == 200
    # Switched on by anna is not switched on for bob.
    assert world.bob.get("/api/plugins/toc/frame").status_code == 404
    # Held back again: off for everybody at once.
    assert world.operator.put("/api/admin/plugins/toc", json={"approved": False}).status_code == 200
    assert world.anna.get("/api/plugins/toc/frame").status_code == 404
    assert world.operator.delete("/api/admin/plugins/toc").status_code == 204
    assert world.operator.get("/api/admin/plugins").json()["installed"] == []


def test_the_frame_is_locked_up(world: World) -> None:
    world.ready("toc")
    answer = world.anna.get("/api/plugins/toc/frame")
    policies = answer.headers.get_list("content-security-policy")
    assert len(policies) == 1, policies  # the frame's own, not the app's on top
    policy = policies[0]
    for part in ("sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'",
                 "base-uri 'none'", "frame-ancestors 'self'", "img-src data: blob:"):
        assert part in policy
    assert "allow-same-origin" not in policy and "unsafe-eval" not in policy and "http" not in policy
    assert answer.headers["x-frame-options"] == "SAMEORIGIN"
    assert answer.headers["referrer-policy"] == "no-referrer"
    # Exactly the two inline scripts run, by their hashes.
    scripts = re.findall(r"<script>(.*?)</script>", answer.text, re.DOTALL)
    assert len(scripts) == 2 and "<script src" not in answer.text
    for script in scripts:
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        assert f"'sha256-{digest}'" in policy


def test_uploading_a_plugin_of_ones_own_needs_the_latch(world: World) -> None:
    body = {"manifest": {"id": "mine", "version": "1.0.0", "name": {"en": "Mine"}, "permissions": ["note:read"],
                         "place": {"panel": True}}, "code": "nexlore.ready(function () {})"}
    assert world.operator.post("/api/admin/plugins", json=body).status_code == 403
    with SessionLocal() as db:
        settings_service.save(db, {"plugin_upload_allowed": True})
    assert world.anna.post("/api/admin/plugins", json=body).status_code == 403
    made = world.operator.post("/api/admin/plugins", json=body)
    assert made.status_code == 201 and made.json()["source"] == "upload"
    clash = {**body, "manifest": {**body["manifest"], "id": "toc"}}
    assert world.operator.post("/api/admin/plugins", json=clash).status_code == 409
    assert world.operator.post("/api/admin/plugins", json={**body, "code": "a</SCRIPT>b"}).status_code == 400


# --- What a plugin reaches through the page ------------------------------------------------------------------------------


def test_lists_for_plugins_show_only_readable_notes(world: World) -> None:
    listed = world.anna.get("/api/plugins/query", params={"tag": "veg"}).json()
    assert [item["path"] for item in listed] == ["Garden/Beds.md"]
    assert world.anna.get("/api/plugins/query", params={"folder": "Secret"}).json() == []
    assert {item["path"] for item in world.bob.get("/api/plugins/query", params={"tag": "#veg"}).json()} == {
        "Secret/Hidden.md"
    }
    assert len(world.anna.get("/api/plugins/query", params={"random": True, "limit": 1}).json()) == 1
    assert world.anna.get("/api/plugins/query", params={"day": "1999-01-01"}).json() == []
    # A day that the pattern lets through but no calendar has: refused, not a server error.
    assert world.anna.get("/api/plugins/query", params={"day": "2026-13-40"}).status_code == 422


def test_a_day_finds_the_notes_changed_on_it_and_the_daily_note_named_after_it(world: World) -> None:
    """What rediscover asks for: "a year ago today" (UTC days, both ends measured)."""
    changed = world.vault / "Garden" / "Old.md"
    changed.write_bytes(b"# Old\n")
    late = world.vault / "Garden" / "Late.md"
    late.write_bytes(b"# Late\n")
    first = datetime(2025, 9, 28, 0, 0, 1, tzinfo=UTC).timestamp()
    os.utime(changed, (first, first))
    next_day = datetime(2025, 9, 29, 0, 0, 1, tzinfo=UTC).timestamp()
    os.utime(late, (next_day, next_day))
    (world.vault / "Garden" / "2025-09-28.md").write_bytes(b"# That day\n")
    index.scan()
    found = {item["path"] for item in world.anna.get("/api/plugins/query", params={"day": "2025-09-28"}).json()}
    assert found == {"Garden/Old.md", "Garden/2025-09-28.md"}


def test_a_plugin_writes_its_note_keeping_unchanged_lines(world: World) -> None:
    world.ready("kanban")
    base = index.digest(NOTE.encode())
    moved = NOTE.replace("- [ ] Dig\n", "").replace("## Done\n\n", "## Done\n\n- [ ] Dig\n").replace("\r\n", "\n")
    saved = world.anna.put("/api/plugins/note", json={"plugin": "kanban", "path": "Garden/Board.md",
                                                       "content": moved, "base_hash": base})
    assert saved.status_code == 200 and saved.json()["saved"] is True
    on_disk = (world.vault / "Garden" / "Board.md").read_bytes()
    assert on_disk.endswith(b"- [x] Buy seeds\r\n")  # its own line ending, untouched
    # A new line takes the file's line ending: this note has a Windows one, so the moved card gets it too.
    assert b"## Done\n\n- [ ] Dig\r\n- [x]" in on_disk
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == "Garden/Board.md"))
        newest = db.scalars(select(Version).where(Version.file_id == file_id).order_by(Version.id.desc())).first()
    assert (newest.source, newest.author) == (index.PLUGIN, "anna")


def test_a_plugin_writing_an_old_state_gets_a_conflict_copy(world: World) -> None:
    world.ready("kanban")
    base = index.digest(NOTE.encode())
    (world.vault / "Garden" / "Board.md").write_bytes(b"changed meanwhile")
    index.scan()
    saved = world.anna.put("/api/plugins/note", json={"plugin": "kanban", "path": "Garden/Board.md",
                                                       "content": "mine", "base_hash": base}).json()
    assert saved["saved"] is False and saved["conflict"].startswith("Garden/Board (conflict ")
    assert (world.vault / "Garden" / "Board.md").read_bytes() == b"changed meanwhile"


def test_writing_needs_a_plugin_that_may_write_and_the_right_to_write(world: World) -> None:
    base = index.digest(NOTE.encode())
    body = {"plugin": "toc", "path": "Garden/Board.md", "content": "x", "base_hash": base}
    world.ready("toc")  # switched on, but it may only read
    assert world.anna.put("/api/plugins/note", json=body).status_code == 404
    world.ready("kanban", who=world.bob)
    body = {**body, "plugin": "kanban"}
    assert world.bob.put("/api/plugins/note", json=body).status_code == 404  # bob may not read Garden
    carl = person("carl")
    join(world.anna, "Garden", "carl", "read")
    assert carl.put("/api/plugins/kanban/enabled", json={"enabled": True}).status_code == 200
    assert carl.put("/api/plugins/note", json=body).status_code == 403
    assert (world.vault / "Garden" / "Board.md").read_bytes() == NOTE.encode()


def test_the_frame_takes_the_colour_scheme_of_the_page(world: World) -> None:
    """Review P1.4: in the scheme of the system, not the page's, the frame got a white or black ground of its own."""
    world.ready("toc")
    assert "color-scheme: light;" in world.anna.get("/api/plugins/toc/frame?scheme=light").text
    assert "color-scheme: dark;" in world.anna.get("/api/plugins/toc/frame").text
    assert world.anna.get("/api/plugins/toc/frame?scheme=dark%20light").status_code == 422
