"""The search page: operators as Obsidian reads them, readable spaces only, and the lines a note was found in."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import index
from app.services.searchquery import parse

from .conftest import make_account, sign_in


def put(root: Path, rel: str, content: str) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode())


@pytest.fixture
def filled(vault: Path, account: str) -> Path:
    put(vault, "Homelab/Inventar/Geräte.md", "---\ntags: [server]\nstatus: offen\n---\n# Geräte\n\nDer ZFS Pool tank läuft.\nScrub des zfs pool am Sonntag.\n- [ ] Platte tauschen im Pool\n")
    put(vault, "Homelab/Entscheidungen/Warum ZFS.md", "---\ntags: [server/storage]\nstatus: [fertig, gut]\n---\nEin ZFS Pool prüft alles. #netz\n")
    put(vault, "Homelab/Test/Probe.md", "zfs pool test only\n")
    put(vault, "Küche/Brot.md", "---\nstatus: offen\n---\nMehl und Wasser. Café au lait.\n- [x] Mehl kaufen\n")
    old = vault / "Küche" / "Alt.md"
    put(vault, "Küche/Alt.md", "Ein alter Pool.\n")
    stamp = time.time() - 30 * 86400
    os.utime(old, (stamp, stamp))
    index.scan()
    return vault


def find(client: TestClient, q: str) -> list[str]:
    answer = client.get("/api/search/notes", params={"q": q})
    assert answer.status_code == 200, answer.text
    return [note["path"] for note in answer.json()["notes"]]


def test_the_operators_narrow_the_search(client: TestClient, filled: Path) -> None:
    assert set(find(client, "pool")) == {"Homelab/Inventar/Geräte.md", "Homelab/Entscheidungen/Warum ZFS.md", "Homelab/Test/Probe.md", "Küche/Alt.md"}
    assert set(find(client, "pool -test")) == {"Homelab/Inventar/Geräte.md", "Homelab/Entscheidungen/Warum ZFS.md", "Küche/Alt.md"}
    assert set(find(client, 'tag:server "zfs pool"')) == {"Homelab/Inventar/Geräte.md", "Homelab/Entscheidungen/Warum ZFS.md"}
    assert find(client, "tag:server/storage") == ["Homelab/Entscheidungen/Warum ZFS.md"]
    assert find(client, "path:inventar pool") == ["Homelab/Inventar/Geräte.md"]
    assert set(find(client, "space:küche")) == {"Küche/Brot.md", "Küche/Alt.md"}
    assert find(client, "file:warum") == ["Homelab/Entscheidungen/Warum ZFS.md"]
    assert set(find(client, "[status:offen]")) == {"Homelab/Inventar/Geräte.md", "Küche/Brot.md"}
    assert find(client, "[status:gut]") == ["Homelab/Entscheidungen/Warum ZFS.md"]
    assert set(find(client, "[status]")) == {"Homelab/Inventar/Geräte.md", "Homelab/Entscheidungen/Warum ZFS.md", "Küche/Brot.md"}
    assert find(client, "task:") == ["Homelab/Inventar/Geräte.md"]
    assert "Küche/Alt.md" not in find(client, "changed:7d")
    assert "Küche/Alt.md" in find(client, "changed:5w")
    # Accents as the index reads them.
    assert find(client, "cafe") == ["Küche/Brot.md"]
    # Nothing typed, or only noise: nothing.
    assert find(client, "") == [] and find(client, '""') == []


def test_each_note_shows_the_lines_it_was_found_in_with_the_words_marked(client: TestClient, filled: Path) -> None:
    notes = client.get("/api/search/notes", params={"q": "zfs pool"}).json()["notes"]
    lines = next(note for note in notes if note["path"] == "Homelab/Inventar/Geräte.md")["lines"]
    assert [line["line"] for line in lines] == [7, 8, 9]
    assert lines[0]["text"] == "Der \x02ZFS\x03 \x02Pool\x03 tank läuft."
    # With task: the task lines only.
    tasks = client.get("/api/search/notes", params={"q": "task:pool"}).json()["notes"]
    assert tasks[0]["lines"] == [{"line": 9, "text": "Platte tauschen im \x02Pool\x03"}]


def test_nothing_comes_from_a_space_the_account_may_not_read(client: TestClient, filled: Path) -> None:
    stranger = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-stranger"})
    sign_in(stranger, make_account("stranger"))
    assert find(stranger, "pool") == []
    assert find(stranger, "space:Homelab") == []


@pytest.mark.parametrize("nasty", ['"', 'a OR b', "NEAR(a b)", "title:x", "*", "-", '-"', "[", "[]", "[:]", "tag:", "changed:99999d", "a AND", "(", "^x", '\\"x', "'; DROP TABLE files; --"])
def test_no_search_text_is_taken_as_syntax(client: TestClient, filled: Path, nasty: str) -> None:
    assert client.get("/api/search/notes", params={"q": nasty}).status_code == 200


def test_the_parser_reads_obsidian_s_way_of_writing() -> None:
    query = parse('tag:#garden/beds path:"Recipes" -old "zfs pool" [status:open] task:call changed:2w word')
    assert query.tags == ["garden/beds"]
    assert query.paths == ["Recipes"]
    assert query.without == ["old"]
    assert query.phrases == ["zfs pool"]
    assert query.properties == [("status", "open")]
    assert query.tasks and "call" in query.words and "word" in query.words
    assert query.changed == 14 * 86400
    assert query.fts() == '"call"* "word"* "zfs pool" NOT "old"*'
    # A value with a blank stays one value.
    spaced = parse('space:"Mein Wissen" path:"Team Homelab/Inventar" brot')
    assert spaced.spaces == ["Mein Wissen"] and spaced.paths == ["Team Homelab/Inventar"] and spaced.words == ["brot"]
