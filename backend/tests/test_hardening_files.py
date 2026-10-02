"""Security review before 1.0.0: the key, the database, backups and the log are only nexlore's own user's.

Only where the system knows file modes (Linux, the CI and the container); Windows knows read-only and nothing more.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import private
from app.config import get_settings
from app.models import Account
from app.services import backups, logs

pytestmark = pytest.mark.skipif(os.name == "nt", reason="Windows has no owner-only file modes")


def others_may_read(path: Path) -> bool:
    return bool(stat.S_IMODE(path.stat().st_mode) & 0o077)


def test_a_new_file_is_the_owners_alone_whatever_the_umask(tmp_path: Path) -> None:
    before = os.umask(0o022)
    try:
        private.new_file(tmp_path / "secret.part")
    finally:
        os.umask(before)
    assert not others_may_read(tmp_path / "secret.part")


def test_a_backup_and_its_folder_are_the_owners_alone(client: TestClient, account: Account) -> None:
    before = os.umask(0o022)
    try:
        made = backups.create()
    finally:
        os.umask(before)
    assert not others_may_read(made)
    assert not others_may_read(made.parent)


def test_at_start_the_key_the_database_and_older_backups_are_closed(client: TestClient, account: Account) -> None:
    data = get_settings().data_dir
    folder = data / "backups"
    folder.mkdir(exist_ok=True)
    old = folder / "nexlore-old.zip"
    old.write_bytes(b"made before 1.0.0")
    for path in (old, folder, data / "secret.key", data / "nexlore.db"):
        if path.exists():
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
    private.tighten_all()
    for path in (old, folder, data / "secret.key", data / "nexlore.db"):
        if path.exists():
            assert not others_may_read(path), path


def test_the_log_folder_is_the_owners_alone(client: TestClient) -> None:
    folder = logs.log_dir()
    assert not others_may_read(folder)


def test_tightening_never_touches_the_vault(client: TestClient, account: Account, vault: Path) -> None:
    note = vault / "Shared.md"
    note.write_text("for Syncthing too", encoding="utf-8")
    os.chmod(note, 0o644)
    private.tighten_all()
    assert stat.S_IMODE(note.stat().st_mode) == 0o644
