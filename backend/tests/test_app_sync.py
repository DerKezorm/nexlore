"""Syncing with the iPhone app (blocks S2 to S4): the change counter, ``/changes`` and ``/wait``, reading with
``/fetch``, ``/files`` and ``/notes/{id}/base``, writing with ``/batch`` and uploads.

The world: ``anna`` manages ``Garden`` and reads ``Shared`` (bob's); ``Secret`` is bob's alone and must look like a
space that does not exist.
"""

from __future__ import annotations

import threading
import time
import uuid
import zlib
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.db import SessionLocal, engine
from app.models import AppOp, DeviceBase, File, GoneFile, Version, utcnow
from app.routers import app1
from app.services import cursor, index, vault
from app.services.vault import Actor

from .conftest import join
from .test_app_pairing import bearer, pair, phone
from .test_mcp import person

PLAN = b"# Plan\n\nSee [[Beans]].\n"
BEANS = b"# Beans\n\nBack to [[Plan]].\n"


class World:
    def __init__(self, vault_dir: Path) -> None:
        self.vault = vault_dir
        self.anna = person("anna")
        self.bob = person("bob")
        for owner, name in ((self.anna, "Garden"), (self.bob, "Secret"), (self.bob, "Shared")):
            assert owner.post("/api/spaces", json={"name": name}).status_code == 201
        join(self.bob, "Shared", "anna", "read")
        (vault_dir / "Garden" / "Plan.md").write_bytes(PLAN)
        (vault_dir / "Garden" / "Beans.md").write_bytes(BEANS)
        (vault_dir / "Garden" / "Attachments").mkdir()
        (vault_dir / "Garden" / "Attachments" / "photo.bin").write_bytes(bytes(range(256)) * 40)
        (vault_dir / "Secret" / "Diary.md").write_bytes(b"# Diary\n")
        (vault_dir / "Shared" / "Rules.md").write_bytes(b"# Rules\n")
        index.scan()
        self.key = pair(self.anna)
        self.phone = phone()

    def get(self, url: str, **params: Any) -> Any:
        return self.phone.get(url, params=params, headers=bearer(self.key))

    def post(self, url: str, body: Any) -> Any:
        return self.phone.post(url, json=body, headers=bearer(self.key))

    def ops(self, *ops: dict[str, Any]) -> list[dict[str, Any]]:
        answer = self.post("/api/app/1/batch", {"ops": [{"op_id": str(uuid.uuid4()), **op} for op in ops]})
        assert answer.status_code == 200, answer.text
        return answer.json()["results"]

    def id_of(self, rel: str) -> int:
        with SessionLocal() as db:
            found = db.scalar(select(File.id).where(File.path == rel))
        assert found is not None, rel
        return found

    def hash_of(self, rel: str) -> str:
        return index.digest((self.vault / rel).read_bytes())

    def changes(self, since: int = 0, limit: int = 500) -> dict[str, Any]:
        answer = self.get("/api/app/1/changes", since=since, limit=limit)
        assert answer.status_code == 200, answer.text
        return answer.json()

    def last(self) -> int:
        with SessionLocal() as db:
            return cursor.state(db.connection())[0]


@pytest.fixture
def world(client: TestClient, operator: object, vault: Path) -> World:
    return World(vault)


ACTOR = Actor(name="anna", client="tab-elsewhere")


# --- S2: the cursor --------------------------------------------------------------------------------------------------


def test_since_zero_is_the_whole_readable_vault(world: World) -> None:
    got = world.changes()
    paths = {item["path"] for item in got["items"]}
    assert paths == {"Garden/Plan.md", "Garden/Beans.md", "Garden/Attachments/photo.bin", "Shared/Rules.md"}
    plan = next(item for item in got["items"] if item["path"] == "Garden/Plan.md")
    assert plan["space"] == "Garden" and plan["kind"] == "note" and plan["deleted"] is False
    assert plan["hash"] == index.digest(PLAN) and plan["size"] == len(PLAN)
    assert plan["mtime"].endswith("Z") or plan["mtime"].endswith("+00:00")
    photo = next(item for item in got["items"] if item["path"].endswith("photo.bin"))
    assert photo["kind"] == "file"
    assert got["more"] is False and got["cursor"] == world.last()
    assert {space["name"] for space in got["spaces"]} == {"Garden", "Shared"}


