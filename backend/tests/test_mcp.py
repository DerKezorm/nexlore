"""AI from outside over MCP (M7): keys, the walls in front, the three levels, drafts, the rights of M4.

The world: the operator ``tester`` has switched MCP on. ``anna`` writes in ``Garden`` and has a key; ``Secret`` is a
space of ``bob`` that anna may not read. Every tool must treat Secret like a space that does not exist.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Draft, File, Version
from app.services import inbox, index, mcp, settings_service, textblocks

from .conftest import join, make_account, sign_in

NOTE = "# Plan\r\n\r\nFirst line.  \r\nSecond line.\r\n"


def person(name: str) -> TestClient:
    row = make_account(name)
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, row)
    return client


def switch(**values: object) -> None:
    with SessionLocal() as db:
        settings_service.save(db, values)


class World:
    def __init__(self, operator: TestClient, vault: Path) -> None:
        self.operator = operator
        self.vault = vault
        self.anna = person("anna")
        self.bob = person("bob")
        assert self.anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
        assert self.bob.post("/api/spaces", json={"name": "Secret"}).status_code == 201
        (vault / "Garden" / "Plan.md").write_bytes(NOTE.encode())
        (vault / "Secret" / "Diary.md").write_bytes(b"# Diary\n\nnothing for anna, zucchini\n")
        index.scan()
        switch(mcp_allowed=True, mcp_max_level="write")

    def key(self, level: str = "read", who: TestClient | None = None, *, ask: bool = False) -> str:
        """A key; the tools that change things run at once unless ``ask`` keeps the defaults of block Y (asking)."""
        owner = who or self.anna
        made = owner.post("/api/mcp/keys", json={"name": f"agent {level}", "level": level})
        assert made.status_code == 201, made.text
        if not ask:
            changing = [t["name"] for t in owner.get("/api/mcp/tools").json()["tools"] if t["group"] == "change"]
            rights = owner.put(f"/api/mcp/keys/{made.json()['key']['id']}/rights",
                               json={"rights": dict.fromkeys(changing, "allow")})
            assert rights.status_code == 200, rights.text
        return made.json()["token"]


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    return World(client, vault)


def rpc(token: str | None, method: str, params: dict | None = None, *, headers: dict | None = None,
        message_id: int | None = 1):
    client = TestClient(app, base_url="http://testserver")
    body: dict = {"jsonrpc": "2.0", "method": method}
    if message_id is not None:
        body["id"] = message_id
    if params is not None:
        body["params"] = params
    sent = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post("/api/mcp", json=body, headers=sent | (headers or {}))


def call(token: str, tool: str, **arguments: object) -> dict:
    answer = rpc(token, "tools/call", {"name": tool, "arguments": arguments})
    assert answer.status_code == 200, answer.text
    return answer.json()["result"]


def value(result: dict) -> object:
    assert not result["isError"], result
    return json.loads(result["content"][0]["text"])


def failure(result: dict) -> str:
    assert result["isError"], result
    return result["content"][0]["text"]


# --- Keys and the walls in front -------------------------------------------------------------------------------------


def test_mcp_is_off_until_the_operator_opens_it(client: TestClient, account: object, vault: Path) -> None:
    anna = person("anna")
    assert anna.get("/api/mcp/keys").json()["allowed"] is False
    assert anna.post("/api/mcp/keys", json={"name": "x", "level": "read"}).status_code == 403
    switch(mcp_allowed=True)
    token = anna.post("/api/mcp/keys", json={"name": "x", "level": "read"}).json()["token"]
    assert rpc(token, "ping").status_code == 200
    # Switched off again: even a valid key finds nothing there.
    switch(mcp_allowed=False)
    off = rpc(token, "ping")
    assert off.status_code == 404
    assert off.json()["detail"]["code"] == "not_found"


def test_a_key_is_shown_once_and_stored_only_as_its_hash(world: World) -> None:
    token = world.key()
    assert token.startswith("nxl_") and len(token) > 40
    listed = world.anna.get("/api/mcp/keys").json()["keys"]
    assert [key["prefix"] for key in listed] == [token[:8]]
    assert token not in json.dumps(listed)
    with SessionLocal() as db:
        from app.models import McpKey

        row = db.scalars(select(McpKey)).one()
        assert row.token_hash == mcp.digest(token) and token not in (row.prefix + row.name)


def test_the_walls_before_any_tool(world: World) -> None:
    token = world.key()
    assert rpc(None, "ping").status_code == 401
    assert rpc("nxl_" + "x" * 43, "ping").status_code == 401
    # The 401 says where a connector signs in (OAuth, block Y).
    assert rpc("wrong", "ping").headers.get("www-authenticate") == (
        'Bearer resource_metadata="http://testserver/.well-known/oauth-protected-resource"'
    )
    # A web page sends an Origin: refused even with a valid key (no page can use a key it got hold of).
    assert rpc(token, "ping", headers={"Origin": "http://testserver"}).status_code == 403
    # The session cookie counts for nothing here.
    assert world.anna.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    assert TestClient(app).get("/api/mcp").status_code == 405
    notified = rpc(token, "notifications/initialized", message_id=None)
    assert notified.status_code == 202 and notified.content == b""
    broken = TestClient(app).post("/api/mcp", content=b"{nope", headers={"Authorization": f"Bearer {token}"})
    assert broken.status_code == 400 and broken.json()["error"]["code"] == -32700
    assert rpc(token, "no/such/method").json()["error"]["code"] == -32601


def test_a_revoked_key_is_dead_and_only_its_account_revokes_it(world: World) -> None:
    token = world.key()
    key_id = world.anna.get("/api/mcp/keys").json()["keys"][0]["id"]
    assert world.bob.delete(f"/api/mcp/keys/{key_id}").status_code == 404
    assert rpc(token, "ping").status_code == 200
    assert world.anna.delete(f"/api/mcp/keys/{key_id}").status_code == 204
    assert rpc(token, "ping").status_code == 401


def test_a_key_may_not_be_above_what_the_operator_allows(world: World) -> None:
    switch(mcp_max_level="draft")
    assert world.anna.post("/api/mcp/keys", json={"name": "w", "level": "write"}).status_code == 403
    switch(mcp_max_level="write")
    token = world.key("write")
    # Lowered later: the key acts at the new ceiling.
    switch(mcp_max_level="read")
    names = {tool["name"] for tool in rpc(token, "tools/list").json()["result"]["tools"]}
    assert "write_note" not in names and "propose_change" not in names and "read_note" in names
    assert "No tool" in failure(call(token, "write_note", path="Garden/Plan.md", content="x", base_hash="0" * 64))


def test_a_key_is_slowed_down_after_its_rate(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mcp, "PER_MINUTE", 3)
    token = world.key()
    assert [rpc(token, "ping").status_code for _ in range(4)] == [200, 200, 200, 429]


def test_the_key_never_reaches_the_log(world: World) -> None:
    token = world.key("write")
    call(token, "read_note", path="Garden/Plan.md")
    rpc("nxl_" + "y" * 43, "ping")
    log = (get_settings().data_dir / "logs" / "nexlore.log").read_text(encoding="utf-8")
    assert "MCP tool called tool=read_note" in log
    assert token not in log and token[4:] not in log


# --- Reading, with the rights of the account -------------------------------------------------------------------------


def test_initialize_and_the_tools_of_each_level(world: World) -> None:
    started = rpc(world.key(), "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}}).json()["result"]
    assert started["protocolVersion"] == "2025-03-26" and started["serverInfo"]["name"] == "nexlore"
    assert rpc(world.key(), "initialize", {"protocolVersion": "1999-01-01"}).json()["result"]["protocolVersion"] == "2025-06-18"
    levels = {}
    for level in ("read", "draft", "write"):
        levels[level] = {tool["name"] for tool in rpc(world.key(level), "tools/list").json()["result"]["tools"]}
    reading = {"list_spaces", "search", "search_notes", "find_notes", "read_note", "list_folder", "note_links",
               "list_tasks", "request_status", "space_options", "list_templates", "list_versions", "read_version",
               "list_tags", "read_comments", "list_attachments", "unlinked_mentions", "cleanup_report", "list_trash",
               "list_members", "list_shares"}
    assert levels["read"] == reading
    assert levels["draft"] == levels["read"] | {"propose_change", "propose_note"}
    changing = {"write_note", "edit_note", "create_note", "complete_task", "append_to_daily", "create_space", "rename_space",
                "set_space_options", "create_folder", "rename_folder", "move_folder", "rename_note", "move_note",
                "create_from_template", "set_property", "merge_notes", "restore_version", "restore_from_trash",
                "rename_tag", "add_comment", "reply_comment", "resolve_comment", "capture_to_inbox",
                "upload_attachment", "link_mention", "set_favorite"}
    # Deleting, sharing and members are denied by default: a write key does not see them.
    assert levels["write"] == levels["draft"] | changing


def test_a_foreign_space_answers_like_a_missing_one(world: World) -> None:
    token = world.key("write")
    assert [space["name"] for space in value(call(token, "list_spaces"))] == ["Garden"]
    assert value(call(token, "search", query="zucchini")) == []
    assert value(call(token, "find_notes", title="Diary")) == []
    for tool, arguments in (
        ("read_note", {"path": "Secret/Diary.md"}),
        ("list_folder", {"path": "Secret"}),
        ("note_links", {"path": "Secret/Diary.md"}),
        ("write_note", {"path": "Secret/Diary.md", "content": "x", "base_hash": "0" * 64}),
        ("create_note", {"folder": "Secret", "title": "x", "content": "x"}),
    ):
        foreign = failure(call(token, tool, **arguments))
        missing = failure(call(token, tool, **{key: v.replace("Secret", "Nowhere") if isinstance(v, str) else v
                                                  for key, v in arguments.items()}))
        assert foreign == missing == "Not found.", tool
    assert (world.vault / "Secret" / "Diary.md").read_bytes() == b"# Diary\n\nnothing for anna, zucchini\n"


def space_ids(client: TestClient) -> dict[str, int]:
    return {space["name"]: space["id"] for space in client.get("/api/spaces").json()}


def test_a_key_for_some_spaces_sees_no_other_even_where_its_account_may(world: World) -> None:
    assert world.anna.post("/api/spaces", json={"name": "Kitchen"}).status_code == 201
    (world.vault / "Kitchen" / "Recipe.md").write_bytes(b"# Recipe\n\n- [ ] buy zucchini\n\n[[Garden/Plan]]\n")
    (world.vault / "Garden" / "Plan.md").write_bytes(NOTE.encode() + b"\n[[Kitchen/Recipe]]\n- [ ] dig\n")
    index.scan()
    ids = space_ids(world.anna)
    made = world.anna.post("/api/mcp/keys", json={"name": "garden only", "level": "write", "spaces": [ids["Garden"]]})
    assert made.status_code == 201, made.text
    assert made.json()["key"]["spaces"] == ["Garden"]
    token = made.json()["token"]
    changing = [t["name"] for t in world.anna.get("/api/mcp/tools").json()["tools"] if t["group"] == "change"]
    assert world.anna.put(f"/api/mcp/keys/{made.json()['key']['id']}/rights",
                          json={"rights": dict.fromkeys(changing, "allow")}).status_code == 200
    everything = world.key("write")

    assert [space["name"] for space in value(call(token, "list_spaces"))] == ["Garden"]
    assert [space["name"] for space in value(call(everything, "list_spaces"))] == ["Garden", "Kitchen"]
    assert value(call(token, "search", query="zucchini")) == []
    assert value(call(everything, "search", query="zucchini")) != []
    assert value(call(token, "find_notes", title="Recipe")) == []
    assert [task["text"] for task in value(call(token, "list_tasks"))] == ["dig"]
    assert failure(call(token, "list_tasks", space="Kitchen")) == failure(call(token, "list_tasks", space="Nowhere"))
    links = value(call(token, "note_links", path="Garden/Plan.md"))
    assert [(link["target"], link["path"]) for link in links["outgoing"]] == [("Kitchen/Recipe", None)]
    assert links["backlinks"] == []
    assert value(call(everything, "note_links", path="Garden/Plan.md"))["backlinks"] != []
    base = index.digest(b"# Recipe\n\n- [ ] buy zucchini\n\n[[Garden/Plan]]\n")
    for tool, arguments in (
        ("read_note", {"path": "Kitchen/Recipe.md"}),
        ("list_folder", {"path": "Kitchen"}),
        ("note_links", {"path": "Kitchen/Recipe.md"}),
        ("write_note", {"path": "Kitchen/Recipe.md", "content": "x", "base_hash": base}),
        ("edit_note", {"path": "Kitchen/Recipe.md", "base_hash": base, "edits": [{"old": "buy", "new": "sell"}]}),
        ("propose_change", {"path": "Kitchen/Recipe.md", "content": "x", "base_hash": base}),
        ("create_note", {"folder": "Kitchen", "title": "x", "content": "x"}),
        ("propose_note", {"folder": "Kitchen", "title": "x", "content": "x"}),
    ):
        foreign = failure(call(token, tool, **arguments))
        missing = failure(call(token, tool, **{key: v.replace("Kitchen", "Nowhere") if isinstance(v, str) else v
                                                  for key, v in arguments.items()}))
        assert foreign == missing == "Not found.", tool
    assert (world.vault / "Kitchen" / "Recipe.md").read_bytes().startswith(b"# Recipe\n\n- [ ] buy")
    assert sorted(path.name for path in (world.vault / "Kitchen").iterdir()) == ["Recipe.md"]
    with SessionLocal() as db:
        assert db.scalars(select(Draft.id)).all() == []
    # The account itself, in the interface, still sees both.
    assert world.anna.get("/api/note", params={"path": "Kitchen/Recipe.md"}).status_code == 200
    # A space made later: the key for all sees it, the chosen one does not.
    assert world.anna.post("/api/spaces", json={"name": "Later"}).status_code == 201
    assert "Later" in [space["name"] for space in value(call(everything, "list_spaces"))]
    assert "Later" not in [space["name"] for space in value(call(token, "list_spaces"))]


def test_a_key_is_made_only_for_spaces_its_account_may_read(world: World) -> None:
    ids = space_ids(world.bob)
    foreign = world.anna.post("/api/mcp/keys", json={"name": "x", "level": "read", "spaces": [ids["Secret"]]})
    missing = world.anna.post("/api/mcp/keys", json={"name": "x", "level": "read", "spaces": [987654]})
    assert foreign.status_code == missing.status_code == 422
    assert foreign.json() == missing.json()
    assert world.anna.post("/api/mcp/keys", json={"name": "x", "level": "read", "spaces": []}).status_code == 422
    assert world.anna.get("/api/mcp/keys").json()["keys"] == []


def test_a_space_the_account_lost_drops_out_of_its_key(world: World) -> None:
    join(world.bob, "Secret", "anna", "read")
    anna_ids = space_ids(world.anna)
    made = world.anna.post("/api/mcp/keys", json={"name": "x", "level": "read",
                                                   "spaces": [anna_ids["Secret"], anna_ids["Garden"]]})
    assert made.status_code == 201, made.text
    token = made.json()["token"]
    assert [space["name"] for space in value(call(token, "list_spaces"))] == ["Garden", "Secret"]
    gone = world.bob.delete("/api/spaces/Secret/members/anna")
    assert gone.status_code in (200, 204), gone.text
    assert [space["name"] for space in value(call(token, "list_spaces"))] == ["Garden"]
    assert failure(call(token, "read_note", path="Secret/Diary.md")) == "Not found."
    assert world.anna.get("/api/mcp/keys").json()["keys"][0]["spaces"] == ["Garden"]


def test_reading_tools(world: World) -> None:
    token = world.key()
    note = value(call(token, "read_note", path="Garden/Plan.md"))
    assert note["content"] == NOTE and note["hash"] == index.digest(NOTE.encode())
    hits = value(call(token, "search", query="second"))
    assert hits[0]["path"] == "Garden/Plan.md" and "«Second»" in hits[0]["snippet"]
    assert value(call(token, "list_folder", path="Garden"))["files"][0]["path"] == "Garden/Plan.md"
    assert "must be of type string" in failure(call(token, "read_note", path=7))


# --- Drafts ----------------------------------------------------------------------------------------------------------


def test_a_draft_waits_for_its_owner_and_keeps_what_it_did_not_change(world: World) -> None:
    token = world.key("draft")
    base = index.digest(NOTE.encode())
    # The AI sends plain line breaks and dropped the trailing spaces: those lines are unchanged all the same.
    made = value(call(token, "propose_change", path="Garden/Plan.md", base_hash=base, reason="a third line",
                      content="# Plan\n\nFirst line.\nSecond line.\nThird line.\n"))
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == NOTE.encode()  # nothing changed yet
    listed = world.anna.get("/api/drafts", params={"path": "Garden/Plan.md"}).json()
    assert [(d["id"], d["reason"], d["key_name"]) for d in listed] == [(made["draft"], "a third line", "agent draft")]
    assert world.bob.get(f"/api/drafts/{made['draft']}").status_code == 404
    full = world.anna.get(f"/api/drafts/{made['draft']}").json()
    assert full["changed"] is False and full["current"] == NOTE
    taken = world.anna.post(f"/api/drafts/{made['draft']}/accept").json()
    assert taken == {"path": "Garden/Plan.md", "conflict": None}
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == (NOTE + "Third line.\r\n").encode()
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == "Garden/Plan.md"))
        newest = db.scalars(select(Version).where(Version.file_id == file_id).order_by(Version.id.desc())).first()
        assert (newest.source, newest.author) == (index.MCP, "anna")
        assert db.scalars(select(Draft)).all() == []


def test_a_draft_of_a_note_changed_since_ends_in_a_conflict_copy(world: World) -> None:
    token = world.key("draft")
    made = value(call(token, "propose_change", path="Garden/Plan.md", base_hash=index.digest(NOTE.encode()),
                      content="replaced"))
    (world.vault / "Garden" / "Plan.md").write_bytes(b"changed in Obsidian")
    index.scan()
    assert world.anna.get(f"/api/drafts/{made['draft']}").json()["changed"] is True
    taken = world.anna.post(f"/api/drafts/{made['draft']}/accept").json()
    assert taken["conflict"].startswith("Garden/Plan (conflict ")
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == b"changed in Obsidian"


def test_a_draft_needs_the_right_to_write_and_disappears_with_the_right_to_read(world: World) -> None:
    carl = person("carl")
    join(world.anna, "Garden", "carl", "read")
    token = world.key("draft", who=carl)
    base = index.digest(NOTE.encode())
    assert failure(call(token, "propose_change", path="Garden/Plan.md", base_hash=base, content="x")) != ""
    join(world.anna, "Garden", "carl", "write")
    made = value(call(token, "propose_change", path="Garden/Plan.md", base_hash=base, content="x"))
    assert len(carl.get("/api/drafts").json()) == 1
    assert world.anna.delete("/api/spaces/Garden/members/carl").status_code in (200, 204)
    assert carl.get("/api/drafts").json() == []
    assert carl.post(f"/api/drafts/{made['draft']}/accept").status_code == 404


def test_a_draft_of_a_new_note_makes_it_when_taken_over(world: World) -> None:
    token = world.key("draft")
    made = value(call(token, "propose_note", folder="Garden", title="Seeds", content="# Seeds\n"))
    drafts = world.anna.get("/api/drafts").json()
    assert drafts[0]["new"] is True and drafts[0]["title"] == "Seeds"
    assert not (world.vault / "Garden" / "Seeds.md").exists()
    assert world.anna.post(f"/api/drafts/{made['draft']}/accept").json()["path"] == "Garden/Seeds.md"
    assert (world.vault / "Garden" / "Seeds.md").read_bytes() == b"# Seeds\n"


def test_throwing_a_draft_away(world: World) -> None:
    token = world.key("draft")
    made = value(call(token, "propose_change", path="Garden/Plan.md", base_hash=index.digest(NOTE.encode()),
                      content="x"))
    assert world.anna.delete(f"/api/drafts/{made['draft']}").status_code == 204
    assert world.anna.get("/api/drafts").json() == []
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == NOTE.encode()


# --- Writing ---------------------------------------------------------------------------------------------------------


def test_writing_keeps_unchanged_lines_byte_for_byte(world: World) -> None:
    token = world.key("write")
    base = index.digest(NOTE.encode())
    saved = value(call(token, "write_note", path="Garden/Plan.md", base_hash=base,
                       content="# Plan\n\nFirst line.\nSecond line, longer.\n"))
    assert saved["saved"] is True and saved["conflict"] is None
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == b"# Plan\r\n\r\nFirst line.  \r\nSecond line, longer.\r\n"


def test_writing_against_an_old_state_writes_a_conflict_copy(world: World) -> None:
    token = world.key("write")
    base = index.digest(NOTE.encode())
    (world.vault / "Garden" / "Plan.md").write_bytes(b"# Plan\n\nchanged meanwhile\n")
    index.scan()
    saved = value(call(token, "write_note", path="Garden/Plan.md", base_hash=base, content="mine"))
    assert saved["saved"] is False and saved["conflict"].startswith("Garden/Plan (conflict ")
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == b"# Plan\n\nchanged meanwhile\n"
    # An edit against the old state comes from the note's history, and goes into a copy just the same.
    edited = value(call(token, "edit_note", path="Garden/Plan.md", base_hash=base,
                        edits=[{"old": "Second line.", "new": "Second, edited."}]))
    assert edited["conflict"] is not None
    assert "never" not in failure(call(token, "write_note", path="Garden/Plan.md", base_hash="1" * 64, content="x"))


def test_writing_while_somebody_edits_goes_into_a_conflict_copy(world: World) -> None:
    token = world.key("write")
    assert world.anna.post("/api/locks", json={"path": "Garden/Plan.md"}).status_code == 200
    saved = value(call(token, "write_note", path="Garden/Plan.md", base_hash=index.digest(NOTE.encode()),
                       content="from the AI"))
    assert saved["conflict"] is not None
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == NOTE.encode()


def test_edits_must_find_their_text_once(world: World) -> None:
    token = world.key("write")
    base = index.digest(NOTE.encode())
    assert "occurs 0 times" in failure(call(token, "edit_note", path="Garden/Plan.md", base_hash=base,
                                            edits=[{"old": "nowhere", "new": "x"}]))
    assert "occurs 2 times" in failure(call(token, "edit_note", path="Garden/Plan.md", base_hash=base,
                                            edits=[{"old": "line", "new": "x"}]))
    done = value(call(token, "edit_note", path="Garden/Plan.md", base_hash=base,
                      edits=[{"old": "Second line.", "new": "Second line!"}]))
    assert done["saved"] is True
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == NOTE.replace("Second line.", "Second line!").encode()


def test_create_note_needs_the_right_to_write(world: World) -> None:
    token = world.key("write")
    made = value(call(token, "create_note", folder="Garden", title="Weeds", content="pull them"))
    assert made["path"] == "Garden/Weeds.md"
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == "Garden/Weeds.md"))
        assert db.scalar(select(Version.source).where(Version.file_id == file_id)) == index.MCP


# --- The block layer on the server -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("original", "new", "expected"),
    [
        (b"a\r\nb\r\n", "a\nb\n", b"a\r\nb\r\n"),  # nothing changed: the same bytes
        (b"\xef\xbb\xbfa\nb\n", "a\nc\n", b"\xef\xbb\xbfa\nc\n"),  # the byte order mark stays
        (b"a  \nb\n", "a\nb\nc", b"a  \nb\nc\n"),  # trailing spaces kept, the last line break too
        (b"a\nb", "a\nb\nc\n", b"a\nb\nc\n"),  # an old last line without a break gets one when more follows
        (b"x\r\ny\r\n", "x\ny\nz\n", b"x\r\ny\r\nz\r\n"),  # new lines take the file's line endings
        (b"", "new\n", b"new\n"),
    ],
)
def test_the_block_layer_keeps_what_did_not_change(original: bytes, new: str, expected: bytes) -> None:
    assert textblocks.keep_unchanged(original, new) == expected


def test_taking_a_draft_over_needs_the_right_to_write_now(world: World) -> None:
    carl = person("carl")
    join(world.anna, "Garden", "carl", "write")
    made = value(call(world.key("draft", who=carl), "propose_change", path="Garden/Plan.md",
                      base_hash=index.digest(NOTE.encode()), content="carl's words"))
    # Only reading now: the draft is still his to see and throw away, but not to take over.
    join(world.anna, "Garden", "carl", "read")
    assert carl.get(f"/api/drafts/{made['draft']}").status_code == 200
    assert carl.post(f"/api/drafts/{made['draft']}/accept").status_code == 403
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == NOTE.encode()


def test_a_direct_write_says_it_came_over_mcp(world: World) -> None:
    token = world.key("write")
    value(call(token, "write_note", path="Garden/Plan.md", base_hash=index.digest(NOTE.encode()), content="new"))
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == "Garden/Plan.md"))
        newest = db.scalars(select(Version).where(Version.file_id == file_id).order_by(Version.id.desc())).first()
    assert (newest.source, newest.author) == (index.MCP, "anna")



# --- Searching with operators, ticking a task off, the daily note (K7) --------------------------------------------


def test_searching_with_operators_gives_the_lines_and_keeps_to_readable_spaces(world: World) -> None:
    token = world.key()
    found = value(call(token, "search_notes", query="path:Garden second"))
    assert [note["path"] for note in found["notes"]] == ["Garden/Plan.md"]
    assert found["notes"][0]["lines"] == [{"line": 4, "text": "«Second» line."}]
    # bob's space holds the word; anna's key finds nothing there.
    assert value(call(token, "search_notes", query="zucchini")) == {"notes": [], "more": False}
    assert value(call(token, "search_notes", query="-second first"))["notes"] == []


def test_a_task_is_ticked_off_by_its_line_with_the_right_to_write(world: World) -> None:
    (world.vault / "Garden" / "Todo.md").write_bytes(b"# Todo\n\n- [ ] Water the beds\n- [ ] Buy seeds\n")
    index.scan()
    reading = world.key()
    tasks = value(call(reading, "list_tasks", query="Water"))
    assert tasks[0]["raw"] == "- [ ] Water the beds"
    # A read key does not know the tool.
    assert "complete_task" in failure(call(reading, "complete_task", path="Garden/Todo.md", line=3, raw=tasks[0]["raw"]))
    token = world.key("write")
    done = value(call(token, "complete_task", path="Garden/Todo.md", line=tasks[0]["line"], raw=tasks[0]["raw"]))
    assert done["raw"].startswith("- [x] Water the beds")
    text = (world.vault / "Garden" / "Todo.md").read_bytes().decode()
    assert text.startswith("# Todo\n\n- [x] Water the beds") and text.endswith("- [ ] Buy seeds\n")
    # Open again.
    value(call(token, "complete_task", path="Garden/Todo.md", line=3, raw=done["raw"], done=False))
    assert (world.vault / "Garden" / "Todo.md").read_bytes().decode().startswith("# Todo\n\n- [ ] Water the beds")
    # Not in bob's space.
    assert "Not found" in failure(call(token, "complete_task", path="Secret/Diary.md", line=1, raw="x"))


def test_text_goes_at_the_end_of_the_daily_note_made_when_missing(world: World) -> None:
    token = world.key("write")
    first = value(call(token, "append_to_daily", space="Garden", text="Bought seeds", date="2026-09-29"))
    assert first["created"] is True
    path = first["path"]
    assert path.startswith("Garden/") and "2026-09-29" in path
    again = value(call(token, "append_to_daily", space="Garden", text="Watered\nall of them", date="2026-09-29"))
    assert again == {"path": path, "created": False}
    assert (world.vault / path).read_bytes().decode().endswith("Bought seeds\n\nWatered\nall of them\n")
    # Somebody editing it: nothing written.
    assert world.anna.post("/api/locks", json={"path": path}).status_code == 200
    assert "editing" in failure(call(token, "append_to_daily", space="Garden", text="later", date="2026-09-29"))
    assert "later" not in (world.vault / path).read_bytes().decode()
    assert "Not found" in failure(call(token, "append_to_daily", space="Secret", text="x"))
    assert "'text'" in failure(call(token, "append_to_daily", space="Garden", text="   ", date="2026-09-29"))


def test_text_at_the_end_keeps_the_line_endings_of_the_note() -> None:
    assert inbox.at_end("", "One") == "One\n"
    assert inbox.at_end("# Day\n", "One") == "# Day\n\nOne\n"
    assert inbox.at_end("# Day", "One") == "# Day\n\nOne\n"
    assert inbox.at_end("# Day\r\n\r\n", "One\ntwo") == "# Day\r\n\r\nOne\r\ntwo\r\n"
