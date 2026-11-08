"""The attachment folders as their operator and managers shape them: hidden in the sidebar and the cover flow, named
after a pattern when pasted, and renamed with the links following."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.models import Account
from app.services import attachments, index

from .test_attachments import TAB, photo, put, upload

#: 8 November 2026, 14:05:09: what the patterns are filled with.
MOMENT = time.struct_time((2026, 11, 8, 14, 5, 9, 6, 312, 0))


@pytest.fixture
def filled(vault: Path, account: Account) -> Path:
    put(vault, "Home/Shopping.md", "# Shopping\n\nMilk.\n")
    put(vault, "Home/Recipes/Cake.md", "# Cake\n\nFlour.\n")
    put(vault, "Work/Plan.md", "# Plan\n")
    index.scan()
    return vault


@pytest.fixture
def fixed_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(attachments.time, "localtime", lambda *_args: MOMENT)


def file_settings(client: TestClient, **changes: object):
    current = client.get("/api/settings/files", headers=TAB).json()
    return client.put("/api/settings/files", json={**current, **changes}, headers=TAB)


def link_in(client: TestClient, note: str, links: list[str]) -> None:
    hashed = client.get("/api/note", params={"path": note}, headers=TAB).json()["hash"]
    text = "# Note\n\n" + "\n\n".join(f"![]({link})" for link in links) + "\n"
    saved = client.put("/api/note", json={"path": note, "content": text, "base_hash": hashed}, headers=TAB)
    assert saved.status_code == 200, saved.text


# --- Pasted pictures named after a pattern -------------------------------------------------------------------------


def test_a_pasted_picture_is_named_after_the_operators_pattern(client: TestClient, filled: Path, fixed_time: None) -> None:
    assert file_settings(client, pasted_name="{date} {note} {n:3}").status_code == 200
    first = upload(client, photo(), pasted=True).json()
    second = upload(client, photo((0, 0, 255)), pasted=True).json()
    assert first["path"] == "Home/Attachments/2026-11-08 Shopping 001.jpg"
    assert second["path"] == "Home/Attachments/2026-11-08 Shopping 002.jpg"
    # A file with a name of its own keeps it, whatever the pattern.
    assert upload(client, b"x", name="Receipt.txt").json()["path"] == "Home/Attachments/Receipt.txt"


def test_a_pattern_without_a_number_gets_one_when_the_name_is_taken(
    client: TestClient, filled: Path, fixed_time: None
) -> None:
    file_settings(client, pasted_name="{note}-{date}_{time}")
    first = upload(client, photo(), pasted=True).json()
    second = upload(client, photo((0, 0, 255)), pasted=True).json()
    assert first["path"] == "Home/Attachments/Shopping-2026-11-08_14-05-09.jpg"
    assert second["path"] == "Home/Attachments/Shopping-2026-11-08_14-05-09 2.jpg"


def test_the_default_pattern_names_as_before(client: TestClient, filled: Path) -> None:
    assert client.get("/api/settings/files", headers=TAB).json()["pasted_name"] == "{note} {n}"
    assert upload(client, photo(), pasted=True).json()["path"] == "Home/Attachments/Shopping 1.jpg"


@pytest.mark.parametrize("pattern", ["{title} {n}", "{date:3}", "   ", "{n", "x" * 121])
def test_a_pattern_with_an_unknown_placeholder_is_refused(client: TestClient, filled: Path, pattern: str) -> None:
    answer = file_settings(client, pasted_name=pattern)
    assert answer.status_code == 422, answer.text
    assert client.get("/api/settings/files", headers=TAB).json()["pasted_name"] == "{note} {n}"


# --- Hidden in the sidebar and the cover flow ----------------------------------------------------------------------


def folder_names(client: TestClient, path: str) -> list[str]:
    return [folder["name"] for folder in client.get("/api/folder", params={"path": path}, headers=TAB).json()["folders"]]


def cover_names(client: TestClient, path: str) -> list[str]:
    items = client.get("/api/coverflow", params={"path": path}, headers=TAB).json()["items"]
    return [item["name"] for item in items if item["kind"] == "folder"]


def test_a_space_may_hide_its_attachment_folders(client: TestClient, filled: Path) -> None:
    upload(client, photo(), pasted=True)
    upload(client, photo((0, 0, 255)), pasted=True, note="Home/Recipes/Cake.md")
    put(filled, "Work/Attachments/plan.txt", "x")
    index.scan()
    assert folder_names(client, "Home") == ["Attachments", "Recipes"]
    assert folder_names(client, "Home/Recipes") == ["Attachments"]

    changed = client.put("/api/spaces/Home/options", json={"hide_attachments": True}, headers=TAB)
    assert changed.status_code == 200 and changed.json()["hide_attachments"] is True
    home = next(space for space in client.get("/api/spaces", headers=TAB).json() if space["name"] == "Home")
    assert home["hide_attachments"] is True and home["attachment_folder"] == "Attachments"
    # Gone from every level of the space, in the sidebar and in the cover flow; the files stay where they are.
    assert folder_names(client, "Home") == ["Recipes"]
    assert folder_names(client, "Home/Recipes") == []
    assert cover_names(client, "Home") == ["Recipes"]
    assert (filled / "Home" / "Attachments" / "Shopping 1.jpg").is_file()
    assert client.get("/api/folder", params={"path": "Home/Attachments"}, headers=TAB).status_code == 200
    # Another space shows its own.
    assert folder_names(client, "Work") == ["Attachments"]
    assert cover_names(client, "Work") == ["Attachments"]

    client.put("/api/spaces/Home/options", json={"hide_attachments": False}, headers=TAB)
    assert folder_names(client, "Home") == ["Attachments", "Recipes"]


def test_hiding_follows_the_folder_name_the_operator_chose(client: TestClient, filled: Path) -> None:
    put(filled, "Home/Attachments/old.txt", "x")
    put(filled, "Home/files/new.txt", "x")
    index.scan()
    client.put("/api/spaces/Home/options", json={"hide_attachments": True}, headers=TAB)
    file_settings(client, attachment_folder="Files")
    # Case aside, as the file systems compare.
    assert folder_names(client, "Home") == ["Attachments", "Recipes"]


# --- A new name, the folders there renamed ------------------------------------------------------------------------


def test_a_new_folder_name_renames_the_folders_there_and_the_links_follow(client: TestClient, filled: Path) -> None:
    shopping = upload(client, photo(), pasted=True).json()
    cake = upload(client, photo((0, 0, 255)), pasted=True, note="Home/Recipes/Cake.md").json()
    link_in(client, "Home/Shopping.md", [shopping["link"]])
    link_in(client, "Home/Recipes/Cake.md", [cake["link"], "../Attachments/Shopping%201.jpg"])

    answer = file_settings(client, attachment_folder="Anhänge", rename_existing=True)
    assert answer.status_code == 200, answer.text
    assert answer.json()["renamed"] == 2 and answer.json()["left"] == []
    assert not (filled / "Home" / "Attachments").exists()
    assert (filled / "Home" / "Anhänge" / "Shopping 1.jpg").is_file()
    assert (filled / "Home" / "Recipes" / "Anhänge" / "Cake 1.jpg").is_file()
    # The umlaut stays a letter in the links, as an upload writes it.
    assert (filled / "Home" / "Shopping.md").read_text(encoding="utf-8") == "# Note\n\n![](Anhänge/Shopping%201.jpg)\n"
    assert (filled / "Home" / "Recipes" / "Cake.md").read_text(encoding="utf-8") == (
        "# Note\n\n![](Anhänge/Cake%201.jpg)\n\n![](../Anhänge/Shopping%201.jpg)\n"
    )
    links = client.get("/api/links", params={"path": "Home/Recipes/Cake.md"}, headers=TAB).json()
    assert [item["path"] for item in links["outgoing"]] == [
        "Home/Recipes/Anhänge/Cake 1.jpg", "Home/Anhänge/Shopping 1.jpg",
    ]
    # New uploads go to the new name.
    assert upload(client, b"x", name="x.txt").json()["path"] == "Home/Anhänge/x.txt"


def test_a_link_that_spelled_letters_as_percent_bytes_keeps_doing_so(client: TestClient, filled: Path) -> None:
    file_settings(client, attachment_folder="Anhänge")
    shopping = upload(client, photo(), pasted=True).json()
    assert shopping["link"] == "Anhänge/Shopping%201.jpg"
    link_in(client, "Home/Shopping.md", [shopping["link"], "Anh%C3%A4nge/Shopping%201.jpg"])
    answer = file_settings(client, attachment_folder="Bilder & Dateien", rename_existing=True).json()
    assert answer["renamed"] == 1
    assert (filled / "Home" / "Shopping.md").read_text(encoding="utf-8") == (
        "# Note\n\n![](Bilder%20&%20Dateien/Shopping%201.jpg)\n\n![](Bilder%20%26%20Dateien/Shopping%201.jpg)\n"
    )


def test_a_folder_with_the_new_name_beside_it_stays_as_it_is(client: TestClient, filled: Path) -> None:
    upload(client, photo(), pasted=True)
    upload(client, photo((0, 0, 255)), pasted=True, note="Home/Recipes/Cake.md")
    put(filled, "Home/Recipes/Files/mine.txt", "x")
    index.scan()
    answer = file_settings(client, attachment_folder="Files", rename_existing=True).json()
    assert answer["renamed"] == 1 and answer["left"] == ["Home/Recipes/Attachments"]
    assert (filled / "Home" / "Files" / "Shopping 1.jpg").is_file()
    assert (filled / "Home" / "Recipes" / "Attachments" / "Cake 1.jpg").is_file()
    assert (filled / "Home" / "Recipes" / "Files" / "mine.txt").is_file()


def test_without_the_wish_the_folders_there_keep_their_name(client: TestClient, filled: Path) -> None:
    upload(client, photo(), pasted=True)
    answer = file_settings(client, attachment_folder="Files").json()
    assert answer["renamed"] == 0
    assert (filled / "Home" / "Attachments" / "Shopping 1.jpg").is_file()


def test_a_new_name_that_only_changes_case_renames_too(client: TestClient, filled: Path) -> None:
    shopping = upload(client, photo(), pasted=True).json()
    link_in(client, "Home/Shopping.md", [shopping["link"]])
    answer = file_settings(client, attachment_folder="attachments", rename_existing=True).json()
    assert answer["renamed"] == 1
    assert sorted(entry.name for entry in (filled / "Home").iterdir() if entry.is_dir()) == ["Recipes", "attachments"]
    # The link is spelled anew too: on Linux and in GitHub, "Attachments/" does not lead into "attachments/".
    assert (filled / "Home" / "Shopping.md").read_text(encoding="utf-8") == "# Note\n\n![](attachments/Shopping%201.jpg)\n"
    links = client.get("/api/links", params={"path": "Home/Shopping.md"}, headers=TAB).json()
    assert [item["path"] for item in links["outgoing"]] == ["Home/attachments/Shopping 1.jpg"]