def test_pages_follow_one_another_without_gaps(world: World) -> None:
    first = world.changes(limit=3)
    assert first["more"] is True and len(first["items"]) == 3
    second = world.changes(first["cursor"], limit=3)
    assert second["more"] is False
    seen = [item["id"] for item in first["items"] + second["items"]]
    assert len(seen) == len(set(seen)) == 4


@pytest.mark.parametrize("change", ["save", "create", "move", "delete", "restore", "outside", "watcher", "gone"])
def test_every_kind_of_change_moves_the_cursor(world: World, change: str) -> None:
    before = world.changes()["cursor"]
    plan = "Garden/Plan.md"
    if change == "save":
        vault.save(plan, b"# Plan\n\nnew\n", base_hash=world.hash_of(plan), actor=ACTOR)
    elif change == "create":
        vault.create_note("Garden", "Peas", b"# Peas\n", actor=ACTOR)
    elif change == "move":
        vault.move(plan, "Garden/Ideas/Plan.md", actor=ACTOR)
    elif change == "delete":
        vault.delete_path(plan, actor=ACTOR)
    elif change == "restore":
        vault.delete_path(plan, actor=ACTOR)
        before = world.changes(before)["cursor"]
        vault.restore_trash(f"f-{world.id_of(plan)}", actor=ACTOR)
    elif change == "outside":
        (world.vault / plan).write_bytes(b"# Plan\n\nwritten by another program\n")
        index.scan()
    elif change == "watcher":
        (world.vault / "Garden" / "Outside.md").write_bytes(b"# Outside\n")
        index.refresh(["Garden/Outside.md"])
    elif change == "gone":
        (world.vault / plan).unlink()
        index.refresh([plan])
    after = world.changes(before)
    assert after["cursor"] > before
    assert after["items"], change
    if change in ("delete", "gone"):
        assert after["items"][0]["deleted"] is True and after["items"][0]["id"] == world.id_of(plan)


def test_an_unchanged_save_moves_nothing(world: World) -> None:
    before = world.changes()["cursor"]
    vault.save("Garden/Plan.md", PLAN, base_hash=world.hash_of("Garden/Plan.md"), actor=ACTOR)
    index.scan()
    got = world.changes(before)
    assert (got["items"], got["cursor"], got["more"]) == ([], before, False)


def test_a_rename_keeps_the_id_and_shows_once(world: World) -> None:
    before = world.changes()["cursor"]
    plan_id = world.id_of("Garden/Plan.md")
    vault.save("Garden/Plan.md", b"# Plan\n\nedited\n", base_hash=world.hash_of("Garden/Plan.md"), actor=ACTOR)
    vault.move("Garden/Plan.md", "Garden/Plan B.md", actor=ACTOR)
    items = world.changes(before)["items"]
    plans = [item for item in items if item["id"] == plan_id]
    assert len(plans) == 1 and plans[0]["path"] == "Garden/Plan B.md"
    # Beans links to it: rewritten, it comes with its new hash.
    beans = next(item for item in items if item["path"] == "Garden/Beans.md")
    assert beans["hash"] == world.hash_of("Garden/Beans.md") != index.digest(BEANS)


def test_secret_changes_never_show(world: World) -> None:
    before = world.changes()["cursor"]
    vault.save("Secret/Diary.md", b"# Diary\n\nprivate\n", base_hash=world.hash_of("Secret/Diary.md"), actor=ACTOR)
    got = world.changes(before)
    assert got["items"] == [] and got["cursor"] > before


def test_an_outside_move_keeps_the_id_and_tells_the_fresh_row_as_gone(world: World) -> None:
    before = world.changes()["cursor"]
    plan_id = world.id_of("Garden/Plan.md")
    (world.vault / "Garden" / "Plan.md").rename(world.vault / "Garden" / "Moved.md")
    index.scan()
    items = world.changes(before)["items"]
    moved = [item for item in items if item["id"] == plan_id]
    assert moved and moved[-1]["path"] == "Garden/Moved.md" and moved[-1]["deleted"] is False
    with SessionLocal() as db:
        gone = db.scalars(select(GoneFile)).all()
    assert len(gone) == 1
    told = [item for item in items if item["id"] == gone[0].file_id]
    assert told == [{**told[0], "deleted": True, "path": "Garden/Moved.md"}]


