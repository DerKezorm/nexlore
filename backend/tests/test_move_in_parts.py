"""A rename rewrites its links part by part, and a server stopped half way carries on at its next start."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import File, Link, MoveJob, MoveJobNote, Version
from app.services import index, watcher
from app.services import vault as service
from app.services.vault import Actor

ME = Actor(name="tester", client="tab-1")
OTHER = Actor(name="someone", client="tab-2")
NOTES = 7


class Stop(Exception):
    """Stands for a server that stops between two parts."""


def put(root: Path, rel: str, content: str) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode())


def disk(root: Path, rel: str) -> str:
    return root.joinpath(*rel.split("/")).read_bytes().decode()


def world(root: Path) -> None:
    for number in range(NOTES):
        put(root, f"S/n{number}.md", f"see [[Old]] and [[Old#Part|there]], note {number}\n")
    index.scan()
    # The renamed note comes last, so that it is not first by its number alone.
    put(root, "S/Old.md", "no heading, the title is the name\n")
    index.scan()


def title(rel: str) -> str | None:
    with SessionLocal() as db:
        return db.scalar(select(File.title).where(File.path == rel))


def target_of_every_link() -> list[int | None]:
    with SessionLocal() as db:
        return list(db.scalars(select(Link.target_id).join(File, File.id == Link.source_id).where(
            File.path.like("S/n%"))))


def file_id(rel: str) -> int:
    with SessionLocal() as db:
        found = db.scalar(select(File.id).where(File.path == rel, File.deleted_at.is_(None)))
    assert found is not None
    return found


def jobs() -> tuple[int, int]:
    with SessionLocal() as db:
        return len(list(db.scalars(select(MoveJob.id)))), len(list(db.scalars(select(MoveJobNote.note_id))))


@pytest.fixture
def parts(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[Callable[[int], None]]]:
    """Parts of two notes; each function in the list runs after the part of its number (0 is the first)."""
    monkeypatch.setattr(service, "MOVE_PART", 2)
    monkeypatch.setattr(service, "MOVE_PART_SECONDS", 60)
    after: list[Callable[[int], None]] = []
    original = service._follow_part
    count = [0]

    def spy(job_id: int) -> tuple[bool, list[int]]:
        result = original(job_id)
        number = count[0]
        count[0] += 1
        if number < len(after):
            after[number](number)
        return result

    monkeypatch.setattr(service, "_follow_part", spy)
    yield after


def test_a_rename_rewrites_its_links_part_by_part_and_lets_go_of_the_lock_between(
    vault: Path, parts: list[Callable[[int], None]]
) -> None:
    world(vault)
    moved = file_id("S/Old.md")
    free: list[bool] = []
    pending: list[list[str]] = []
    titles: list[str | None] = []

    def between(_number: int) -> None:
        # Another request gets the lock at once: nobody holds it between two parts.
        result: list[bool] = []
        thread = threading.Thread(target=lambda: result.append(_try_guard()))
        thread.start()
        thread.join()
        free.append(result[0])
        pending.append([rel for rel in (f"S/n{n}.md" for n in range(NOTES)) if "[[Old]]" in disk(vault, rel)])
        titles.append(title("S/New.md"))
        # The index keeps every link pointing at the renamed note until the end: backlinks do not blink.
        assert target_of_every_link() == [moved] * (NOTES * 2)

    parts.extend([between] * 3)
    result = service.move("S/Old.md", "S/New.md", actor=ME)
    assert result.rewritten == NOTES
    assert free == [True, True, True]
    # The renamed note first (read again at its new place, its title follows), then two notes at a time.
    assert titles[0] == "New"
    assert pending == [[f"S/n{n}.md" for n in range(start, NOTES)] for start in (1, 3, 5)]
    for number in range(NOTES):
        assert disk(vault, f"S/n{number}.md") == f"see [[New]] and [[New#Part|there]], note {number}\n"
    assert target_of_every_link() == [moved] * (NOTES * 2)
    assert jobs() == (0, 0)


def test_at_the_end_a_link_already_written_with_the_new_name_finds_the_note(
    vault: Path, parts: list[Callable[[int], None]]
) -> None:
    world(vault)
    put(vault, "S/early.md", "waiting for [[New]]\n")
    index.scan()
    done = index.status.done
    service.move("S/Old.md", "S/New.md", actor=ME)
    with SessionLocal() as db:
        found = db.scalar(select(Link.target_id).join(File, File.id == Link.source_id).where(
            File.path == "S/early.md"))
    assert found == file_id("S/New.md")
    # Not a scan: the scan's count stays as it was.
    assert index.status.done == done


def _try_guard() -> bool:
    if index.guard.acquire(timeout=1):
        index.guard.release()
        return True
    return False


def test_a_part_ends_when_its_time_is_up(
    vault: Path, parts: list[Callable[[int], None]], monkeypatch: pytest.MonkeyPatch
) -> None:
    world(vault)
    monkeypatch.setattr(service, "MOVE_PART", 100)
    monkeypatch.setattr(service, "MOVE_PART_SECONDS", 0)
    pending: list[int] = []
    parts.extend([lambda _n: pending.append(sum("[[Old]]" in disk(vault, f"S/n{n}.md") for n in range(NOTES)))] * 3)
    assert service.move("S/Old.md", "S/New.md", actor=ME).rewritten == NOTES
    # One note a part: the renamed one, then one linking note after the other.
    assert pending == [NOTES, NOTES - 1, NOTES - 2]


def test_a_note_changed_between_two_parts_keeps_the_change_and_still_follows(
    vault: Path, parts: list[Callable[[int], None]]
) -> None:
    world(vault)

    def edit(_number: int) -> None:
        rel = "S/n5.md"
        base = index.digest(vault.joinpath("S", "n5.md").read_bytes())
        text = disk(vault, rel).replace("note 5", "note 5, edited [[Old]] once more")
        assert service.save(rel, text.encode(), base_hash=base, actor=OTHER).conflict is None

    parts.append(edit)
    service.move("S/Old.md", "S/New.md", actor=ME)
    assert disk(vault, "S/n5.md") == "see [[New]] and [[New#Part|there]], note 5, edited [[New]] once more\n"


def test_a_move_stopped_half_way_carries_on_and_names_who_moved(
    vault: Path, parts: list[Callable[[int], None]], caplog: pytest.LogCaptureFixture
) -> None:
    world(vault)
    moved = file_id("S/Old.md")

    def stop(_number: int) -> None:
        raise Stop

    parts.extend([lambda _n: None, stop])
    result = service.move("S/Old.md", "S/New.md", actor=ME)
    # The file has moved; the first part was counted, the second written but not counted before the stop, the rest
    # waits, written down in the database.
    assert (vault / "S" / "New.md").exists() and not (vault / "S" / "Old.md").exists()
    assert result.rewritten == 1
    assert jobs() == (1, NOTES - 3)
    assert "stopped half way" in caplog.text
    left = [n for n in range(NOTES) if "[[Old]]" in disk(vault, f"S/n{n}.md")]
    assert left == list(range(3, NOTES))

    parts.clear()
    assert service.resume_moves() == 1
    for number in range(NOTES):
        assert "[[New]]" in disk(vault, f"S/n{number}.md") and "Old" not in disk(vault, f"S/n{number}.md")
    assert jobs() == (0, 0)
    assert target_of_every_link() == [moved] * (NOTES * 2)
    with SessionLocal() as db:
        authors = {
            (source, author) for source, author in db.execute(
                select(Version.source, Version.author).join(File).where(File.path == f"S/n{left[-1]}.md")
            )
        }
    assert (index.RENAME, "tester") in authors
    assert service.resume_moves() == 0


def test_a_note_written_before_its_part_was_committed_is_read_again(
    vault: Path, parts: list[Callable[[int], None]], monkeypatch: pytest.MonkeyPatch
) -> None:
    world(vault)
    moved = file_id("S/Old.md")
    record = index.record
    calls = [0]

    def crash_once(*args: object, **kwargs: object) -> object:
        # The fourth note written: the server stops after the file is on disk, before its part is committed.
        if kwargs.get("source") == index.RENAME and args[1] == "S/n3.md":
            calls[0] += 1
            if calls[0] == 1:
                raise Stop
        return record(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(index, "record", crash_once)
    service.move("S/Old.md", "S/New.md", actor=ME)
    assert "[[New]]" in disk(vault, "S/n3.md")
    with SessionLocal() as db:
        stale = db.scalar(select(File.hash).where(File.path == "S/n3.md"))
    assert stale != index.digest(vault.joinpath("S", "n3.md").read_bytes())

    assert service.resume_moves() == 1
    with SessionLocal() as db:
        fresh = db.scalar(select(File.hash).where(File.path == "S/n3.md"))
        targets = list(db.scalars(select(Link.target).join(File, File.id == Link.source_id).where(
            File.path == "S/n3.md")))
    assert fresh == index.digest(vault.joinpath("S", "n3.md").read_bytes())
    assert targets == ["New", "New"]
    assert target_of_every_link() == [moved] * (NOTES * 2)


def test_a_second_rename_before_the_first_is_done_leads_the_links_to_the_last_name(
    vault: Path, parts: list[Callable[[int], None]]
) -> None:
    world(vault)
    moved = file_id("S/Old.md")

    def stop(_number: int) -> None:
        raise Stop

    parts.extend([lambda _n: None, stop])
    service.move("S/Old.md", "S/Mid.md", actor=ME)
    parts.clear()
    service.move("S/Mid.md", "S/Last.md", actor=OTHER)
    assert service.resume_moves() == 1
    for number in range(NOTES):
        assert disk(vault, f"S/n{number}.md") == f"see [[Last]] and [[Last#Part|there]], note {number}\n"
    assert target_of_every_link() == [moved] * (NOTES * 2)


def test_a_job_somebody_works_on_is_left_alone(vault: Path, parts: list[Callable[[int], None]]) -> None:
    world(vault)

    def stop(_number: int) -> None:
        raise Stop

    parts.extend([lambda _n: None, stop])
    service.move("S/Old.md", "S/New.md", actor=ME)
    parts.clear()
    with SessionLocal() as db:
        job_id = db.scalar(select(MoveJob.id))
    assert job_id is not None
    assert service._claim(job_id)
    try:
        assert service.resume_moves() == 0
        assert jobs()[0] == 1
    finally:
        service._release(job_id)
    assert service.resume_moves() == 1


def test_a_note_or_target_gone_before_its_part_is_passed_over(
    vault: Path, parts: list[Callable[[int], None]]
) -> None:
    world(vault)

    def remove(_number: int) -> None:
        service.delete_path("S/n4.md", actor=OTHER)
        (vault / "S" / "n5.md").unlink()

    parts.append(remove)
    result = service.move("S/Old.md", "S/New.md", actor=ME)
    assert result.rewritten == NOTES - 2
    assert jobs() == (0, 0)


def test_the_full_scan_carries_on_with_a_stopped_move_first(
    vault: Path, parts: list[Callable[[int], None]], monkeypatch: pytest.MonkeyPatch
) -> None:
    world(vault)

    def stop(_number: int) -> None:
        raise Stop

    parts.extend([lambda _n: None, stop])
    service.move("S/Old.md", "S/New.md", actor=ME)
    parts.clear()
    seen: list[tuple[int, int]] = []
    stop_event = asyncio.Event()

    def scan(*_args: object, **_kwargs: object) -> None:
        seen.append(jobs())
        stop_event.set()

    monkeypatch.setattr(index, "scan", scan)
    monkeypatch.setattr(index, "fill_tasks", lambda: 0)
    monkeypatch.setattr(index, "fill_via", lambda: 0)
    asyncio.run(watcher.scan_forever(stop_event))
    assert seen == [(0, 0)]
    assert all("[[New]]" in disk(vault, f"S/n{n}.md") for n in range(NOTES))
