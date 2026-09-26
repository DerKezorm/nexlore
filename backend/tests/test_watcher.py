"""The watcher sees changes from outside within seconds, and ignores nexlore's own hidden temporary files."""

from __future__ import annotations

import asyncio
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.models import File
from app.services import index, watcher


def live_paths() -> set[str]:
    with SessionLocal() as db:
        return set(db.scalars(select(File.path).where(File.deleted_at.is_(None))))


async def wait_for(condition, seconds: float = 15.0) -> bool:
    for _ in range(int(seconds * 10)):
        if condition():
            return True
        await asyncio.sleep(0.1)
    return False


async def test_the_watcher_indexes_new_changed_and_removed_files(vault: Path) -> None:
    (vault / "S").mkdir()
    index.scan()
    stop = asyncio.Event()
    task = asyncio.create_task(watcher.watch(stop))
    try:
        await asyncio.sleep(0.5)  # the watcher needs a moment to start
        note = vault / "S" / "new.md"
        note.write_bytes(b"from outside [[x]]")
        (vault / "S" / ".tmp-hidden.md").write_bytes(b"hidden")
        assert await wait_for(lambda: live_paths() == {"S/new.md"})
        note.unlink()
        assert await wait_for(lambda: live_paths() == set())
    finally:
        stop.set()
        await asyncio.wait_for(task, 10)


def test_relative_paths_drop_hidden_and_outside(vault: Path, tmp_path: Path) -> None:
    changes = {
        (1, str(vault / "S" / "a.md")),
        (1, str(vault / "S" / ".obsidian" / "app.json")),
        (1, str(vault / "S" / ".nexlore-123.tmp")),
        (1, str(tmp_path / "elsewhere.md")),
    }
    assert watcher.relative_paths(vault, changes) == {"S/a.md"}