def test_too_old_and_unknown_cursors_are_refused(world: World) -> None:
    start = world.changes()["cursor"]
    vault.delete_path("Garden/Beans.md", actor=ACTOR)
    after_delete = world.changes(start)["cursor"]
    assert world.get("/api/app/1/changes", since=after_delete + 1000).json()["detail"]["code"] == "cursor_expired"
    with SessionLocal() as db:
        db.execute(update(File).where(File.deleted_at.is_not(None)).values(deleted_at=utcnow() - timedelta(days=40)))
        db.commit()
    vault.purge_expired()
    expired = world.get("/api/app/1/changes", since=start)
    assert expired.status_code == 410 and expired.json()["detail"]["code"] == "cursor_expired"
    # Whoever saw the delete goes on; since=0 always works.
    assert world.get("/api/app/1/changes", since=after_delete).status_code == 200
    assert world.get("/api/app/1/changes", since=0).status_code == 200


def test_old_gone_rows_go_and_raise_the_oldest_cursor(world: World) -> None:
    start = world.changes()["cursor"]
    (world.vault / "Garden" / "Plan.md").rename(world.vault / "Garden" / "Moved.md")
    index.scan()
    with SessionLocal() as db:
        db.execute(update(GoneFile).values(gone_at=utcnow() - timedelta(days=40)))
        db.commit()
    vault.purge_expired()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(GoneFile)) == 0
    assert world.get("/api/app/1/changes", since=start).status_code == 410


def test_a_new_file_never_takes_the_id_of_one_gone_for_good(world: World) -> None:
    made = vault.create_note("Garden", "Short lived", b"x", actor=ACTOR)
    vault.delete_path(made.path, actor=ACTOR)
    vault.purge_trash(f"f-{made.id}")
    again = vault.create_note("Garden", "Next", b"y", actor=ACTOR)
    assert again.id > made.id


def test_rows_from_before_the_counter_get_a_number(world: World) -> None:
    with SessionLocal() as db:
        db.execute(update(File).values(cursor=0))
        db.commit()

    with engine.begin() as connection:
        assert cursor.number_existing(connection) > 0
    with SessionLocal() as db:
        numbers = db.scalars(select(File.cursor)).all()
    assert 0 not in numbers and len(set(numbers)) == len(numbers)
    assert max(numbers) <= world.last()


def test_wait_answers_at_once_when_behind_and_after_its_time_with_the_same(world: World,
                                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app1, "WAIT_SECONDS", 0.6)
    last = world.last()
    assert world.get("/api/app/1/wait", cursor=last - 1).json() == {"cursor": last}
    began = time.monotonic()
    assert world.get("/api/app/1/wait", cursor=last).json() == {"cursor": last}
    assert time.monotonic() - began >= 0.5


def test_wait_wakes_up_on_a_change(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app1, "WAIT_SECONDS", 10)
    last = world.last()

    def later() -> None:
        time.sleep(0.4)
        vault.create_note("Garden", "Late", b"late", actor=ACTOR)

    threading.Thread(target=later).start()
    began = time.monotonic()
    got = world.get("/api/app/1/wait", cursor=last).json()
    assert got["cursor"] > last and time.monotonic() - began < 5


