"""Block Y: rights per tool, the operator's block list, requests that wait for approval, and the tools for everything
the interface can do.

The world of ``test_mcp``: anna writes in ``Garden`` and makes keys; ``Secret`` is bob's.
"""

from __future__ import annotations

import base64
import json
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import File, McpKey, McpRequest, Version, utcnow
from app.services import index, mcp

from .conftest import join
from .test_mcp import NOTE, World, call, failure, person, rpc, switch, value


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    return World(client, vault)


def listed(token: str) -> set[str]:
    return {tool["name"] for tool in rpc(token, "tools/list").json()["result"]["tools"]}


def key_id(world: World, token: str) -> int:
    with SessionLocal() as db:
        found = db.scalar(select(McpKey.id).where(McpKey.token_hash == mcp.digest(token)))
    assert found is not None
    return int(found)


def set_rights(world: World, token: str, **rights: str) -> None:
    """Set some rights of a key and keep the others, as the interface does."""
    number = key_id(world, token)
    keys = {key["id"]: key for key in world.anna.get("/api/mcp/keys").json()["keys"]}
    answer = world.anna.put(f"/api/mcp/keys/{number}/rights", json={"rights": keys[number]["rights"] | rights})
    assert answer.status_code == 200, answer.text


def plan_hash(world: World) -> str:
    return value(call(world.key("read"), "read_note", path="Garden/Plan.md"))["hash"]


# --- Rights per tool ---------------------------------------------------------------------------------------------------


def test_a_new_key_reads_at_once_asks_before_changing_and_does_not_see_deleting(world: World) -> None:
    token = world.key("write", ask=True)
    tools = listed(token)
    assert {"read_note", "create_note", "create_space", "write_note"} <= tools
    # Denied by default: not there at all.
    assert not tools & {"trash_note", "trash_folder", "invite_member", "create_share", "remove_member", "delete_space"}
    assert value(call(token, "read_note", path="Garden/Plan.md"))["content"] == NOTE
    waiting = value(call(token, "create_note", folder="Garden", title="Seeds", content="Beans"))
    assert waiting["status"] == "waiting" and isinstance(waiting["request"], int)
    assert not (world.vault / "Garden" / "Seeds.md").exists()
    assert "No tool called" in failure(call(token, "trash_note", path="Garden/Plan.md"))
    assert (world.vault / "Garden" / "Plan.md").exists()


def test_a_denied_tool_is_missing_from_the_list_and_unknown_when_called(world: World) -> None:
    token = world.key("write")
    set_rights(world, token, create_note="deny", read_note="deny")
    assert not listed(token) & {"create_note", "read_note"}
    assert failure(call(token, "create_note", folder="Garden", title="x", content="x")) == "No tool called 'create_note'."
    assert failure(call(token, "read_note", path="Garden/Plan.md")) == "No tool called 'read_note'."
    # A tool switched on that is denied by default now runs.
    set_rights(world, token, trash_note="allow")
    assert "trash_note" in listed(token)
    value(call(token, "trash_note", path="Garden/Plan.md"))
    assert not (world.vault / "Garden" / "Plan.md").exists()


def test_rights_are_per_key(world: World) -> None:
    first, second = world.key("write"), world.key("write")
    set_rights(world, first, create_note="deny")
    assert "create_note" not in listed(first)
    assert "create_note" in listed(second)


def test_rights_take_only_known_tools_and_reading_is_never_asked_for(world: World) -> None:
    token = world.key("write")
    where = f"/api/mcp/keys/{key_id(world, token)}/rights"
    assert world.anna.put(where, json={"rights": {"no_such_tool": "allow"}}).status_code == 422
    assert world.anna.put(where, json={"rights": {"read_note": "maybe"}}).status_code == 422
    assert world.anna.put(where, json={"rights": {"read_note": "ask"}}).status_code == 422
    assert world.anna.put(where, json={"rights": {"request_status": "deny"}}).status_code == 422
    # Another account's key answers like a missing one.
    assert world.bob.put(where, json={"rights": {"read_note": "deny"}}).status_code == 404
    # What equals the default is not kept.
    shown = world.anna.put(where, json={"rights": {"create_note": "ask", "trash_note": "deny", "write_note": "allow"}})
    assert shown.json()["rights"] == {"write_note": "allow"}


def test_a_tool_above_the_level_stays_hidden_whatever_the_key_says(world: World) -> None:
    token = world.key("read")
    set_rights(world, token, create_note="allow", trash_note="allow")
    assert not listed(token) & {"create_note", "trash_note", "propose_note"}
    assert "No tool called" in failure(call(token, "create_note", folder="Garden", title="x", content="x"))


