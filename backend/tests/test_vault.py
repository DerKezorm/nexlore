"""Changing the vault: nothing is ever overwritten without a copy, and links follow a rename."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select, update

from app.db import SessionLocal
from app.models import File, Link, Lock, Version
from app.services import index
from app.services import vault as service
from app.services.vault import Actor, VaultError

ME = Actor(name="tester", client="tab-1")
OTHER = Actor(name="someone", client="tab-2")


def put(root: Path, rel: str, content: str | bytes) -> Path:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


def disk(root: Path, rel: str) -> str:
    return root.joinpath(*rel.split("/")).read_bytes().decode()


def hash_of(root: Path, rel: str) -> str:
    return index.digest(root.joinpath(*rel.split("/")).read_bytes())


def version_count(rel: str) -> int:
    with SessionLocal() as db:
        return len(list(db.scalars(select(Version.id).join(File).where(File.path == rel))))


# --- Saving and conflicts -------------------------------------------------------------------------------------------


def test_save_writes_and_versions_and_bundles_a_session(vault: Path) -> None:
    root = vault
    put(root, "S/a.md", "one")
    index.scan()
    result = service.save("S/a.md", b"two", base_hash=hash_of(root, "S/a.md"), actor=ME)
    assert result.conflict is None and disk(root, "S/a.md") == "two"
    service.save("S/a.md", b"three", base_hash=hash_of(root, "S/a.md"), actor=ME)
    # initial, then one bundled version for both saves of the session
    assert version_count("S/a.md") == 2
    assert not [path for path in (root / "S").iterdir() if path.name.startswith(".")]


def test_a_save_against_a_changed_file_goes_into_a_conflict_copy(vault: Path) -> None:
    root = vault
    put(root, "S/a.md", "base")
    index.scan()
    base = hash_of(root, "S/a.md")
    put(root, "S/a.md", "changed in Obsidian")
    result = service.save("S/a.md", b"my edit", base_hash=base, actor=ME)
    assert result.conflict is not None and result.conflict.startswith("S/a (conflict ")
    assert disk(root, "S/a.md") == "changed in Obsidian"
    assert disk(root, result.conflict) == "my edit"
    with SessionLocal() as db:
        sources = list(db.scalars(select(Version.source).join(File).where(File.path == "S/a.md")))
    assert "external" in sources  # the outside change is in the history before the watcher saw it


def test_an_unchanged_save_writes_nothing(vault: Path) -> None:
    put(vault, "S/a.md", "same")
    index.scan()
    assert service.save("S/a.md", b"same", base_hash=hash_of(vault, "S/a.md"), actor=ME).changed is False


# --- Locks ----------------------------------------------------------------------------------------------------------


def test_a_lock_keeps_others_out_until_it_runs_out(vault: Path) -> None:
    put(vault, "S/a.md", "x")
    index.scan()
    service.acquire("S/a.md", ME)
    with pytest.raises(VaultError) as refused:
        service.acquire("S/a.md", OTHER)
    assert refused.value.status == 423 and refused.value.values["holder"] == "tester"
    with pytest.raises(VaultError):
        service.save("S/a.md", b"y", base_hash=hash_of(vault, "S/a.md"), actor=OTHER)
    with pytest.raises(VaultError):
        service.delete_path("S/a.md", actor=OTHER)
    with SessionLocal() as db:
        db.execute(update(Lock).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
        db.commit()
    assert service.acquire("S/a.md", OTHER).holder == "tab-2"
    service.release("S/a.md", ME)  # not the holder: nothing happens
    with SessionLocal() as db:
        assert db.scalar(select(Lock.holder)) == "tab-2"


# --- Creating -------------------------------------------------------------------------------------------------------


def test_create_makes_a_safe_unique_name_and_keeps_the_title(vault: Path) -> None:
    (vault / "S").mkdir()
    first = service.create_note("S", "Plan: Q3?", b"body", actor=ME)
    second = service.create_note("S", "plan  q3", b"", actor=ME)
    assert first.path == "S/Plan Q3.md" and first.title == "Plan: Q3?"
    assert second.path == "S/plan q3 2.md"
    assert disk(vault, "S/Plan Q3.md").startswith('---\ntitle: "Plan: Q3?"\n---\n')


def test_folders_and_spaces_refuse_unportable_and_taken_names(vault: Path) -> None:
    assert service.create_space("Work") == "Work"
    with pytest.raises(VaultError):
        service.create_space("work")
    with pytest.raises(VaultError):
        service.create_space("CON")
    assert service.create_folder("Work", "Ideas") == "Work/Ideas"
    with pytest.raises(VaultError):
        service.create_folder("Work", "a:b")


# --- Trash ----------------------------------------------------------------------------------------------------------


def test_delete_and_restore_a_folder_as_one(vault: Path) -> None:
    put(vault, "S/F/a.md", "a")
    put(vault, "S/F/Sub/b.md", "b")
    put(vault, "S/F/pic.png", b"\x89PNG")
    put(vault, "S/F/.obsidian-like/keep.json", "{}")
    put(vault, "S/link.md", "[[a]]")
    index.scan()
    assert service.delete_path("S/F", actor=ME) == 3
    assert not (vault / "S" / "F" / "a.md").exists()
    assert (vault / "S" / "F" / ".obsidian-like" / "keep.json").exists()  # not ours, stays
    entries = service.trash()
    assert len(entries) == 1 and entries[0].files == 3 and entries[0].path == "S/F"
    with SessionLocal() as db:
        assert db.scalar(select(Link.target_id)) is None
    restored = service.restore_trash(entries[0].id, actor=ME)
    assert sorted(restored) == ["S/F/Sub/b.md", "S/F/a.md", "S/F/pic.png"]
    assert (vault / "S" / "F" / "pic.png").read_bytes() == b"\x89PNG"
    with SessionLocal() as db:
        assert db.scalar(select(Link.target_id)) is not None
    assert service.trash() == []


def test_restore_into_a_taken_place_gets_a_new_name(vault: Path) -> None:
    put(vault, "S/a.md", "old")
    index.scan()
    service.delete_path("S/a.md", actor=ME)
    put(vault, "S/a.md", "new one")
    index.scan()
    [entry] = service.trash()
    assert service.restore_trash(entry.id, actor=ME) == ["S/a 2.md"]
    assert disk(vault, "S/a 2.md") == "old" and disk(vault, "S/a.md") == "new one"


def test_the_trash_empties_itself_after_thirty_days(vault: Path) -> None:
    put(vault, "S/a.md", "a")
    index.scan()
    service.delete_path("S/a.md", actor=ME)
    assert service.purge_expired(datetime.now(UTC) + timedelta(days=29)) == 0
    assert service.purge_expired(datetime.now(UTC) + timedelta(days=31)) == 1
    with SessionLocal() as db:
        assert db.scalar(select(Version.id)) is None


# --- Versions -------------------------------------------------------------------------------------------------------


def test_restoring_a_version_keeps_the_state_before(vault: Path) -> None:
    put(vault, "S/a.md", "first")
    index.scan()
    service.save("S/a.md", b"second", base_hash=hash_of(vault, "S/a.md"), actor=ME)
    first = service.versions("S/a.md")[-1]
    service.restore_version(first.id, actor=ME)
    assert disk(vault, "S/a.md") == "first"
    contents = [service.version_content(version.id)[1] for version in service.versions("S/a.md")]
    assert contents[:2] == [b"first", b"second"]


def test_thinning_keeps_the_newest_per_hour_day_and_week() -> None:
    now = datetime(2026, 9, 26, 12, tzinfo=UTC)
    rows = [
        (1, now - timedelta(minutes=5)),
        (2, now - timedelta(hours=3)),  # within a day: all stay
        (3, now - timedelta(hours=3, minutes=20)),
        (4, now - timedelta(days=2, minutes=10)),  # 2 days: one per hour
        (5, now - timedelta(days=2, minutes=20)),
        (6, now - timedelta(days=10, hours=1)),  # 10 days: one per day
        (7, now - timedelta(days=10, hours=2)),
        (8, now - timedelta(days=100)),
    ]
    dropped = set(service.thin(rows, now))
    assert dropped == {5, 7}
    assert service.thin([(1, now - timedelta(days=400))], now) == []


# --- Moving with links following ------------------------------------------------------------------------------------


def test_rename_rewrites_links_in_their_own_style(vault: Path) -> None:
    put(vault, "S/Target.md", "target")
    put(vault, "S/A/wiki.md", "see [[Target]] and [[Target#Part|shown]] and ![[Target]]")
    put(vault, "S/A/md.md", "see [x](../Target.md) and [y](<../Target.md>) and [z](/Target.md#h)")
    put(vault, "S/A/untouched.md", "`[[Target]]` in code stays")
    index.scan()
    result = service.move("S/Target.md", "S/New Name.md", actor=ME)
    assert result.rewritten == 2
    assert disk(vault, "S/A/wiki.md") == "see [[New Name]] and [[New Name#Part|shown]] and ![[New Name]]"
    assert disk(vault, "S/A/md.md") == (
        "see [x](../New%20Name.md) and [y](<../New Name.md>) and [z](/New%20Name.md#h)"
    )
    assert disk(vault, "S/A/untouched.md") == "`[[Target]]` in code stays"
    with SessionLocal() as db:
        target = db.scalar(select(File.id).where(File.path == "S/New Name.md"))
        assert set(db.scalars(select(Link.target_id))) == {target}


def test_moving_a_note_updates_its_own_relative_links_not_its_wiki_links(vault: Path) -> None:
    put(vault, "S/Other.md", "other")
    put(vault, "S/Mover.md", "[[Other]] and [rel](Other.md)")
    (vault / "S" / "Deep").mkdir()
    index.scan()
    service.move("S/Mover.md", "S/Deep/Mover.md", actor=ME)
    assert disk(vault, "S/Deep/Mover.md") == "[[Other]] and [rel](../Other.md)"


def test_a_name_that_becomes_ambiguous_gets_the_full_path(vault: Path) -> None:
    put(vault, "S/A/Note.md", "a")
    put(vault, "S/B/Old.md", "b")
    put(vault, "S/Home.md", "[[Old]]")
    index.scan()
    service.move("S/B/Old.md", "S/B/Note.md", actor=ME)
    assert disk(vault, "S/Home.md") == "[[B/Note]]"


def test_moving_a_folder_carries_links_and_history(vault: Path) -> None:
    put(vault, "S/F/a.md", "[[b]] [x](b.md)")
    put(vault, "S/F/b.md", "b")
    put(vault, "S/out.md", "[x](F/a.md) [[F/b]]")
    index.scan()
    with SessionLocal() as db:
        before = db.scalar(select(File.id).where(File.path == "S/F/a.md"))
    moved = service.move("S/F", "S/G/F2", actor=ME)
    assert moved.files == 2
    assert disk(vault, "S/out.md") == "[x](G/F2/a.md) [[G/F2/b]]"
    assert disk(vault, "S/G/F2/a.md") == "[[b]] [x](b.md)"  # relative inside the folder: unchanged
    with SessionLocal() as db:
        assert db.scalar(select(File.id).where(File.path == "S/G/F2/a.md")) == before


def test_a_case_only_rename_works_on_a_case_insensitive_disk(vault: Path) -> None:
    put(vault, "S/note.md", "x")
    put(vault, "S/link.md", "[[note]]")
    index.scan()
    service.move("S/note.md", "S/Note.md", actor=ME)
    assert [path.name for path in (vault / "S").iterdir() if path.name.lower() == "note.md"] == ["Note.md"]


@pytest.mark.parametrize(
    ("source", "destination", "code"),
    [
        ("S/a.md", "T/a.md", "move_across_spaces"),
        ("S/a.md", "S/b.md", "exists"),
        ("S/a.md", "S/a:b.md", "name_invalid"),
        ("S/a.md", "S/a.txt", "path_invalid"),
        ("S/F", "S/F/inner", "path_invalid"),
    ],
)
def test_moves_that_are_refused(vault: Path, source: str, destination: str, code: str) -> None:
    put(vault, "S/a.md", "a")
    put(vault, "S/b.md", "b")
    put(vault, "S/F/c.md", "c")
    put(vault, "T/x.md", "x")
    index.scan()
    with pytest.raises(VaultError) as refused:
        service.move(source, destination, actor=ME)
    assert refused.value.code == code
