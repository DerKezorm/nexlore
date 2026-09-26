"""The index follows the files: new, changed, moved, vanished, back again; links resolve the way Obsidian does."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from sqlalchemy import select, text

from app.db import SessionLocal
from app.models import FTS_TABLE, File, Link, Space, Tag, Version
from app.services import index


def put(vault: Path, rel: str, content: str | bytes) -> Path:
    path = vault.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


def live_paths() -> set[str]:
    with SessionLocal() as db:
        return set(db.scalars(select(File.path).where(File.deleted_at.is_(None))))


def target_of(source: str, target: str) -> str | None:
    """Where the first link written as ``target`` in ``source`` points."""
    with SessionLocal() as db:
        row = db.execute(
            select(Link.target_id).join(File, File.id == Link.source_id).where(File.path == source, Link.target == target)
        ).first()
        assert row is not None, f"no link {target!r} in {source}"
        return db.scalar(select(File.path).where(File.id == row[0])) if row[0] else None


def test_first_scan_indexes_notes_and_other_files(vault: Path) -> None:
    put(vault, "Work/Plan.md", "---\ntags: [x]\n---\n# Plan\nsee [[Idea]] #todo")
    put(vault, "Work/Ideas/Idea.md", "an idea")
    put(vault, "Work/pic.png", b"\x89PNG")
    put(vault, "Work/.obsidian/app.json", "{}")
    put(vault, "loose.md", "outside any space")
    stats = index.scan()
    assert stats.added == 3 and stats.errors == 0
    assert live_paths() == {"Work/Plan.md", "Work/Ideas/Idea.md", "Work/pic.png"}
    assert target_of("Work/Plan.md", "Idea") == "Work/Ideas/Idea.md"
    with SessionLocal() as db:
        assert [space.folder for space in db.scalars(select(Space))] == ["Work"]
        assert set(db.scalars(select(Tag.tag))) == {"x", "todo"}
        assert db.scalar(select(File.is_note).where(File.path == "Work/pic.png")) is False
        # A first version of every note, none of the picture.
        assert db.scalar(select(text("count(*)")).select_from(Version)) == 2
        hits = db.execute(text(f"SELECT rowid FROM {FTS_TABLE} WHERE {FTS_TABLE} MATCH 'idea'")).all()  # noqa: S608
        assert len(hits) == 2


def test_a_big_scan_reads_in_worker_processes_with_the_same_result(vault: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(index, "POOL_MIN", 5)
    monkeypatch.setattr(index, "BATCH", 4)  # several chunks: the next one is read while one is written
    for number in range(10):
        put(vault, f"S/n{number}.md", f"note {number} links [[n{(number + 1) % 10}]] #t{number}")
    put(vault, "S/pic.png", b"png")
    stats = index.scan()
    assert stats.added == 11 and stats.errors == 0
    assert target_of("S/n3.md", "n4") == "S/n4.md"
    with SessionLocal() as db:
        assert db.scalar(select(text("count(*)")).select_from(Version)) == 10
        assert len(set(db.scalars(select(Tag.tag)))) == 10


def test_a_decomposed_name_from_macos_stays_readable_and_linkable(vault: Path) -> None:
    from app.services import vault as service

    put(vault, "S/Café.md", "decomposed")
    put(vault, "S/link.md", "[[Café]]")  # typed composed, as most keyboards do
    index.scan()
    assert live_paths() == {"S/Café.md", "S/link.md"}
    _file, data = service.read("S/Café.md")
    assert data == b"decomposed"
    assert target_of("S/link.md", "Café") == "S/Café.md"


def test_a_second_scan_without_changes_touches_nothing(vault: Path) -> None:
    put(vault, "S/a.md", "a")
    index.scan()
    stats = index.scan()
    assert stats.touched == 0 and stats.files == 1


def test_a_touched_but_unchanged_file_makes_no_version(vault: Path) -> None:
    path = put(vault, "S/a.md", "a")
    index.scan()
    os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 5_000_000_000))
    assert index.scan().changed == 0
    with SessionLocal() as db:
        assert db.scalar(select(text("count(*)")).select_from(Version)) == 1


def test_an_outside_change_is_indexed_and_versioned(vault: Path) -> None:
    path = put(vault, "S/a.md", "old [[b]]")
    put(vault, "S/b.md", "b")
    put(vault, "S/c.md", "c")
    index.scan()
    path.write_bytes(b"new [[c]] longer")
    assert index.scan().changed == 1
    assert target_of("S/a.md", "c") == "S/c.md"
    with SessionLocal() as db:
        sources = db.scalars(select(Version.source).join(File).where(File.path == "S/a.md").order_by(Version.id))
        assert list(sources) == ["initial", "external"]


def test_links_follow_when_their_target_appears_or_goes(vault: Path) -> None:
    put(vault, "S/a.md", "[[Later]]")
    index.scan()
    assert target_of("S/a.md", "Later") is None
    later = put(vault, "S/Deep/Later.md", "here")
    index.scan()
    assert target_of("S/a.md", "Later") == "S/Deep/Later.md"
    later.unlink()
    index.scan()
    assert target_of("S/a.md", "Later") is None


def test_a_moved_file_keeps_its_row_history_and_backlinks(vault: Path) -> None:
    put(vault, "S/a.md", "[[b]]")
    old = put(vault, "S/b.md", "content of b")
    index.scan()
    with SessionLocal() as db:
        before = db.scalar(select(File.id).where(File.path == "S/b.md"))
    target = vault / "S" / "Sub" / "b.md"
    target.parent.mkdir()
    old.rename(target)
    stats = index.scan()
    assert stats.moved == 1 and stats.added == 0 and stats.removed == 0
    with SessionLocal() as db:
        assert db.scalar(select(File.id).where(File.path == "S/Sub/b.md", File.deleted_at.is_(None))) == before
    assert target_of("S/a.md", "b") == "S/Sub/b.md"


def test_same_content_in_several_files_is_no_move(vault: Path) -> None:
    # Two empty daily notes go, two others with the same (empty) content come: nobody moved, nothing inherits.
    first = put(vault, "S/2026-09-01.md", "")
    second = put(vault, "S/2026-09-02.md", "")
    put(vault, "S/keep.md", "keep")
    index.scan()
    first.unlink()
    second.unlink()
    put(vault, "S/2026-09-03.md", "")
    put(vault, "S/2026-09-04.md", "")
    stats = index.scan()
    assert (stats.moved, stats.removed, stats.added) == (0, 2, 2)
    # One goes, two of that content come: still no move.
    put(vault, "S/t1.md", "template")
    index.scan()
    (vault / "S" / "t1.md").unlink()
    put(vault, "S/t2.md", "template")
    put(vault, "S/t3.md", "template")
    stats = index.scan()
    assert (stats.moved, stats.removed, stats.added) == (0, 1, 2)


def test_a_vanished_file_goes_to_the_trash_and_comes_back_with_its_history(vault: Path) -> None:
    path = put(vault, "S/a.md", "a")
    put(vault, "S/b.md", "b")
    index.scan()
    with SessionLocal() as db:
        before = db.scalar(select(File.id).where(File.path == "S/a.md"))
    path.unlink()
    assert index.scan().removed == 1
    with SessionLocal() as db:
        gone = db.get(File, before)
        assert gone is not None and gone.deleted_at is not None and gone.deleted_how == "external"
    path.write_bytes(b"a again")
    assert index.scan().revived == 1
    with SessionLocal() as db:
        assert db.scalar(select(File.id).where(File.path == "S/a.md", File.deleted_at.is_(None))) == before
        assert db.scalar(select(text("count(*)")).select_from(Version).where(Version.file_id == before)) == 2


def test_the_brake_holds_back_a_mass_deletion(vault: Path) -> None:
    for number in range(index.MASS_DELETION_MIN + 10):
        put(vault, f"Big/n{number}.md", f"note {number}")
    put(vault, "Small/keep.md", "keep")
    index.scan()
    for number in range(index.MASS_DELETION_MIN + 10):
        (vault / "Big" / f"n{number}.md").unlink()
    stats = index.scan()
    assert stats.removed == 0 and stats.held_back == index.MASS_DELETION_MIN + 10
    assert index.status.held_back == {"Big": index.MASS_DELETION_MIN + 10}
    assert len(live_paths()) == index.MASS_DELETION_MIN + 11
    # A person says they were deleted on purpose: now they go to the trash.
    assert index.scan(confirm_deletions=True).removed == index.MASS_DELETION_MIN + 10
    assert live_paths() == {"Small/keep.md"} and index.status.held_back == {}


def test_refresh_handles_a_folder_moved_away_in_one_piece(vault: Path) -> None:
    put(vault, "S/Folder/a.md", "a")
    put(vault, "S/Folder/b.md", "b")
    put(vault, "S/keep.md", "keep")
    index.scan()
    (vault / "S" / "Folder").rename(vault / "elsewhere")  # out of every space
    stats = index.refresh(["S/Folder"])
    assert stats.removed == 2
    assert live_paths() == {"S/keep.md"}


def test_a_symlinked_folder_is_not_followed(vault: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_bytes(b"secret")
    (vault / "S").mkdir()
    try:
        os.symlink(outside, vault / "S" / "link", target_is_directory=True)
    except OSError:
        import _winapi

        _winapi.CreateJunction(str(outside), str(vault / "S" / "link"))
    index.scan()
    assert live_paths() == set()


# --- Link resolution the way Obsidian does it -----------------------------------------------------------------------


@pytest.fixture
def linked(vault: Path) -> Path:
    put(vault, "S/Home.md", "")
    put(vault, "S/A/Note.md", "in A")
    put(vault, "S/B/Note.md", "in B")
    put(vault, "S/B/Only B.md", "")
    put(vault, "S/B/pic.png", b"png")
    put(vault, "T/Note.md", "another space")
    return vault


@pytest.mark.parametrize(
    ("source", "written", "expected"),
    [
        ("S/B/Only B.md", "[[Note]]", "S/B/Note.md"),  # the one beside the note wins
        ("S/Home.md", "[[Note]]", "S/A/Note.md"),  # else the one nearest the top, then alphabetical
        ("S/Home.md", "[[B/Note]]", "S/B/Note.md"),  # a path from the space
        ("S/Home.md", "[[Note.md]]", "S/A/Note.md"),
        ("S/Home.md", "[[note]]", "S/A/Note.md"),  # without case
        ("S/Home.md", "![[pic.png]]", "S/B/pic.png"),
        ("S/Home.md", "[[pic]]", None),  # other files need their ending
        ("S/A/Note.md", "[[../B/Only B]]", "S/B/Only B.md"),
        ("S/A/Note.md", "[x](../B/Only%20B.md)", "S/B/Only B.md"),
        ("S/A/Note.md", "[x](<B/Only B.md>)", "S/B/Only B.md"),  # from the space when not relative
        ("S/A/Note.md", "[x](/B/Only%20B.md)", "S/B/Only B.md"),
        ("S/Home.md", "[[s/B/Note]]", "S/B/Note.md"),  # written from a vault that holds all spaces
        ("S/A/Note.md", "[x](S/B/Only%20B.md)", "S/B/Only B.md"),
        ("S/Home.md", "[[T/Note]]", None),  # the other space's name does not lead there
        ("S/Home.md", "[x](../T/Note.md)", None),  # never into another space
        ("S/Home.md", "[[../../outside]]", None),
    ],
)
def test_links_resolve_like_obsidian(linked: Path, source: str, written: str, expected: str | None) -> None:
    put(linked, source, written)
    index.scan()
    with SessionLocal() as db:
        target_id = db.scalar(select(Link.target_id).join(File, File.id == Link.source_id).where(File.path == source))
        found = db.scalar(select(File.path).where(File.id == target_id)) if target_id else None
    assert found == expected