def test_while_the_vault_is_read_in_the_first_time_the_app_waits(world: World,
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(index.status, "running", True)
    monkeypatch.setattr(index.status, "first", True)
    for answer in (world.get("/api/app/1/changes"), world.post("/api/app/1/batch", {"ops": []}),
                   world.post("/api/app/1/fetch", {"ids": []})):
        assert answer.status_code == 503 and answer.json()["detail"]["code"] == "scan_running"
        assert answer.headers["retry-after"]
    assert world.get("/api/app/1/me").status_code == 200


# --- S3: reading -------------------------------------------------------------------------------------------------


def test_fetch_hands_out_notes_and_leaves_out_what_does_not_exist(world: World) -> None:
    plan, secret = world.id_of("Garden/Plan.md"), world.id_of("Secret/Diary.md")
    photo, rules = world.id_of("Garden/Attachments/photo.bin"), world.id_of("Shared/Rules.md")
    got = world.post("/api/app/1/fetch", {"ids": [plan, secret, photo, 999999, rules, plan]}).json()
    assert [note["id"] for note in got["notes"]] == [plan, rules]
    assert got["notes"][0] == {"id": plan, "path": "Garden/Plan.md", "hash": index.digest(PLAN),
                               "text": PLAN.decode()}
    assert got["missing"] == []
    too_many = world.post("/api/app/1/fetch", {"ids": list(range(201))})
    assert too_many.status_code == 422


def test_fetch_stops_at_its_size_and_names_the_rest(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app1, "FETCH_BYTES", len(PLAN) + 5)
    plan, beans, rules = (world.id_of(rel) for rel in ("Garden/Plan.md", "Garden/Beans.md", "Shared/Rules.md"))
    got = world.post("/api/app/1/fetch", {"ids": [plan, beans, rules]}).json()
    assert [note["id"] for note in got["notes"]] == [plan]
    assert got["missing"] == [beans, rules]


def test_files_are_handed_out_with_their_hash_and_in_ranges(world: World) -> None:
    rel = "Garden/Attachments/photo.bin"
    photo = world.id_of(rel)
    whole = world.get(f"/api/app/1/files/{photo}")
    assert whole.status_code == 200
    assert whole.content == (world.vault / rel).read_bytes()
    assert whole.headers["etag"] == f'"{world.hash_of(rel)}"'
    same = world.phone.get(f"/api/app/1/files/{photo}", headers={**bearer(world.key),
                                                                  "If-None-Match": whole.headers["etag"]})
    assert same.status_code == 304
    part = world.phone.get(f"/api/app/1/files/{photo}", headers={**bearer(world.key), "Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == bytes(range(10, 20))
    assert world.get(f"/api/app/1/files/{world.id_of('Secret/Diary.md')}").json()["detail"]["code"] == "not_found"


def test_the_base_comes_from_the_device_first_then_from_the_versions(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    world.post("/api/app/1/fetch", {"ids": [plan]})
    # The browser saves twice in a row: one version, folded, and the fetched state is in no version but the first.
    first = b"# Plan\n\none\n"
    vault.save("Garden/Plan.md", first, base_hash=index.digest(PLAN), actor=ACTOR)
    vault.save("Garden/Plan.md", b"# Plan\n\ntwo\n", base_hash=index.digest(first), actor=ACTOR)
    got = world.get(f"/api/app/1/notes/{plan}/base", hash=index.digest(PLAN))
    assert got.json() == {"hash": index.digest(PLAN), "text": PLAN.decode()}
    with SessionLocal() as db:
        db.execute(DeviceBase.__table__.delete())
        db.commit()
    from_versions = world.get(f"/api/app/1/notes/{plan}/base", hash=index.digest(PLAN))
    assert from_versions.status_code == 200  # the first version of the scan
    lost = world.get(f"/api/app/1/notes/{plan}/base", hash=index.digest(first))
    assert lost.status_code == 404 and lost.json()["detail"]["code"] == "not_found"
    secret = world.get(f"/api/app/1/notes/{world.id_of('Secret/Diary.md')}/base",
                       hash=world.hash_of("Secret/Diary.md"))
    assert secret.status_code == 404


def test_bases_keep_one_per_note_and_go_with_device_and_file(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    world.post("/api/app/1/fetch", {"ids": [plan]})
    world.ops({"type": "update", "id": plan, "base_hash": index.digest(PLAN), "text": "# Plan\n\nfrom the phone\n"})
    with SessionLocal() as db:
        rows = db.scalars(select(DeviceBase)).all()
        assert len(rows) == 1 and zlib.decompress(rows[0].content) == b"# Plan\n\nfrom the phone\n"
    vault.delete_path("Garden/Plan.md", actor=ACTOR)
    vault.purge_trash(f"f-{plan}")
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(DeviceBase)) == 0
    beans = world.id_of("Garden/Beans.md")
    world.post("/api/app/1/fetch", {"ids": [beans]})
    assert world.phone.delete("/api/app/1/device", headers=bearer(world.key)).status_code == 204
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(DeviceBase)) == 0


# --- S4: writing -------------------------------------------------------------------------------------------------


def test_create_writes_a_version_of_the_app_with_the_device_as_session(world: World) -> None:
    [result] = world.ops({"type": "create", "space": "Garden", "path": "Garden/New/Peas.md", "text": "# Peas\n"})
    assert result["ok"] is True and result["path"] == "Garden/New/Peas.md"
    assert result["hash"] == index.digest(b"# Peas\n") and isinstance(result["id"], int)
    with SessionLocal() as db:
        version = db.scalar(select(Version).where(Version.file_id == result["id"]))
        assert version is not None and version.source == "app" and version.author == "anna"
        assert version.session is not None and version.session.startswith("app-")


def test_create_answers_exists_and_takes_the_same_note_twice_as_success(world: World) -> None:
    same, other = world.ops(
        {"type": "create", "space": "Garden", "path": "Garden/Plan.md", "text": PLAN.decode()},
        {"type": "create", "space": "Garden", "path": "Garden/plan.md", "text": "different"},
    )
    assert same["ok"] is True and same["id"] == world.id_of("Garden/Plan.md")
    assert other == {"op_id": other["op_id"], "ok": False, "code": "exists", "id": world.id_of("Garden/Plan.md"),
                     "hash": index.digest(PLAN)}


@pytest.mark.parametrize(("space", "path", "code"), [
    ("Shared", "Shared/Mine.md", "forbidden"),
    ("Secret", "Secret/Mine.md", "not_found"),
    ("Garden", "Garden/Plain.txt", "bad_path"),
    ("Garden", "Shared/Mine.md", "bad_path"),
    ("Garden", "Garden/../Secret/Mine.md", "bad_path"),
    ("Garden", "Garden/Bad?.md", "bad_path"),
    ("Nowhere", "Nowhere/Mine.md", "not_found"),
])
def test_create_is_refused(world: World, space: str, path: str, code: str) -> None:
    [result] = world.ops({"type": "create", "space": space, "path": path, "text": "x"})
    assert result["ok"] is False and result["code"] == code
    assert not (world.vault / path).exists() or code == "bad_path"


def test_a_note_too_large_is_refused(world: World) -> None:
    big = "x" * (index.MAX_NOTE_BYTES + 1)
    made, changed = world.ops(
        {"type": "create", "space": "Garden", "path": "Garden/Big.md", "text": big},
        {"type": "update", "id": world.id_of("Garden/Plan.md"), "base_hash": index.digest(PLAN), "text": big},
    )
    assert made["code"] == changed["code"] == "too_large"


def test_update_saves_against_its_base_and_refuses_a_stale_one_without_a_copy(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    [saved] = world.ops({"type": "update", "id": plan, "base_hash": index.digest(PLAN), "text": "# Plan\n\nphone\n"})
    assert saved == {"op_id": saved["op_id"], "ok": True, "hash": index.digest(b"# Plan\n\nphone\n")}
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == b"# Plan\n\nphone\n"
    [stale] = world.ops({"type": "update", "id": plan, "base_hash": index.digest(PLAN), "text": "# Plan\n\nlate\n"})
    assert stale == {"op_id": stale["op_id"], "ok": False, "code": "stale", "hash": saved["hash"],
                     "path": "Garden/Plan.md"}
    assert not [name for name in (world.vault / "Garden").iterdir() if "conflict" in name.name]
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == b"# Plan\n\nphone\n"


def test_update_goes_ahead_while_the_browser_holds_the_lock(world: World) -> None:
    assert world.anna.post("/api/locks", json={"path": "Garden/Plan.md"}).status_code == 200
    [saved] = world.ops({"type": "update", "id": world.id_of("Garden/Plan.md"), "base_hash": index.digest(PLAN),
                         "text": "# Plan\n\nphone\n"})
    assert saved["ok"] is True
    assert not [name for name in (world.vault / "Garden").iterdir() if "conflict" in name.name]


def test_update_refuses_the_trash_and_a_space_it_only_reads(world: World) -> None:
    vault.delete_path("Garden/Beans.md", actor=ACTOR)
    beans, rules = world.id_of("Garden/Beans.md"), world.id_of("Shared/Rules.md")
    in_trash, read_only, secret = world.ops(
        {"type": "update", "id": beans, "base_hash": index.digest(BEANS), "text": "x"},
        {"type": "update", "id": rules, "base_hash": world.hash_of("Shared/Rules.md"), "text": "x"},
        {"type": "update", "id": world.id_of("Secret/Diary.md"), "base_hash": "0" * 64, "text": "x"},
    )
    assert (in_trash["code"], read_only["code"], secret["code"]) == ("in_trash", "forbidden", "not_found")


def test_move_rewrites_links_and_names_the_notes_touched(world: World) -> None:
    plan, beans = world.id_of("Garden/Plan.md"), world.id_of("Garden/Beans.md")
    [moved] = world.ops({"type": "move", "id": plan, "path": "Garden/Ideas/Grand plan.md"})
    assert moved == {"op_id": moved["op_id"], "ok": True, "path": "Garden/Ideas/Grand plan.md", "touched": [beans]}
    assert b"Grand plan" in (world.vault / "Garden" / "Beans.md").read_bytes()
    assert world.id_of("Garden/Ideas/Grand plan.md") == plan


def test_move_is_refused(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    vault.delete_path("Garden/Beans.md", actor=ACTOR)
    taken, across, bad, trashed, read_only = world.ops(
        {"type": "move", "id": plan, "path": "Garden/Attachments/photo.bin"},
        {"type": "move", "id": world.id_of("Garden/Plan.md"), "path": "Shared/Plan.md"},
        {"type": "move", "id": world.id_of("Garden/Plan.md"), "path": "Garden/Plan.txt"},
        {"type": "move", "id": world.id_of("Garden/Beans.md"), "path": "Garden/B.md"},
        {"type": "move", "id": world.id_of("Shared/Rules.md"), "path": "Shared/R.md"},
    )
    assert taken["code"] == "exists"
    # A failed operation holds up the later ones of the same note.
    assert across["code"] == bad["code"] == "skipped"
    assert trashed["code"] == "in_trash" and read_only["code"] == "forbidden"
    plan_again = world.ops({"type": "move", "id": plan, "path": "Shared/Plan.md"},
                           {"type": "move", "id": plan, "path": "Garden/Plan.txt"})
    assert [result["code"] for result in plan_again] == ["across_spaces", "skipped"]
    [bad_alone] = world.ops({"type": "move", "id": plan, "path": "Garden/Plan.txt"})
    assert bad_alone["code"] == "bad_path"


def test_delete_goes_to_the_trash_against_its_base(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    [stale] = world.ops({"type": "delete", "id": plan, "base_hash": "0" * 64})
    assert stale == {"op_id": stale["op_id"], "ok": False, "code": "stale", "hash": index.digest(PLAN)}
    gone, again = world.ops({"type": "delete", "id": plan, "base_hash": index.digest(PLAN)},
                            {"type": "delete", "id": plan, "base_hash": index.digest(PLAN)})
    assert gone == {"op_id": gone["op_id"], "ok": True} and again["ok"] is True
    assert not (world.vault / "Garden" / "Plan.md").exists()
    with SessionLocal() as db:
        assert db.get(File, plan).deleted_at is not None  # type: ignore[union-attr]
    [read_only] = world.ops({"type": "delete", "id": world.id_of("Shared/Rules.md"),
                             "base_hash": world.hash_of("Shared/Rules.md")})
    assert read_only["code"] == "forbidden"


def test_restore_brings_a_note_back_beside_a_new_one(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    vault.delete_path("Garden/Plan.md", actor=ACTOR)
    vault.create_note("Garden", "Plan", b"# Another plan\n", actor=ACTOR)
    [back] = world.ops({"type": "restore", "id": plan})
    assert back["ok"] is True and back["path"] != "Garden/Plan.md" and back["path"].startswith("Garden/Plan")
    assert world.id_of(back["path"]) == plan
    [live] = world.ops({"type": "restore", "id": plan})
    assert live["path"] == back["path"]
    vault.delete_path("Shared/Rules.md", actor=Actor(name="bob", client="tab-bob"))
    [read_only] = world.ops({"type": "restore", "id": world.id_of("Shared/Rules.md")})
    assert read_only["code"] == "forbidden"


def test_the_same_op_id_answers_the_same_and_does_nothing_twice(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    body = {"ops": [
        {"op_id": "op-1", "type": "create", "space": "Garden", "path": "Garden/Once.md", "text": "once"},
        {"op_id": "op-2", "type": "update", "id": plan, "base_hash": index.digest(PLAN), "text": "# Plan\n\nA\n"},
    ]}
    first = world.post("/api/app/1/batch", body).json()
    (world.vault / "Garden" / "Once.md").unlink()
    index.scan()
    with SessionLocal() as db:
        versions = db.scalar(select(func.count()).select_from(Version).where(Version.file_id == plan))
    second = world.post("/api/app/1/batch", body).json()
    assert second["results"] == first["results"]
    assert not (world.vault / "Garden" / "Once.md").exists()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Version).where(Version.file_id == plan)) == versions
        # Kept seven days.
        db.execute(update(AppOp).values(created_at=utcnow() - timedelta(days=8)))
        db.commit()
    third = world.post("/api/app/1/batch", body).json()
    assert third["results"][0]["ok"] is True and (world.vault / "Garden" / "Once.md").exists()


def test_a_skipped_op_is_not_kept(world: World) -> None:
    plan = world.id_of("Garden/Plan.md")
    body = {"ops": [
        {"op_id": "bad", "type": "update", "id": plan, "base_hash": "0" * 64, "text": "x"},
        {"op_id": "later", "type": "move", "id": plan, "path": "Garden/Later.md"},
    ]}
    assert [r["code"] for r in world.post("/api/app/1/batch", body).json()["results"]] == ["stale", "skipped"]
    retry = world.post("/api/app/1/batch", {"ops": [body["ops"][1]]}).json()
    assert retry["results"][0]["ok"] is True


def test_results_come_in_order_with_the_new_cursor(world: World) -> None:
    answer = world.post("/api/app/1/batch", {"ops": [
        {"op_id": "a", "type": "create", "space": "Garden", "path": "Garden/A.md", "text": "a"},
        {"op_id": "b", "type": "restore", "id": world.id_of("Garden/Plan.md")},
        {"op_id": "c", "type": "create", "space": "Garden", "path": "Garden/C.md", "text": "c"},
    ]}).json()
    assert [result["op_id"] for result in answer["results"]] == ["a", "b", "c"]
    assert answer["cursor"] == world.last()
    too_many = world.post("/api/app/1/batch", {"ops": [{"op_id": str(n), "type": "restore", "id": 1}
                                                       for n in range(101)]})
    assert too_many.status_code == 422


def test_uploads_are_answered_like_a_create(world: World) -> None:
    def upload(path: str, data: bytes, op_id: str, space: str = "Garden") -> dict[str, Any]:
        answer = world.phone.post("/api/app/1/files", headers=bearer(world.key),
                                  data={"space": space, "path": path, "op_id": op_id},
                                  files={"file": ("x", data, "application/octet-stream")})
        assert answer.status_code == 200, answer.text
        return answer.json()

    made = upload("Garden/Inbox/scan.bin", b"scanned page", "u1")
    assert made["ok"] is True and made["path"] == "Garden/Inbox/scan.bin"
    assert made["hash"] == index.digest(b"scanned page")
    assert upload("Garden/Other/copy.bin", b"scanned page", "u2")["id"] == made["id"]
    both = upload("Garden/Inbox/scan.bin", b"another page", "u3")
    assert both["ok"] is True and both["path"] != made["path"]
    assert (world.vault / "Garden" / "Inbox" / "scan.bin").read_bytes() == b"scanned page"
    assert upload("Garden/Inbox/scan.bin", b"whatever", "u1") == made
    assert upload("Shared/x.bin", b"x", "u4", "Shared")["code"] == "forbidden"
    assert upload("Secret/x.bin", b"x", "u5", "Secret")["code"] == "not_found"
    assert upload("Garden/x.bin", b"x", "u6", "Shared")["code"] == "bad_path"