def test_the_operator_blocks_tools_for_everybody(world: World) -> None:
    token = world.key("write")
    set_rights(world, token, delete_space="allow", empty_trash="allow", trash_note="allow")
    # Blocked from the start: what cannot be undone.
    assert not listed(token) & {"delete_space", "empty_trash"}
    assert "trash_note" in listed(token)
    assert world.anna.put("/api/mcp/blocked", json={"tools": ["trash_note"]}).status_code == 403
    blocked = world.operator.put("/api/mcp/blocked", json={"tools": ["trash_note", "create_note"]})
    assert blocked.status_code == 200 and blocked.json()["blocked"] == ["create_note", "trash_note"]
    assert not listed(token) & {"trash_note", "create_note"}
    assert "delete_space" in listed(token)
    assert "No tool called" in failure(call(token, "trash_note", path="Garden/Plan.md"))
    assert world.operator.put("/api/mcp/blocked", json={"tools": ["no_such_tool"]}).status_code == 422


# --- Requests ----------------------------------------------------------------------------------------------------------


def ask_for_a_note(world: World, token: str, title: str = "Seeds") -> int:
    waiting = value(call(token, "create_note", folder="Garden", title=title, content="Beans and peas"))
    return int(waiting["request"])


def test_an_approved_request_runs_exactly_what_was_asked_and_the_key_learns_the_answer(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    shown = world.anna.get("/api/mcp/requests").json()
    assert shown[0]["id"] == number and shown[0]["status"] == "waiting" and shown[0]["tool"] == "create_note"
    assert shown[0]["arguments"] == {"content": "Beans and peas", "folder": "Garden", "title": "Seeds"}
    assert value(call(token, "request_status", request=number))["status"] == "waiting"
    # Whatever else comes with the approval, only the stored arguments run.
    done = world.anna.post(f"/api/mcp/requests/{number}/approve",
                           json={"arguments": {"folder": "Garden", "title": "Other", "content": "x"}})
    assert done.status_code == 200 and done.json()["status"] == "done", done.text
    assert (world.vault / "Garden" / "Seeds.md").read_bytes() == b"Beans and peas"
    assert not (world.vault / "Garden" / "Other.md").exists()
    status = value(call(token, "request_status", request=number))
    assert status["status"] == "done" and status["result"]["path"] == "Garden/Seeds.md"
    # Decided once: a second approval changes nothing.
    assert world.anna.post(f"/api/mcp/requests/{number}/approve", json={}).status_code == 409


def test_a_declined_request_does_nothing(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    assert world.anna.post(f"/api/mcp/requests/{number}/decline").json()["status"] == "declined"
    assert not (world.vault / "Garden" / "Seeds.md").exists()
    assert value(call(token, "request_status", request=number))["status"] == "declined"


def test_arguments_changed_after_asking_are_refused(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    with SessionLocal() as db:
        row = db.get(McpRequest, number)
        assert row is not None
        row.arguments = json.dumps({"content": "x", "folder": "Garden", "title": "Changed"})
        db.commit()
    assert world.anna.post(f"/api/mcp/requests/{number}/approve", json={}).status_code == 409
    assert not (world.vault / "Garden" / "Changed.md").exists()


def test_a_request_runs_out_after_a_day(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    with SessionLocal() as db:
        row = db.get(McpRequest, number)
        assert row is not None
        assert row.expires_at - row.created_at == timedelta(hours=24)
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert world.anna.post(f"/api/mcp/requests/{number}/approve", json={}).status_code == 409
    assert value(call(token, "request_status", request=number))["status"] == "expired"
    assert not (world.vault / "Garden" / "Seeds.md").exists()


def test_approval_checks_again_what_the_key_may_do_now(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    set_rights(world, token, create_note="deny")
    failed = world.anna.post(f"/api/mcp/requests/{number}/approve", json={})
    assert failed.json()["status"] == "failed"
    assert not (world.vault / "Garden" / "Seeds.md").exists()
    # Blocked by the operator in the meantime: the same.
    set_rights(world, token, create_note="ask")
    second = ask_for_a_note(world, token, "Peas")
    world.operator.put("/api/mcp/blocked", json={"tools": ["create_note"]})
    assert world.anna.post(f"/api/mcp/requests/{second}/approve", json={}).json()["status"] == "failed"
    assert not (world.vault / "Garden" / "Peas.md").exists()


def test_nothing_runs_once_mcp_is_switched_off(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    switch(mcp_allowed=False)
    assert world.anna.post(f"/api/mcp/requests/{number}/approve", json={}).json()["status"] == "failed"
    assert not (world.vault / "Garden" / "Seeds.md").exists()


def test_a_revoked_key_takes_its_requests_along(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    assert world.anna.delete(f"/api/mcp/keys/{key_id(world, token)}").status_code == 204
    assert world.anna.post(f"/api/mcp/requests/{number}/approve", json={}).status_code == 404


def test_only_the_own_account_sees_and_decides_a_request(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    assert world.bob.get("/api/mcp/requests").json() == []
    assert world.bob.post(f"/api/mcp/requests/{number}/approve", json={}).status_code == 404
    assert world.bob.post(f"/api/mcp/requests/{number}/decline").status_code == 404
    # Another key of the same account does not learn about it either.
    other = world.key("write")
    assert failure(call(other, "request_status", request=number)) == "Not found."


def test_always_allow_sets_the_right_and_runs_the_next_call_at_once(world: World) -> None:
    token = world.key("write", ask=True)
    number = ask_for_a_note(world, token)
    assert world.anna.post(f"/api/mcp/requests/{number}/approve", json={"always": True}).json()["status"] == "done"
    made = value(call(token, "create_note", folder="Garden", title="Peas", content="Peas"))
    assert made["path"] == "Garden/Peas.md"


def test_a_request_with_wrong_arguments_is_refused_before_it_waits(world: World) -> None:
    token = world.key("write", ask=True)
    assert "'title' is missing" in failure(call(token, "create_note", folder="Garden", content="x"))
    assert "There is no argument" in failure(call(token, "create_space", name="x", owner="bob"))
    assert world.anna.get("/api/mcp/requests").json() == []


def test_waiting_requests_are_limited(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mcp, "MAX_WAITING", 2)
    token = world.key("write", ask=True)
    ask_for_a_note(world, token, "A")
    ask_for_a_note(world, token, "B")
    assert "requests are waiting already" in failure(call(token, "create_note", folder="Garden", title="C", content="x"))


# --- The tools of block Y ----------------------------------------------------------------------------------------------


def test_a_space_made_over_mcp_is_managed_by_the_account_and_seen_by_a_limited_key(world: World) -> None:
    token = world.key("write")
    made = value(call(token, "create_space", name="Polizei - ZA31", icon="l:shield", color="#38bdf8"))
    assert made == {"space": "Polizei - ZA31", "role": "manage"}
    spaces = {space["name"]: space["role"] for space in world.anna.get("/api/spaces").json()}
    assert spaces["Polizei - ZA31"] == "manage"
    looks = world.anna.get("/api/looks").json()
    assert "Polizei - ZA31" in json.dumps(looks)
    # A key limited to Garden that makes a space may use it afterwards.
    ids = {space["name"]: space["id"] for space in world.anna.get("/api/spaces").json()}
    limited = world.anna.post("/api/mcp/keys", json={"name": "g", "level": "write", "spaces": [ids["Garden"]]}).json()
    set_rights(world, limited["token"], create_space="allow", create_folder="allow")
    value(call(limited["token"], "create_space", name="Kitchen"))
    assert value(call(limited["token"], "create_folder", parent="Kitchen", name="Soups"))["path"] == "Kitchen/Soups"
    assert "Kitchen" in [space["name"] for space in value(call(limited["token"], "list_spaces"))]


def test_folders_and_notes_move_and_their_links_follow(world: World) -> None:
    token = world.key("write")
    (world.vault / "Garden" / "Index.md").write_bytes(b"See [[Plan]].\n")
    index.scan()
    value(call(token, "create_folder", parent="Garden", name="Beds"))
    renamed = value(call(token, "rename_note", path="Garden/Plan.md", title="Spring plan"))
    assert renamed["path"] == "Garden/Spring plan.md"
    assert (world.vault / "Garden" / "Index.md").read_bytes() == b"See [[Spring plan]].\n"
    moved = value(call(token, "move_note", path="Garden/Spring plan.md", into="Garden/Beds"))
    assert moved["path"] == "Garden/Beds/Spring plan.md"
    assert "is a folder" in failure(call(token, "rename_note", path="Garden/Beds", title="x"))
    assert "is a note" in failure(call(token, "rename_folder", path="Garden/Index.md", name="x"))
    assert value(call(token, "rename_folder", path="Garden/Beds", name="Raised beds"))["path"] == "Garden/Raised beds"
    assert "cannot be renamed" in failure(call(token, "rename_folder", path="Garden", name="Yard"))
    # Bob's space answers like a missing one.
    assert failure(call(token, "create_folder", parent="Secret", name="x")) == "Not found."


def test_versions_trash_and_restore(world: World) -> None:
    token = world.key("write")
    set_rights(world, token, trash_note="allow")
    written = value(call(token, "write_note", path="Garden/Plan.md", content="New plan\n", base_hash=plan_hash(world)))
    assert written["saved"]
    versions = value(call(token, "list_versions", path="Garden/Plan.md"))
    assert len(versions) >= 1
    first = versions[-1]["version"]
    assert value(call(token, "read_version", version=first))["path"] == "Garden/Plan.md"
    value(call(token, "trash_note", path="Garden/Plan.md"))
    entries = value(call(token, "list_trash"))
    assert [entry["path"] for entry in entries] == ["Garden/Plan.md"]
    value(call(token, "restore_from_trash", entry=entries[0]["entry"]))
    assert (world.vault / "Garden" / "Plan.md").exists()
    assert failure(call(token, "read_version", version=987654)) == "Not found."


def test_comments_round_trip(world: World) -> None:
    token = world.key("write")
    made = value(call(token, "add_comment", path="Garden/Plan.md", quote="Second line", body="Shorter?"))
    thread = made["id"]
    value(call(token, "reply_comment", path="Garden/Plan.md", thread=thread, body="Yes."))
    threads = value(call(token, "read_comments", path="Garden/Plan.md"))["threads"]
    assert threads[0]["id"] == thread and len(threads[0]["comments"]) == 2
    value(call(token, "resolve_comment", path="Garden/Plan.md", thread=thread))
    assert value(call(token, "read_comments", path="Garden/Plan.md"))["threads"][0]["resolved"]


def test_members_need_the_manage_right_and_never_operator_powers(world: World) -> None:
    operator_key = world.key("write", who=world.operator)
    set_rights_of = world.operator.put(
        f"/api/mcp/keys/{key_id(world, operator_key)}/rights",
        json={"rights": {"set_member_role": "allow", "invite_member": "allow", "remove_member": "allow"}},
    )
    assert set_rights_of.status_code == 200
    # In the interface the operator may change members of Garden; over MCP it may not even read the space.
    assert failure(call(operator_key, "set_member_role", space="Garden", person="bob", role="read")) == "Not found."
    assert failure(call(operator_key, "list_members", space="Garden")) == "Not found."
    token = world.key("write")
    set_rights(world, token, invite_member="allow", remove_member="allow")
    invited = value(call(token, "invite_member", space="Garden", person="bob", role="read"))
    assert invited["invited"] is True
    person("carl")
    join(world.anna, "Garden", "carl", "read")
    assert {member["name"] for member in value(call(token, "list_members", space="Garden"))} >= {"anna", "carl"}
    value(call(token, "remove_member", space="Garden", person="carl"))
    assert "carl" not in {member["name"] for member in value(call(token, "list_members", space="Garden"))}


def test_an_attachment_goes_up_as_base64_with_the_limits_of_the_interface(world: World) -> None:
    token = world.key("write")
    data = base64.b64encode(b"%PDF-1.4 a made-up pdf for the test only\n").decode()
    made = value(call(token, "upload_attachment", name="Offer.pdf", data=data, note="Garden/Plan.md"))
    assert made["path"].startswith("Garden/") and made["path"].endswith("Offer.pdf")
    assert "base64" in failure(call(token, "upload_attachment", name="x.pdf", data="not base64!", note="Garden/Plan.md"))
    assert "either" in failure(call(token, "upload_attachment", name="x.pdf", data=data))
    assert failure(call(token, "upload_attachment", name="x.pdf", data=data, folder="Secret")) == "Not found."
    listed_files = value(call(token, "list_attachments", space="Garden"))
    assert any(item["path"] == made["path"] for item in listed_files["items"])


def test_properties_inbox_tags_and_templates(world: World) -> None:
    token = world.key("write")
    value(call(token, "set_property", path="Garden/Plan.md", key="status", value="draft"))
    assert (world.vault / "Garden" / "Plan.md").read_bytes().startswith(b"---")
    value(call(token, "capture_to_inbox", space="Garden", text="Water the beans"))
    inbox = [p for p in (world.vault / "Garden").iterdir() if p.name in ("Inbox.md", "Eingang.md")]
    assert inbox and b"Water the beans" in inbox[0].read_bytes()
    (world.vault / "Garden" / "Templates").mkdir(exist_ok=True)
    (world.vault / "Garden" / "Templates" / "Day.md").write_bytes(b"# {{title}}\n")
    (world.vault / "Garden" / "Tags.md").write_bytes(b"#beans and #peas\n")
    index.scan()
    assert [t["path"] for t in value(call(token, "list_templates", space="Garden"))] == ["Garden/Templates/Day.md"]
    made = value(call(token, "create_from_template", folder="Garden", title="Monday", template="Garden/Templates/Day.md"))
    assert (world.vault / made["path"]).read_bytes() == b"# Monday\n"
    renamed = value(call(token, "rename_tag", old="beans", new="greens"))
    assert renamed["changed"] == 1
    assert b"#greens" in (world.vault / "Garden" / "Tags.md").read_bytes()


def sources_of(path: str) -> list[tuple[str, str]]:
    """Source and author of each version of a note, oldest first."""
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == path, File.deleted_at.is_(None)))
        return [(row.source, row.author) for row in
                db.scalars(select(Version).where(Version.file_id == file_id).order_by(Version.id))]


def test_every_note_a_tool_writes_is_a_version_with_the_source_mcp(world: World) -> None:
    """The tools that go through the routes of the interface write as the AI, not as the interface (``app``)."""
    token = world.key("write")
    (world.vault / "Garden" / "Templates").mkdir(exist_ok=True)
    (world.vault / "Garden" / "Templates" / "Day.md").write_bytes(b"# {{title}}\n")
    (world.vault / "Garden" / "Extra.md").write_bytes(b"# Extra\n\nMore to plant.\n")
    (world.vault / "Garden" / "Mention.md").write_bytes(b"# Mention\n\nSee the Plan for spring.\n")
    index.scan()
    mcp_by_anna = (index.MCP, "anna")

    value(call(token, "set_property", path="Garden/Plan.md", key="status", value="draft"))
    assert sources_of("Garden/Plan.md")[-1] == mcp_by_anna
    inbox = value(call(token, "capture_to_inbox", space="Garden", text="Water the beans"))["path"]
    value(call(token, "capture_to_inbox", space="Garden", text="Buy seeds"))
    assert sources_of(inbox) == [mcp_by_anna, mcp_by_anna]
    made = value(call(token, "create_from_template", folder="Garden", title="Monday", template="Garden/Templates/Day.md"))
    assert sources_of(made["path"]) == [mcp_by_anna]
    value(call(token, "merge_notes", source="Garden/Extra.md", target="Garden/Plan.md"))
    assert b"More to plant." in (world.vault / "Garden" / "Plan.md").read_bytes()
    assert sources_of("Garden/Plan.md")[-1] == mcp_by_anna
    place = next(p for p in value(call(token, "unlinked_mentions", path="Garden/Plan.md"))["places"]
                 if p["path"] == "Garden/Mention.md")
    value(call(token, "link_mention", source=place["path"], target="Garden/Plan.md", line=place["line"],
               column=place["column"], words=place["words"]))
    assert b"[[Plan]]" in (world.vault / "Garden" / "Mention.md").read_bytes()
    assert sources_of("Garden/Mention.md")[-1] == mcp_by_anna

    # The interface itself still writes as the interface.
    note = world.anna.get("/api/note", params={"path": "Garden/Mention.md"}).json()
    saved = world.anna.put("/api/note", json={"path": "Garden/Mention.md", "content": note["content"] + "More.\n",
                                              "base_hash": note["hash"]})
    assert saved.status_code == 200, saved.text
    assert sources_of("Garden/Mention.md")[-1] == (index.APP, "anna")
    linked = world.anna.post("/api/inbox", json={"space": "Garden", "text": "by hand", "stamp": "2026-10-02 08:00"})
    assert linked.status_code == 200, linked.text
    assert sources_of(inbox)[-1] == (index.APP, "anna")


def test_a_source_asked_for_wins_over_the_actors_own() -> None:
    from app.services.vault import Actor

    ai = Actor(name="anna", client="mcp-1-abcd", source=index.MCP)
    assert (ai.writes_as(), ai.writes_as(index.RESTORE)) == (index.MCP, index.RESTORE)
    assert Actor(name="anna", client="tab-anna0000").writes_as() == index.APP
