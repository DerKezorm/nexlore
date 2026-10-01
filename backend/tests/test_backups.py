"""Backups: the whole vault and the database in one archive, checked before a restore, restored at the next start."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import get_settings
from app.db import SessionLocal
from app.models import OPERATOR, Version
from app.services import backups, index

from .conftest import make_account, sign_in


@pytest.fixture(autouse=True)
def no_old_backups() -> None:
    folder = backups.folder()
    if folder.exists():
        import shutil

        shutil.rmtree(folder)


def put(root: Path, rel: str, content: str | bytes) -> Path:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


def versions() -> int:
    with SessionLocal() as db:
        return db.scalar(select(func.count()).select_from(Version)) or 0


def test_backup_check_and_restore_bring_back_files_and_history(vault: Path) -> None:
    put(vault, "S/a.md", "a")
    put(vault, "S/b.md", "b")
    put(vault, "S/.obsidian/app.json", "{}")
    index.scan()
    archive = backups.create()
    before = versions()
    with zipfile.ZipFile(archive) as opened:
        names = set(opened.namelist())
    assert {"vault/S/a.md", "vault/S/.obsidian/app.json", "database/nexlore.db", backups.MANIFEST} <= names

    brief = backups.check(archive.name)
    assert brief.usable and (brief.would_add, brief.would_change, brief.would_remove) == (0, 0, 0)

    put(vault, "S/a.md", "changed")
    (vault / "S" / "b.md").unlink()
    put(vault, "S/new.md", "new")
    index.scan()
    brief = backups.check(archive.name)
    assert (brief.would_add, brief.would_change, brief.would_remove) == (1, 1, 1)
    assert brief.examples["remove"] == ["S/new.md"]

    backups.stage_restore(archive.name)
    assert [entry.kind for entry in backups.entries()].count("update") == 1  # the way back
    assert backups.apply_pending() is True
    assert (vault / "S" / "a.md").read_bytes() == b"a"
    assert (vault / "S" / "b.md").read_bytes() == b"b"
    assert not (vault / "S" / "new.md").exists()
    assert (vault / "S" / ".obsidian" / "app.json").is_file()
    assert not [path for path in vault.iterdir() if path.name.startswith(".nexlore-")]
    assert versions() == before
    assert not backups.pending_folder().exists()


def test_files_waiting_in_the_trash_are_backed_up_and_come_back(vault: Path) -> None:
    from app.services import paths
    from app.services import vault as vault_service

    put(vault, "S/a.md", "a")
    put(vault, "S/clip.bin", b"\x01\x02" * 5000)
    index.scan()
    vault_service.delete_path("S/clip.bin", actor=vault_service.Actor(name="t", client="tab-tests000"))
    waiting = [path.name for path in paths.trash_root().iterdir()]
    assert len(waiting) == 1
    archive = backups.create()
    with zipfile.ZipFile(archive) as opened:
        assert f"trash/{waiting[0]}" in opened.namelist()
    # Emptied after the backup: the restore brings the waiting file back with the database that knows it.
    (paths.trash_root() / waiting[0]).unlink()
    assert backups.check(archive.name).usable
    backups.stage_restore(archive.name)
    assert backups.apply_pending() is True
    assert (paths.trash_root() / waiting[0]).read_bytes() == b"\x01\x02" * 5000

    damaged = archive.with_name("nexlore-2026-01-01-000000.zip")
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(damaged, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            # Same length, other bytes: only the checksum can tell.
            target.writestr(info, data[::-1] if info.filename.startswith("trash/") else data)
    brief = backups.check(damaged.name)
    assert not brief.files_ok and brief.damaged == [f"trash/{waiting[0]}"]


def test_the_trash_in_a_backup_is_the_one_its_database_knows(vault: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import paths
    from app.services import vault as vault_service

    put(vault, "S/clip.bin", b"\x03" * 4000)
    index.scan()
    vault_service.delete_path("S/clip.bin", actor=vault_service.Actor(name="t", client="tab-tests000"))
    waiting = next(paths.trash_root().iterdir())
    walk = backups._vault_files

    def and_emptied_meanwhile(root: Path) -> list[tuple[str, Path]]:
        # The vault is walked after the database copy; the trash empties itself in the meantime.
        waiting.unlink()
        return walk(root)

    monkeypatch.setattr(backups, "_vault_files", and_emptied_meanwhile)
    archive = backups.create()
    with zipfile.ZipFile(archive) as opened:
        assert opened.read(f"trash/{waiting.name}") == b"\x03" * 4000


def test_a_damaged_archive_is_not_restored(vault: Path) -> None:
    put(vault, "S/a.md", "a")
    index.scan()
    archive = backups.create()
    # Rewrite the archive with one file's content changed but the manifest as it was.
    damaged = archive.with_name("nexlore-2026-01-01-000000.zip")
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(damaged, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            target.writestr(info, b"b" if info.filename == "vault/S/a.md" else data)
    brief = backups.check(damaged.name)
    assert not brief.files_ok and brief.damaged == ["S/a.md"]
    with pytest.raises(backups.BackupError):
        backups.stage_restore(damaged.name)
    assert not backups.pending_folder().exists()


def test_an_archive_entry_outside_the_vault_counts_as_damage(vault: Path) -> None:
    put(vault, "S/a.md", "a")
    archive = backups.create()
    evil = archive.with_name("nexlore-2026-01-02-000000.zip")
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(evil, "w") as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == backups.MANIFEST:
                manifest = json.loads(data)
                manifest["vault"]["../evil.md"] = [1, "0" * 64]
                data = json.dumps(manifest).encode()
            target.writestr(info, data)
        target.writestr("vault/../evil.md", b"x")
    assert not backups.check(evil.name).files_ok


def test_a_half_written_pending_restore_is_thrown_away(vault: Path) -> None:
    pending = backups.pending_folder()
    (pending / "vault").mkdir(parents=True)
    (pending / "nexlore.db").write_bytes(b"not a database")
    put(vault, "S/keep.md", "keep")
    assert backups.apply_pending() is False
    assert not pending.exists() and (vault / "S" / "keep.md").is_file()


def test_pruning_keeps_manual_copies(vault: Path) -> None:
    manual = backups.create()
    for _ in range(3):
        backups.create(kind=backups.SCHEDULED)
    assert backups.prune(1) == 2
    names = [entry.name for entry in backups.entries()]
    assert manual.name in names and len(names) == 2


def test_names_are_checked(vault: Path) -> None:
    for name in ("../nexlore.db", "nexlore-x.zip", "restore-pending"):
        with pytest.raises(backups.BackupError):
            backups.path_of(name)


def test_due_only_at_night_or_a_day_late(vault: Path) -> None:
    from datetime import datetime, timedelta

    night = datetime(2026, 9, 26, 3, tzinfo=datetime.now().astimezone().tzinfo)
    assert backups.due("daily", now=night) and not backups.due("daily", now=night.replace(hour=14))
    assert not backups.due("off", now=night)
    backups.create(kind=backups.SCHEDULED)
    assert not backups.due("daily", now=datetime.now().astimezone() + timedelta(hours=2))


def test_backup_routes_are_for_the_operator(client: TestClient, vault: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert client.get("/api/backups").status_code == 401
    assert client.post("/api/backups", json={}).status_code == 401
    sign_in(client, make_account("member"))
    assert client.get("/api/backups").status_code == 403
    assert client.post("/api/backups", json={}).status_code == 403
    sign_in(client, make_account("boss", OPERATOR))
    put(vault, "S/a.md", "a")
    name = client.post("/api/backups", json={"note": "by hand"}).json()["name"]
    assert client.get("/api/backups").json()[0]["note"] == "by hand"
    assert client.post(f"/api/backups/{name}/check").json()["usable"] is True
    restarted: list[bool] = []
    monkeypatch.setattr(backups, "restart_soon", lambda: restarted.append(True))
    assert client.post(f"/api/backups/{name}/restore").json()["restarting"] is True and restarted
    assert client.post("/api/backups/..%2Fx/check").status_code in (404, 422)
    assert get_settings().data_dir.is_dir()


def test_the_rest_of_an_earlier_restore_leaves_the_vault_at_the_next_start(vault: Path) -> None:
    """Review P7.4: under Windows a read-only file kept the set-aside folder, an empty tree in a shared vault."""
    import stat

    leftover = vault / ".nexlore-replaced-123" / "Garden"
    leftover.mkdir(parents=True)
    locked = leftover / "Plan.md"
    locked.write_bytes(b"x")
    locked.chmod(stat.S_IREAD)
    (vault / ".nexlore-keep").mkdir()
    assert backups.apply_pending() is False
    assert not (vault / ".nexlore-replaced-123").exists()
    # Only what a restore set aside.
    assert (vault / ".nexlore-keep").is_dir()
