"""The vault over HTTP, as the interface uses it."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import index

TAB = {"X-Nexlore-Client": "tab-aaaaaaaa"}
OTHER_TAB = {"X-Nexlore-Client": "tab-bbbbbbbb"}


def put(root: Path, rel: str, content: str | bytes) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)


@pytest.fixture
def filled(vault: Path, account: str) -> Path:
    put(vault, "Work/Plan.md", "---\ntags: [project]\n---\n# Plan\nSee [[Idea]] and [[Missing]]. #todo")
    put(vault, "Work/Ideas/Idea.md", "An idea about gardening.")
    put(vault, "Work/Ideas/pic.png", b"\x89PNG")
    put(vault, "Home/Shopping.md", "Milk and gardening gloves")
    (vault / "Work" / "Empty").mkdir()
    index.scan()
    return vault


def test_every_vault_route_needs_an_account(client: TestClient) -> None:
    for method, url in [
        ("get", "/api/spaces"), ("get", "/api/folder?path=Work"), ("get", "/api/note?path=Work/a.md"),
        ("put", "/api/note"), ("post", "/api/notes"), ("delete", "/api/files?path=Work/a.md"),
        ("post", "/api/move"), ("get", "/api/links?path=Work/a.md"), ("get", "/api/tags"),
        ("get", "/api/search?q=x"), ("get", "/api/graph?space=Work"), ("post", "/api/locks"),
        ("get", "/api/versions?path=Work/a.md"), ("get", "/api/trash"), ("get", "/api/index"),
        ("post", "/api/index/scan"), ("post", "/api/spaces"), ("post", "/api/folders"),
    ]:
        response = getattr(client, method)(url)
        assert response.status_code == 401, url
        assert response.json()["detail"]["code"] == "sign_in_required"


def test_open_access_is_off_unless_switched_on(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    assert client.get("/api/spaces").status_code == 401
    monkeypatch.setattr(get_settings(), "unsafe_open_access", True)
    assert client.get("/api/spaces").status_code == 200


def test_spaces_and_folders(client: TestClient, filled: Path) -> None:
    spaces = client.get("/api/spaces").json()
    assert [(space["name"], space["notes"], space["files"]) for space in spaces] == [("Home", 1, 1), ("Work", 2, 3)]
    listing = client.get("/api/folder", params={"path": "Work"}).json()
    assert [(item["name"], item["notes"]) for item in listing["folders"]] == [("Empty", 0), ("Ideas", 1)]
    assert [item["name"] for item in listing["files"]] == ["Plan.md"]
    assert client.get("/api/folder", params={"path": "Work/../Home"}).status_code == 400
    assert client.get("/api/folder", params={"path": "Nope"}).status_code == 404


def test_read_save_and_conflict(client: TestClient, filled: Path) -> None:
    note = client.get("/api/note", params={"path": "Work/Plan.md"}, headers=TAB).json()
    assert note["tags"] == ["project", "todo"] and note["front"] == {"tags": ["project"]} and not note["readonly"]
    saved = client.put(
        "/api/note", json={"path": "Work/Plan.md", "content": "new text", "base_hash": note["hash"]}, headers=TAB
    ).json()
    assert saved["saved"] and saved["hash"] != note["hash"]
    # Somebody else still holds the old hash: the save must not overwrite.
    stale = client.put(
        "/api/note", json={"path": "Work/Plan.md", "content": "stale edit", "base_hash": note["hash"]}, headers=OTHER_TAB
    ).json()
    assert stale["saved"] is False and stale["conflict"].startswith("Work/Plan (conflict ")
    assert (filled / "Work" / "Plan.md").read_bytes() == b"new text"


def test_a_byte_order_mark_survives_a_save(client: TestClient, filled: Path) -> None:
    put(filled, "Work/bom.md", b"\xef\xbb\xbfwith bom")
    index.scan()
    note = client.get("/api/note", params={"path": "Work/bom.md"}).json()
    assert note["bom"] and note["content"] == "with bom"
    client.put("/api/note", json={"path": "Work/bom.md", "content": "changed", "base_hash": note["hash"]})
    assert (filled / "Work" / "bom.md").read_bytes() == b"\xef\xbb\xbfchanged"


def test_a_note_that_is_not_utf8_is_read_only(client: TestClient, filled: Path) -> None:
    put(filled, "Work/latin.md", "Gr\xfc\xdfe".encode("latin-1"))
    index.scan()
    assert client.get("/api/note", params={"path": "Work/latin.md"}).json()["readonly"] is True


def test_create_links_and_backlinks(client: TestClient, filled: Path) -> None:
    created = client.post("/api/notes", json={"folder": "Work", "title": "Missing", "content": "now here"}).json()
    assert created["path"] == "Work/Missing.md"
    links = client.get("/api/links", params={"path": "Work/Plan.md"}).json()
    assert [(item["target"], item["path"]) for item in links["outgoing"]] == [
        ("Idea", "Work/Ideas/Idea.md"), ("Missing", "Work/Missing.md"),
    ]
    back = client.get("/api/links", params={"path": "Work/Ideas/Idea.md"}).json()["backlinks"]
    assert [item["path"] for item in back] == ["Work/Plan.md"]


def test_search_finds_words_by_prefix_and_is_safe(client: TestClient, filled: Path) -> None:
    hits = client.get("/api/search", params={"q": "garden"}).json()
    assert {hit["path"] for hit in hits} == {"Work/Ideas/Idea.md", "Home/Shopping.md"}
    assert "\x02" in hits[0]["snippet"]
    only = client.get("/api/search", params={"q": "garden", "space": "Home"}).json()
    assert [hit["path"] for hit in only] == ["Home/Shopping.md"]
    for nasty in ['"', "a OR b", "NEAR(a b)", "title:x", "*", "-a", "a AND", "(", "^x"]:
        assert client.get("/api/search", params={"q": nasty}).status_code == 200, nasty


def test_tags_and_graph(client: TestClient, filled: Path) -> None:
    assert client.get("/api/tags", params={"space": "Work"}).json() == [
        {"tag": "project", "count": 1}, {"tag": "todo", "count": 1},
    ]
    graph = client.get("/api/graph", params={"space": "Work"}).json()
    ids = {path: node_id for node_id, path, _title in graph["nodes"]}
    assert graph["links"] == [[ids["Work/Plan.md"], ids["Work/Ideas/Idea.md"]]]


def test_locks_belong_to_a_tab(client: TestClient, filled: Path) -> None:
    held = client.post("/api/locks", json={"path": "Work/Plan.md"}, headers=TAB).json()
    assert held["mine"] is True
    refused = client.post("/api/locks", json={"path": "Work/Plan.md"}, headers=OTHER_TAB)
    assert refused.status_code == 423 and refused.json()["detail"]["holder"] == "tester"
    seen = client.get("/api/note", params={"path": "Work/Plan.md"}, headers=OTHER_TAB).json()["lock"]
    assert seen["holder"] == "tester" and seen["mine"] is False
    assert client.delete("/api/locks", params={"path": "Work/Plan.md"}, headers=TAB).status_code == 204
    assert client.post("/api/locks", json={"path": "Work/Plan.md"}, headers=OTHER_TAB).status_code == 200


def test_move_trash_and_versions(client: TestClient, filled: Path) -> None:
    moved = client.post("/api/move", json={"source": "Work/Ideas/Idea.md", "destination": "Work/Thought.md"}).json()
    assert moved == {"path": "Work/Thought.md", "files": 1, "rewritten": 1}
    assert "[[Thought]]" in (filled / "Work" / "Plan.md").read_text()
    assert client.delete("/api/files", params={"path": "Work/Thought.md"}).json() == {"files": 1}
    [entry] = client.get("/api/trash").json()
    assert entry["path"] == "Work/Thought.md" and entry["how"] == "app" and entry["by"] == "tester"
    assert client.post(f"/api/trash/{entry['id']}/restore").json() == {"paths": ["Work/Thought.md"]}
    history = client.get("/api/versions", params={"path": "Work/Thought.md"}).json()
    assert history and client.get(f"/api/versions/{history[0]['id']}").json()["content"]
    assert client.post("/api/trash/not-an-id/restore").status_code == 422


def test_paths_that_leave_the_vault_are_refused(client: TestClient, filled: Path) -> None:
    for path in ["../secret.md", "/etc/passwd", "Work/../../x.md", "C:/x.md", "Work\\x.md", "Work/.obsidian/x.md"]:
        response = client.get("/api/note", params={"path": path})
        assert response.status_code == 400, path


def test_index_status_and_scan(client: TestClient, filled: Path) -> None:
    put(filled, "Work/later.md", "later")
    assert client.post("/api/index/scan").json()["added"] == 1
    assert client.get("/api/index").json()["last"]["added"] == 1


def test_a_change_without_the_tab_header_is_refused(client: TestClient, filled: Path) -> None:
    for method, url, body in [
        ("post", "/api/notes", {"folder": "Work", "title": "x"}), ("post", "/api/locks", {"path": "Work/Plan.md"}),
        ("delete", "/api/files?path=Work/Plan.md", None), ("post", "/api/logs/mode", {"mode": "quiet"}),
    ]:
        response = client.request(method.upper(), url, json=body, headers={"X-Nexlore-Client": ""})
        assert response.status_code == 400, url
        assert response.json()["detail"]["code"] == "client_required"
        assert "content-security-policy" in response.headers  # still wrapped by the outer middleware
    assert (filled / "Work" / "Plan.md").exists()
    # Reading needs no header.
    assert client.get("/api/spaces", headers={"X-Nexlore-Client": ""}).status_code == 200


def test_a_body_too_large_is_refused_before_it_is_read(client: TestClient, filled: Path) -> None:
    from app.middleware import MAX_BODY

    declared = client.put("/api/note", content=b"x" * (MAX_BODY + 1), headers={"Content-Type": "application/json"})
    assert declared.status_code == 413 and declared.json()["detail"]["code"] == "too_large"

    def chunks():  # no Content-Length: counted while it arrives
        for _ in range(MAX_BODY // (1024 * 1024) + 2):
            yield b"x" * (1024 * 1024)

    streamed = client.put("/api/note", content=chunks(), headers={"Content-Type": "application/json"})
    assert streamed.status_code == 413


def test_a_reader_without_header_never_passes_as_a_lock_holder(client: TestClient, filled: Path) -> None:
    client.post("/api/locks", json={"path": "Work/Plan.md"}, headers=TAB)
    lock = client.get("/api/note", params={"path": "Work/Plan.md"}, headers={"X-Nexlore-Client": ""}).json()["lock"]
    assert lock["mine"] is False


def test_teardown_clears_overrides() -> None:
    assert app.dependency_overrides == {}
