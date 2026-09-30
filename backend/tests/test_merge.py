"""Merging a note into another (Obsidian's note composer): its text to the end, its links along, it to the trash."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services import index

TAB = {"X-Nexlore-Client": "tab-aaaaaaaa"}
OTHER_TAB = {"X-Nexlore-Client": "tab-bbbbbbbb"}


def put(root: Path, rel: str, content: str | bytes) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)


@pytest.fixture
def notes(vault: Path, account: str) -> Path:
    put(vault, "Work/Plan.md", "# Plan\n\nThe plan.\n")
    put(vault, "Work/Ideas/Idea.md", "---\ntags: [idea]\n---\n# Idea\n\nAn idea, see [[Plan]].\n")
    put(vault, "Work/Log.md", "Read [[Idea]], [[Ideas/Idea|the idea]] and [more](Ideas/Idea.md).\n")
    put(vault, "Work/Windows.md", "\ufeffLine one\r\nLine two\r\n")
    put(vault, "Home/Other.md", "Elsewhere.\n")
    index.scan()
    return vault


def test_the_text_goes_to_the_end_and_the_links_follow(client: TestClient, notes: Path) -> None:
    answer = client.post("/api/notes/merge", json={"source": "Work/Ideas/Idea.md", "target": "Work/Plan.md"}, headers=TAB)
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"path": "Work/Plan.md", "rewritten": 1}
    # The front matter of the note that went is left out.
    assert (notes / "Work" / "Plan.md").read_text(encoding="utf-8") == "# Plan\n\nThe plan.\n\n# Idea\n\nAn idea, see [[Plan]].\n"
    assert not (notes / "Work" / "Ideas" / "Idea.md").exists()
    # Every way of writing the link now leads to the target.
    assert (notes / "Work" / "Log.md").read_text(encoding="utf-8") == "Read [[Plan]], [[Plan|the idea]] and [more](Plan.md).\n"
    # The note that went is in the trash, whence it comes back.
    trash = client.get("/api/trash").json()
    assert any(item["path"] == "Work/Ideas/Idea.md" for item in trash)


def test_line_endings_and_the_mark_of_the_target_stay(client: TestClient, notes: Path) -> None:
    answer = client.post("/api/notes/merge", json={"source": "Work/Log.md", "target": "Work/Windows.md"}, headers=TAB)
    assert answer.status_code == 200, answer.text
    assert (notes / "Work" / "Windows.md").read_bytes() == (
        "\ufeffLine one\r\nLine two\r\n\r\nRead [[Idea]], [[Ideas/Idea|the idea]] and [more](Ideas/Idea.md).\r\n".encode()
    )


@pytest.mark.parametrize(
    "source, target, status, code",
    [
        ("Work/Plan.md", "Work/Plan.md", 400, "path_invalid"),
        ("Work/Plan.md", "Home/Other.md", 400, "move_across_spaces"),
        ("Work/Plan.md", "Work/Nowhere.md", 404, "not_found"),
    ],
)
def test_what_is_not_merged(client: TestClient, notes: Path, source: str, target: str, status: int, code: str) -> None:
    answer = client.post("/api/notes/merge", json={"source": source, "target": target}, headers=TAB)
    assert (answer.status_code, answer.json()["detail"]["code"]) == (status, code)
    assert (notes / "Work" / "Plan.md").read_text(encoding="utf-8") == "# Plan\n\nThe plan.\n"


def test_not_while_somebody_else_writes_one_of_them(client: TestClient, notes: Path) -> None:
    assert client.post("/api/locks", json={"path": "Work/Plan.md"}, headers=OTHER_TAB).status_code == 200
    answer = client.post("/api/notes/merge", json={"source": "Work/Ideas/Idea.md", "target": "Work/Plan.md"}, headers=TAB)
    assert answer.status_code == 423
    assert (notes / "Work" / "Ideas" / "Idea.md").exists()
    assert (notes / "Work" / "Plan.md").read_text(encoding="utf-8") == "# Plan\n\nThe plan.\n"
