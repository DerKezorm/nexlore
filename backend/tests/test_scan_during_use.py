"""While the vault is being read, nexlore stays usable: one scan at a time, short transactions, a notice instead of
errors. Measured before the change with 20,000 notes: one transaction held SQLite's write lock for 6.6 s, a sign-in
failed with "database is locked" and a save waited 12.7 s (the full measurement is ``tools/sperrmessung.py``)."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from app.db import SessionLocal, engine
from app.main import app
from app.models import File, Link
from app.services import accounts, index
from tests.conftest import PASSWORD, make_account, sign_in


def put(vault: Path, rel: str, content: str) -> None:
    path = vault.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode())


def many_notes(vault: Path, count: int, space: str = "Work") -> None:
    for number in range(count):
        put(vault, f"{space}/Folder {number % 20}/Note {number}.md",
            f"# Note {number}\n\nsee [[Note {(number * 7) % count}]] and [[Note {(number + 1) % count}]]\n")


def unresolved_but_there() -> int:
    """Links that point nowhere although a note of their name exists."""
    with SessionLocal() as db:
        names = set(db.scalars(select(File.name_key).where(File.deleted_at.is_(None))))
        return sum(
            1 for key in db.scalars(select(Link.target_key).where(Link.target_id.is_(None))) if key in names
        )


def test_only_one_scan_runs_and_the_watcher_waits_for_it(vault: Path, client: TestClient, operator: object) -> None:
    put(vault, "Work/a.md", "a")
    index.scan()
    put(vault, "Work/b.md", "b")
    done = threading.Event()

    def watcher() -> None:
        index.refresh(["Work/b.md"])
        done.set()

    with index.scan_lock:
        with pytest.raises(index.ScanRunning):
            index.scan(wait=False)
        answer = client.post("/api/index/scan")
        assert answer.status_code == 409 and answer.json()["detail"]["code"] == "scan_running"
        thread = threading.Thread(target=watcher)
        thread.start()
        # The watcher's pass waits: two passes over the same files at once doubled the work and the lock time.
        assert not done.wait(0.5)
    thread.join(timeout=30)
    assert done.is_set()
    with SessionLocal() as db:
        assert db.scalar(select(File.id).where(File.path == "Work/b.md")) is not None
    assert client.post("/api/index/scan").status_code == 200


def test_the_progress_shows_counts_to_the_operator_and_a_share_to_everybody_else(
    vault: Path, client: TestClient, operator: object
) -> None:
    put(vault, "Work/a.md", "a")
    index.scan()
    assert client.get("/api/index/progress").json() == {"running": False}
    member = make_account("member")
    saved = (index.status.running, index.status.phase, index.status.done, index.status.total, index.status.first)
    try:
        index.status.running, index.status.phase, index.status.done, index.status.total = True, "indexing", 250, 1000
        assert client.get("/api/index/progress").json() == {
            "running": True, "phase": "indexing", "percent": 25, "done": 250, "total": 1000,
        }
        with TestClient(app, headers={"X-Nexlore-Client": "tab-member00"}) as other:
            sign_in(other, member)
            answer = other.get("/api/index/progress").json()
        # The counts span every space, the member's and the ones it may not see.
        assert answer == {"running": True, "phase": "indexing", "percent": 25}
        # A small pass of the watcher is nothing to tell about; the first reading of a vault is, from the start.
        index.status.total = index.PROGRESS_MIN - 1
        assert client.get("/api/index/progress").json() == {"running": False}
        index.status.first, index.status.total, index.status.phase = True, 0, "walking"
        assert client.get("/api/index/progress").json()["percent"] is None
    finally:
        (index.status.running, index.status.phase, index.status.done, index.status.total,
         index.status.first) = saved


def test_a_big_scan_writes_in_short_parts_and_still_resolves_every_link(
    vault: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(index, "BATCH", 50)
    monkeypatch.setattr(index, "RELINK_PART", 100)
    many_notes(vault, 600)
    commits: dict[str, int] = {}

    def count(_conn: object) -> None:
        commits[index.status.phase] = commits.get(index.status.phase, 0) + 1

    event.listen(engine, "commit", count)
    try:
        stats = index.scan()
    finally:
        event.remove(engine, "commit", count)
    assert stats.added == 600
    # 600 new files at 50 a time; their names and their notes' links at 100 a part (6 + 6).
    assert commits.get("indexing", 0) >= 12
    assert commits.get("linking", 0) >= 12
    assert unresolved_but_there() == 0
    # Renamed from outside: the removal goes in parts too, and the links follow.
    for number in range(0, 600, 2):
        old = vault / "Work" / f"Folder {number % 20}" / f"Note {number}.md"
        old.rename(old.with_name(f"Renamed {number}.md"))
    commits.clear()
    event.listen(engine, "commit", count)
    try:
        stats = index.scan()
    finally:
        event.remove(engine, "commit", count)
    assert stats.moved == 300
    assert commits.get("removing", 0) >= 6


class RowsPerTransaction:
    """How many rows each write transaction of the scan's thread changed: a scan whose transactions grow with the
    vault holds the write lock longer the bigger the vault (the old one: every link of it in one)."""

    def __init__(self, thread: threading.Thread) -> None:
        self.thread = thread
        self.current: dict[int, int] = {}
        self.biggest = 0

    def before(self, conn, _cursor, statement, params, _context, many) -> None:  # noqa: ANN001
        if threading.current_thread() is not self.thread:
            return
        if statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")):
            self.current[id(conn)] = self.current.get(id(conn), 0) + (len(params) if many else 1)

    def commit(self, conn) -> None:  # noqa: ANN001
        self.biggest = max(self.biggest, self.current.pop(id(conn), 0))


def test_signing_in_and_saving_answer_quickly_while_a_big_scan_runs(
    vault: Path, client: TestClient, operator: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Small parts, so that 3,000 notes are "big": each transaction may change a few hundred rows, never thousands.
    # (raising=False: the same test ran against the code before the change, which had no such parts.)
    monkeypatch.setattr(index, "BATCH", 50)
    monkeypatch.setattr(index, "RELINK_PART", 100, raising=False)
    put(vault, "Work/Diary.md", "day one\n")
    index.scan()
    many_notes(vault, 3000, space="Archive")
    note = client.get("/api/note", params={"path": "Work/Diary.md"}).json()
    scanning = threading.Thread(target=index.scan)
    rows = RowsPerTransaction(scanning)
    event.listen(engine, "before_cursor_execute", rows.before)
    event.listen(engine, "commit", rows.commit)
    scanning.start()
    timings: list[tuple[str, int, float]] = []
    seen_running = 0
    try:
        number = 0
        while scanning.is_alive() and number < 40:
            number += 1
            if index.status.running:
                seen_running += 1
            began = time.perf_counter()
            with TestClient(app, headers={"X-Nexlore-Client": "tab-signin00"}) as fresh:
                answer = fresh.post("/api/auth/login", json={"name": "tester", "password": PASSWORD})
            timings.append(("login", answer.status_code, time.perf_counter() - began))
            began = time.perf_counter()
            answer = client.put("/api/note", json={
                "path": "Work/Diary.md", "content": f"day {number}\n", "base_hash": note["hash"]})
            timings.append(("save", answer.status_code, time.perf_counter() - began))
            if answer.status_code == 200:
                note["hash"] = answer.json()["hash"]
            time.sleep(0.05)
    finally:
        scanning.join(timeout=300)
        event.remove(engine, "before_cursor_execute", rows.before)
        event.remove(engine, "commit", rows.commit)
    # 50 new notes a transaction: their files, links, search text, versions; or the links of 100 names or notes.
    assert 0 < rows.biggest <= 1000, rows.biggest
    assert seen_running >= 3, "the scan was over before anything was measured"
    assert all(status == 200 for _, status, _ in timings), timings
    slowest = max(seconds for _, _, seconds in timings)
    assert slowest < 3.0, sorted(timings, key=lambda row: -row[2])[:5]
    assert unresolved_but_there() == 0


def test_a_database_still_busy_answers_503_busy_not_a_server_error(
    vault: Path, operator: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    def locked(*_args: object, **_kwargs: object) -> None:
        raise OperationalError("UPDATE accounts", {}, sqlite3.OperationalError("database is locked"))

    monkeypatch.setattr(accounts, "authenticate", locked)
    with TestClient(app, raise_server_exceptions=False, headers={"X-Nexlore-Client": "tab-busy0000"}) as fresh:
        answer = fresh.post("/api/auth/login", json={"name": "tester", "password": PASSWORD})
    assert answer.status_code == 503
    assert answer.json()["detail"]["code"] == "busy"
    assert answer.headers["retry-after"] == "2"
