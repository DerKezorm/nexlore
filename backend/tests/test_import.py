"""Importing an Obsidian vault: the archive is checked before anything is written, and the report says what is in it."""

from __future__ import annotations

import io
import os
import stat
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services import importer, index

VAULT_FILES = {
    "My Vault/Home.md": "---\ntags: [start]\n---\n# Home\n[[Projects/Plan]] [[Nowhere]] ![[pic.png]]\n",
    "My Vault/Projects/Plan.md": "```dataview\nLIST\n```\n> [!tip] Hint\n> ok\n<% tp.date.now() %>",
    "My Vault/Projects/Board.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\n",
    "My Vault/Broken.md": "---\ntags: [unclosed\n---\n",
    "My Vault/pic.png": b"\x89PNG",
    "My Vault/.obsidian/community-plugins.json": '["dataview", "templater-obsidian"]',
    "My Vault/.obsidian/workspace.json": "{}",
}


def make_zip(files: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def upload(client: TestClient, data: bytes, name: str = "Imported"):
    return client.post("/api/import", data={"name": name}, files={"file": ("vault.zip", data, "application/zip")})


def test_an_obsidian_vault_comes_in_with_a_report(client: TestClient, account: str, vault: Path) -> None:
    response = upload(client, make_zip(VAULT_FILES))
    assert response.status_code == 201, response.text
    report = response.json()
    assert (vault / "Imported" / "Home.md").is_file()  # the folder around everything is taken off
    assert (vault / "Imported" / ".obsidian" / "workspace.json").read_text() == "{}"  # untouched, kept
    assert report["notes"] == 4 and report["other_files"] == 1
    assert report["obsidian_config"] and report["community_plugins"] == ["dataview", "templater-obsidian"]
    assert report["unresolved_links"]["examples"] == ["Imported/Home.md: Nowhere"]
    plugins = {label: finding["examples"] for label, finding in report["plugins"].items()}
    assert plugins["Dataview blocks"] == ["Imported/Projects/Plan.md"]
    assert plugins["Templater commands"] == ["Imported/Projects/Plan.md"]
    assert plugins["Excalidraw drawings"] == ["Imported/Projects/Board.excalidraw.md"]
    assert report["front_matter_errors"]["examples"] == ["Imported/Broken.md"]
    assert report["obsidian"]["callouts"] == 1 and report["obsidian"]["embeds"] == 1
    assert client.get("/api/spaces/Imported/report").json()["notes"] == 4


def test_a_taken_or_unportable_space_name_is_refused(client: TestClient, account: str, vault: Path) -> None:
    (vault / "Taken").mkdir()
    assert upload(client, make_zip({"a.md": "a"}), "taken").json()["detail"]["code"] == "exists"
    assert upload(client, make_zip({"a.md": "a"}), "a:b").json()["detail"]["code"] == "name_invalid"
    assert upload(client, b"not a zip").json()["detail"]["code"] == "archive_invalid"


@pytest.mark.parametrize(
    "name", ["../evil.md", "/abs.md", "C:/win.md", "a/../../evil.md", "..\\evil.md", "ok/\x01.md"]
)
def test_entries_that_would_leave_the_space_refuse_the_whole_archive(
    client: TestClient, account: str, vault: Path, name: str
) -> None:
    response = upload(client, make_zip({"fine.md": "x", name: "evil"}))
    assert response.json()["detail"]["code"] == "archive_unsafe"
    assert not (vault / "Imported").exists()
    assert not any(vault.iterdir())  # no half-unpacked staging folder either


def test_a_symlink_entry_is_refused(client: TestClient, account: str, vault: Path) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        info = zipfile.ZipInfo("link.md")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "/etc/passwd")
    assert upload(client, buffer.getvalue()).json()["detail"]["code"] == "archive_unsafe"


def test_a_zip_bomb_stops_at_the_check(client: TestClient, account: str, vault: Path) -> None:
    bomb = make_zip({"zeros.md": b"\0" * (8 * 1024 * 1024)})
    assert upload(client, bomb).json()["detail"]["code"] == "archive_unsafe"


def test_names_this_system_cannot_hold_are_renamed_and_reported(tmp_path: Path, vault: Path) -> None:
    archive = tmp_path / "v.zip"
    archive.write_bytes(make_zip({"Plan: Q3.md": "x", "Note.md": "a", "note.md": "b", "sub/con.md": "c"}))
    report = importer.import_archive(archive, "Space")
    names = sorted(path.name for path in (vault / "Space").rglob("*") if path.is_file())
    assert names == ["Note.md", "Plan Q3.md", "con_.md", "note 2.md"]
    assert report.renamed_on_import.count == 3


def test_the_report_finds_case_twins_and_unportable_names_on_disk(vault: Path) -> None:
    space = vault / "Linux"
    space.mkdir()
    (space / "a.md").write_bytes(b"a")
    (space / "trailing dot.").write_bytes(b"x")
    (space / "sub").mkdir()
    (space / ".hidden.md").write_bytes(b"h")
    (space / "A.md").write_bytes(b"A")
    index.scan()
    report = importer.report("Linux")
    assert report.hidden_skipped == 1
    # What the disk could hold decides: Windows keeps one of a.md/A.md and drops the trailing dot itself.
    names = os.listdir(space)
    twins = sum(1 for name in names if name.lower() == "a.md")
    assert report.case_collisions.count == twins - 1
    assert report.unportable_names.count == sum(1 for name in names if name.endswith("."))
    if sys.platform != "win32":
        assert report.case_collisions.count == 1 and report.unportable_names.count == 1


def test_report_of_a_missing_space(client: TestClient, account: str) -> None:
    assert client.get("/api/spaces/Nope/report").status_code == 404
    assert client.get("/api/spaces/..%2Fx/report").status_code in (400, 404)


def test_a_member_imports_a_space_of_its_own(client: TestClient, account: str, vault: Path) -> None:
    from .conftest import make_account, sign_in

    sign_in(client, make_account("member"))
    assert upload(client, make_zip({"a.md": "# A\n"}), "Theirs").status_code == 201
    assert [(space["name"], space["role"]) for space in client.get("/api/spaces").json()] == [("Theirs", "manage")]
    sign_in(client, make_account("boss", "operator"))
    # It has a member now: the operator does not read it.
    assert client.get("/api/note", params={"path": "Theirs/a.md"}).status_code == 404
