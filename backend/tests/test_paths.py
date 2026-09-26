"""Paths inside the vault: nothing leaves it, and every name nexlore makes works on Windows, macOS and Linux."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from app.services import paths
from app.services.paths import PathError


@pytest.mark.parametrize(
    "raw",
    [
        "", "/etc/passwd", "C:/Windows", "c:note.md", "a/../b.md", "../outside.md", "a/./b.md", "a//b.md",
        "a\\b.md", "a/.obsidian/app.json", ".hidden/x.md", "a/b\x00.md", "a/b\n.md", "a/" + "x" * 256 + ".md",
        "a/" + "ä" * 128 + ".md",
    ],
)
def test_parse_refuses_what_could_leave_the_vault_or_hide(raw: str) -> None:
    with pytest.raises(PathError):
        paths.parse(raw)


def test_parse_keeps_what_others_may_create_and_normalises_to_nfc() -> None:
    # A colon cannot be created by nexlore, but a Linux client may have made it and it must stay readable.
    assert paths.parse("Space/Folder/a: b.md") == "Space/Folder/a: b.md"
    assert paths.parse("Space/Cafe\u0301.md") == "Space/Caf\u00e9.md"


@pytest.mark.parametrize(
    "name",
    ["CON", "con.md", "Lpt1.txt", "a:b", "a|b", "a?b", "a*b", 'a"b', "a<b", "a>b", "a/b", "a\\b", "a[b]", "a#b",
     "a^b", "trailing.", "trailing ", " leading", ".hidden", "..", "", "tab\tname"],
)
def test_check_name_refuses_what_one_system_cannot_hold(name: str) -> None:
    with pytest.raises(PathError):
        paths.check_name(name)


def test_check_name_takes_ordinary_names() -> None:
    for name in ("Notiz.md", "Übersicht 2026.md", "a.b.c", "COM10.md", "console.md", "日本語.md"):
        assert paths.check_name(name) == name


def test_safe_name_turns_any_title_into_a_portable_name() -> None:
    assert paths.safe_name("Meeting: Q3 / Plan?") == "Meeting Q3 Plan.md"
    assert paths.safe_name("CON") == "CON_.md"
    assert paths.safe_name("   ") == "Untitled.md"
    assert paths.safe_name("[[Link]] #tag ^x") == "Link tag x.md"
    long = paths.safe_name("ä" * 300)
    assert len(long.encode()) <= paths.MAX_PART_BYTES and long.endswith(".md")
    for title in ("a:b", "CON", "...", "x" * 400, "a\x01b"):
        paths.check_name(paths.safe_name(title))


def test_unique_name_ignores_case_like_windows(tmp_path: Path) -> None:
    (tmp_path / "Note.md").write_bytes(b"")
    assert paths.unique_name(tmp_path, "note.md") == "note 2.md"
    assert paths.unique_name(tmp_path, "Other.md") == "Other.md"
    assert paths.unique_name(tmp_path, "note.md", taken={"NOTE 2.md"}) == "note 3.md"


def test_resolve_refuses_a_link_out_of_the_vault(tmp_path: Path) -> None:
    root = tmp_path / "vault"
    (root / "Space").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        os.symlink(outside, root / "Space" / "escape", target_is_directory=True)
    except OSError:
        if sys.platform != "win32":
            raise
        # A symlink needs developer mode on Windows; a junction does not, and leads out just the same.
        import _winapi

        _winapi.CreateJunction(str(outside), str(root / "Space" / "escape"))
    with pytest.raises(PathError):
        paths.resolve("Space/escape/x.md", root=root)
    assert paths.resolve("Space/fine.md", root=root) == root / "Space" / "fine.md"


def test_stem_and_space() -> None:
    assert paths.stem("S/F/Note.md") == "Note"
    assert paths.stem("S/F/pic.png") == "pic.png"
    assert paths.space_of("S/F/Note.md") == "S"
