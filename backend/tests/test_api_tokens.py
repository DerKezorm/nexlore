"""API tokens and ``/api/v1`` for programs such as n8n and nexdeck: tokens per account, the walls in front, reading,
writing without ever deleting, the operator's switch and block, the warning before a token runs out.

The world: the operator ``tester`` has switched API tokens on. ``anna`` manages ``Garden`` and reads ``Shared`` (a
space of bob's); ``Secret`` is bob's alone. Every route must treat Secret like a space that does not exist.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, ApiToken, File, Version, utcnow
from app.services import apitokens, index, logs, notify

from .conftest import join
from .test_mcp import person, switch
from .test_notify import HOOK, Sent, hooked

TODAY = "2026-10-02"
PLAN = (
    "# Plan\r\n\r\nSee [[Beans]].\r\n\r\n- [ ] Water the beans 📅 2026-10-02\r\n- [ ] Dig the bed 📅 2026-09-20\r\n"
    "- [ ] Buy seeds 📅 2026-10-05\r\n"
)


class World:
    def __init__(self, operator: TestClient, vault: Path) -> None:
        self.operator = operator
        self.vault = vault
        self.anna = person("anna")
        self.bob = person("bob")
        for owner, name in ((self.anna, "Garden"), (self.bob, "Secret"), (self.bob, "Shared")):
            assert owner.post("/api/spaces", json={"name": name}).status_code == 201
        join(self.bob, "Shared", "anna", "read")
        (vault / "Garden" / "Plan.md").write_bytes(PLAN.encode())
        (vault / "Garden" / "Beans.md").write_bytes(b"# Beans\n\nBack to [[Plan]]. zucchini later\n")
        (vault / "Garden" / "Templates").mkdir()
        (vault / "Garden" / "Templates" / "Meeting.md").write_bytes(b"# {{title}}\n\nOn {{date}}\n")
        (vault / "Secret" / "Diary.md").write_bytes(b"# Diary\n\nzucchini, nothing for anna\n- [ ] Hidden 2026-10-02\n")
        (vault / "Shared" / "Rules.md").write_bytes(b"# Rules\n\nRead only for anna.\n")
        index.scan()
        switch(api_tokens_allowed=True)

    def token(self, level: str = "read", who: TestClient | None = None, **extra: Any) -> str:
        made = (who or self.anna).post("/api/api-tokens", json={"name": f"n8n {level}", "level": level, **extra})
        assert made.status_code == 201, made.text
        return made.json()["secret"]

    def space_id(self, name: str) -> int:
        spaces = self.bob.get("/api/spaces").json() + self.anna.get("/api/spaces").json()
        return next(space["id"] for space in spaces if space["name"] == name)


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> Sent:
    return Sent(monkeypatch)


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    return World(client, vault)


def api(token: str | None, method: str, url: str, *, headers: dict | None = None, **sent: Any) -> Any:
    """A program: no cookie, no tab, only its token."""
    program = TestClient(app, base_url="http://testserver")
    given = {"Authorization": f"Bearer {token}"} if token else {}
    return program.request(method, url, headers=given | (headers or {}), **sent)


def ok(answer: Any, status: int = 200) -> Any:
    assert answer.status_code == status, answer.text
    return answer.json() if answer.content else None


def code(answer: Any) -> tuple[int, str]:
    return answer.status_code, answer.json()["detail"]["code"]


def newest_source(path: str) -> tuple[str, str]:
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == path, File.deleted_at.is_(None)))
        row = db.scalars(select(Version).where(Version.file_id == file_id).order_by(Version.id.desc())).first()
        assert row is not None
        return row.source, row.author


# --- Tokens through the interface --------------------------------------------------------------------------------------


def test_closed_until_the_operator_opens_it(client: TestClient, account: object) -> None:
    anna = person("anna")
    assert ok(anna.get("/api/api-tokens")) == {"allowed": False, "tokens": []}
    assert code(anna.post("/api/api-tokens", json={"name": "n8n", "level": "read"})) == (403, "api_off")
    assert ok(client.get("/api/settings"))["api_tokens_allowed"] is False
    assert ok(client.put("/api/settings", json={"api_tokens_allowed": True}))["api_tokens_allowed"] is True
    assert ok(client.get("/api/settings"))["api_tokens_allowed"] is True
    assert ok(anna.get("/api/api-tokens"))["allowed"] is True
    secret = ok(anna.post("/api/api-tokens", json={"name": "n8n", "level": "read"}), 201)["secret"]
    assert ok(api(secret, "GET", "/api/v1/me"))["account"] == "anna"
    # Switched off again: every token answers 401 and stays, working again when switched on.
    ok(client.put("/api/settings", json={"api_tokens_allowed": False}))
    assert code(api(secret, "GET", "/api/v1/me")) == (401, "api_off")
    assert len(ok(anna.get("/api/api-tokens"))["tokens"]) == 1
    ok(client.put("/api/settings", json={"api_tokens_allowed": True}))
    assert api(secret, "GET", "/api/v1/me").status_code == 200


def test_a_token_is_shown_once_and_only_its_hash_is_kept(world: World) -> None:
    made = ok(world.anna.post("/api/api-tokens", json={"name": "nexdeck", "level": "write"}), 201)
    secret = made["secret"]
    assert secret.startswith("nxa_") and len(secret) >= 40
    assert made["token"]["prefix"] == secret[:8] and made["token"]["level"] == "write"
    listed = ok(world.anna.get("/api/api-tokens"))["tokens"]
    assert secret not in str(listed) and listed[0]["name"] == "nexdeck" and listed[0]["expires_at"] is None
    with SessionLocal() as db:
        row = db.scalars(select(ApiToken)).one()
        assert row.token_hash == apitokens.digest(secret) and secret not in str(vars(row))


def test_what_a_token_may_be_made_with(world: World) -> None:
    def make(**body: Any) -> Any:
        return world.anna.post("/api/api-tokens", json={"name": "x", "level": "read", **body})

    assert make(level="draft").status_code == 422
    assert code(make(days=7)) == (422, "invalid_input")
    # Spaces it may not read are refused like ones that do not exist.
    assert code(make(spaces=[world.space_id("Secret")])) == (422, "invalid_input")
    assert code(make(spaces=[])) == (422, "invalid_input")
    made = ok(make(spaces=[world.space_id("Garden")], days=30), 201)["token"]
    assert made["spaces"] == ["Garden"]
    with SessionLocal() as db:
        row = db.get(ApiToken, made["id"])
        assert row is not None and row.expires_at is not None
        assert timedelta(days=29, hours=23) < row.expires_at - row.created_at <= timedelta(days=30)
    for _ in range(19):
        ok(make(), 201)
    assert code(make()) == (409, "too_many_tokens")


def test_only_the_own_tokens_and_never_with_a_token(world: World) -> None:
    secret = world.token("write")
    own = ok(world.anna.get("/api/api-tokens"))["tokens"][0]["id"]
    assert ok(world.bob.get("/api/api-tokens"))["tokens"] == []
    assert world.bob.delete(f"/api/api-tokens/{own}").status_code == 404
    # A token makes, lists and deletes no tokens: those routes want a session.
    assert api(secret, "GET", "/api/api-tokens").status_code == 401
    assert api(secret, "POST", "/api/api-tokens", json={"name": "more", "level": "write"},
               headers={"X-Nexlore-Client": "tab-program"}).status_code == 401
    assert world.anna.delete(f"/api/api-tokens/{own}").status_code == 204
    assert code(api(secret, "GET", "/api/v1/me")) == (401, "token_invalid")


def test_the_operator_sees_every_token_and_blocks_one_for_good(world: World) -> None:
    secret = world.token("write", spaces=[world.space_id("Garden")])
    other = world.token("read", world.bob)
    assert world.anna.get("/api/admin/api-tokens").status_code == 403
    every = ok(world.operator.get("/api/admin/api-tokens"))
    assert {(row["account"], row["level"], row["spaces"]) for row in every} == {("anna", "write", 1), ("bob", "read", None)}
    assert secret not in str(every) and other not in str(every)
    annas = next(row["id"] for row in every if row["account"] == "anna")
    assert world.anna.post(f"/api/admin/api-tokens/{annas}/block").status_code == 403
    assert ok(world.operator.post(f"/api/admin/api-tokens/{annas}/block"))["blocked"] is True
    assert code(api(secret, "GET", "/api/v1/me")) == (401, "token_invalid")
    assert ok(world.anna.get("/api/api-tokens"))["tokens"][0]["blocked"] is True
    assert api(other, "GET", "/api/v1/me").status_code == 200
    assert world.operator.post("/api/admin/api-tokens/999/block").status_code == 404


# --- The walls ---------------------------------------------------------------------------------------------------------


def test_the_walls_in_front(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    secret = world.token()
    assert code(api(None, "GET", "/api/v1/me")) == (401, "token_invalid")
    assert code(api("nxa_" + "q" * 43, "GET", "/api/v1/me")) == (401, "token_invalid")
    assert code(api(secret, "GET", "/api/v1/me", headers={"Origin": "https://evil.example.com"})) == (403, "origin_refused")
    # The session cookie counts for nothing here.
    assert code(world.anna.get("/api/v1/me")) == (401, "token_invalid")
    monkeypatch.setattr(apitokens, "PER_MINUTE", 3)
    for _ in range(3):
        ok(api(secret, "GET", "/api/v1/me"))
    answer = api(secret, "GET", "/api/v1/me")
    assert code(answer) == (429, "slow_down") and answer.headers["retry-after"] == "60"


def test_a_token_that_ran_out_or_whose_account_is_locked_answers_like_none(world: World) -> None:
    secret = world.token()
    with SessionLocal() as db:
        row = db.scalars(select(ApiToken)).one()
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert code(api(secret, "GET", "/api/v1/me")) == (401, "token_invalid")
    other = world.token()
    with SessionLocal() as db:
        anna = db.scalars(select(Account).where(Account.name == "anna")).one()
        anna.locked_until = utcnow() + timedelta(minutes=5)
        db.commit()
    assert code(api(other, "GET", "/api/v1/me")) == (401, "token_invalid")


def test_programs_need_no_tab_and_the_interface_still_does(world: World) -> None:
    secret = world.token("write")
    ok(api(secret, "POST", "/api/v1/inbox", json={"space": "Garden", "text": "a thought"}))
    tabless = TestClient(app, base_url="http://testserver")
    tabless.cookies = world.anna.cookies
    assert code(tabless.post("/api/inbox", json={"space": "Garden", "text": "x", "stamp": "2026-10-02 07:00"})) == (
        400, "client_required")


def test_use_is_noted_and_the_token_never_reaches_the_log(world: World, caplog: pytest.LogCaptureFixture) -> None:
    secret = world.token()
    assert ok(world.anna.get("/api/api-tokens"))["tokens"][0]["last_used_at"] is None
    ok(api(secret, "GET", "/api/v1/me"))
    assert ok(world.anna.get("/api/api-tokens"))["tokens"][0]["last_used_at"] is not None
    assert logs.redact(f"Authorization: Bearer {secret}") == "Authorization: Bearer nxa_…"
    with caplog.at_level(logging.INFO):
        made = world.token("write")
        ok(api(made, "GET", "/api/v1/me"))
    assert "API token made" in caplog.text and made not in caplog.text and made[4:] not in caplog.text


# --- Reading -----------------------------------------------------------------------------------------------------------


def test_me_and_the_spaces_a_token_sees(world: World) -> None:
    every = world.token()
    me = ok(api(every, "GET", "/api/v1/me"))
    assert (me["account"], me["level"], me["spaces"], me["expires_at"]) == ("anna", "read", None, None)
    names = {space["name"]: space["role"] for space in ok(api(every, "GET", "/api/v1/spaces"))}
    assert names == {"Garden": "manage", "Shared": "read"}
    limited = world.token(spaces=[world.space_id("Shared")])
    assert ok(api(limited, "GET", "/api/v1/me"))["spaces"] == ["Shared"]
    assert [space["name"] for space in ok(api(limited, "GET", "/api/v1/spaces"))] == ["Shared"]
    # Outside its spaces a token finds nothing, exactly as in a space its account may not read.
    for token, path in ((limited, "Garden/Plan.md"), (every, "Secret/Diary.md"), (every, "Garden/Nothing.md")):
        assert code(api(token, "GET", "/api/v1/note", params={"path": path})) == (404, "not_found")


def test_folder_note_and_links(world: World) -> None:
    token = world.token()
    folder = ok(api(token, "GET", "/api/v1/folder", params={"path": "Garden"}))
    assert [f["name"] for f in folder["folders"]] == ["Templates"]
    assert [f["name"] for f in folder["files"]] == ["Beans.md", "Plan.md"] and folder["total_files"] == 2
    page = ok(api(token, "GET", "/api/v1/folder", params={"path": "Garden", "offset": 1, "limit": 1}))
    assert [f["name"] for f in page["files"]] == ["Plan.md"]
    note = ok(api(token, "GET", "/api/v1/note", params={"path": "Garden/Plan.md"}))
    assert note["content"] == PLAN and note["hash"] == index.digest(PLAN.encode()) and note["readonly"] is False
    links = ok(api(token, "GET", "/api/v1/links", params={"path": "Garden/Beans.md"}))
    assert [o["path"] for o in links["outgoing"]] == ["Garden/Plan.md"]
    assert [b["path"] for b in links["backlinks"]] == ["Garden/Plan.md"]


def test_search_with_operators_and_without_marks(world: World) -> None:
    token = world.token()
    found = ok(api(token, "GET", "/api/v1/search", params={"q": "zucchini"}))
    assert [n["path"] for n in found["notes"]] == ["Garden/Beans.md"]
    line = found["notes"][0]["lines"][0]["text"]
    assert "zucchini" in line and "\x02" not in line and "\x03" not in line
    assert [n["path"] for n in ok(api(token, "GET", "/api/v1/search", params={"q": "path:Shared read"}))["notes"]] == [
        "Shared/Rules.md"]


def test_recent_and_templates(world: World) -> None:
    token = world.token()
    (world.vault / "Garden" / "Beans.md").write_bytes(b"# Beans\n\nchanged now\n")
    index.scan()
    recent = ok(api(token, "GET", "/api/v1/recent", params={"limit": 2}))
    assert recent[0]["path"] == "Garden/Beans.md" and len(recent) == 2
    assert all(not row["path"].startswith("Secret/") for row in ok(api(token, "GET", "/api/v1/recent")))
    assert [r["path"] for r in ok(api(token, "GET", "/api/v1/recent", params={"space": "Shared"}))] == ["Shared/Rules.md"]
    assert code(api(token, "GET", "/api/v1/recent", params={"space": "Secret"})) == (404, "not_found")
    assert [t["path"] for t in ok(api(token, "GET", "/api/v1/templates", params={"space": "Garden"}))] == [
        "Garden/Templates/Meeting.md"]
    assert code(api(token, "GET", "/api/v1/templates", params={"space": "Secret"})) == (404, "not_found")


def test_tasks_and_the_dashboard(world: World) -> None:
    token = world.token()
    due = ok(api(token, "GET", "/api/v1/tasks", params={"today": TODAY, "when": "today"}))
    assert [t["text"] for t in due["items"]] == ["Water the beans"]
    assert (due["counts"]["open"], due["counts"]["overdue"], due["counts"]["today"]) == (3, 1, 1)
    assert due["items"][0]["raw"].startswith("- [ ] Water") and due["items"][0]["file_hash"]
    numbers = ok(api(token, "GET", "/api/v1/dashboard", params={"today": TODAY}))
    assert numbers == {"spaces": 2, "notes": 4, "tasks_open": 3, "tasks_overdue": 1, "tasks_today": 1,
                       "tasks_week": 1, "inbox": 0}
    writer = world.token("write")
    for words in ("first thought", "[ ] call the plumber"):
        ok(api(writer, "POST", "/api/v1/inbox", json={"space": "Garden", "text": words,
                                                       "now": "2026-10-02T07:30:00+02:00"}))
    numbers = ok(api(token, "GET", "/api/v1/dashboard", params={"today": TODAY, "space": "Garden"}))
    assert (numbers["spaces"], numbers["inbox"], numbers["tasks_open"]) == (1, 2, 4)
    assert code(api(token, "GET", "/api/v1/dashboard", params={"space": "Secret"})) == (404, "not_found")


# --- Writing -----------------------------------------------------------------------------------------------------------


WRITES = [
    ("POST", "/api/v1/notes", {"folder": "Garden", "title": "New", "content": "x"}),
    ("PUT", "/api/v1/note", {"path": "Garden/Plan.md", "content": "x", "base_hash": "0" * 64}),
    ("POST", "/api/v1/note/append", {"path": "Garden/Plan.md", "text": "x"}),
    ("POST", "/api/v1/daily", {"space": "Garden"}),
    ("POST", "/api/v1/inbox", {"space": "Garden", "text": "x"}),
    ("POST", "/api/v1/tasks/complete", {"path": "Garden/Plan.md", "line": 5, "raw": "x"}),
]


@pytest.mark.parametrize(("method", "url", "body"), WRITES)
def test_a_reading_token_writes_nothing(world: World, method: str, url: str, body: dict) -> None:
    before = (world.vault / "Garden" / "Plan.md").read_bytes()
    assert code(api(world.token(), method, url, json=body)) == (403, "read_only_token")
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == before
    assert not (world.vault / "Garden" / "New.md").exists()


def test_nothing_is_deleted_moved_or_renamed(world: World) -> None:
    token = world.token("write")
    for method, url in (("DELETE", "/api/v1/note"), ("DELETE", "/api/v1/files"), ("POST", "/api/v1/move"),
                        ("POST", "/api/v1/spaces/Garden/rename")):
        assert api(token, method, url, params={"path": "Garden/Plan.md"}).status_code in (404, 405)
    assert (world.vault / "Garden" / "Plan.md").exists()


def test_make_a_note_also_from_a_template(world: World) -> None:
    token = world.token("write")
    made = ok(api(token, "POST", "/api/v1/notes", json={"folder": "Garden", "title": "Idea", "content": "# Idea\n"}),
              201)
    assert made["path"] == "Garden/Idea.md" and (world.vault / "Garden" / "Idea.md").read_bytes() == b"# Idea\n"
    assert newest_source("Garden/Idea.md") == (index.API, "anna")
    meeting = ok(api(token, "POST", "/api/v1/notes", json={
        "folder": "Garden", "title": "Monday", "template": "Garden/Templates/Meeting.md",
        "now": "2026-10-05T09:00:00+02:00"}), 201)
    assert meeting["content"] == "# Monday\n\nOn 2026-10-05\n"
    # A template from another space, and a space only read: refused.
    assert api(token, "POST", "/api/v1/notes", json={"folder": "Garden", "title": "X",
                                                      "template": "Shared/Rules.md"}).status_code == 404
    assert code(api(token, "POST", "/api/v1/notes", json={"folder": "Shared", "title": "X"}))[0] == 403
    assert code(api(token, "POST", "/api/v1/notes", json={"folder": "Secret", "title": "X"})) == (404, "not_found")


def test_replace_keeps_unchanged_lines_and_makes_a_conflict_copy(world: World) -> None:
    token = world.token("write")
    read = ok(api(token, "GET", "/api/v1/note", params={"path": "Garden/Plan.md"}))
    changed = read["content"].replace("\r\n", "\n").replace("See [[Beans]].", "See [[Beans]] soon.")
    saved = ok(api(token, "PUT", "/api/v1/note", json={"path": "Garden/Plan.md", "content": changed,
                                                        "base_hash": read["hash"]}))
    on_disk = (world.vault / "Garden" / "Plan.md").read_bytes()
    assert saved["saved"] is True and saved["conflict"] is None and saved["hash"] == index.digest(on_disk)
    # The note's own line ends stay (CRLF), only the changed line is new.
    assert on_disk == PLAN.replace("See [[Beans]].", "See [[Beans]] soon.").encode()
    assert newest_source("Garden/Plan.md") == (index.API, "anna")
    # Written against the old state: the text goes into a conflict copy, the note stays.
    stale = ok(api(token, "PUT", "/api/v1/note", json={"path": "Garden/Plan.md", "content": "# Other\n",
                                                        "base_hash": read["hash"]}))
    assert stale["saved"] is False and stale["conflict"] and (world.vault / stale["conflict"]).exists()
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == on_disk
    # A state nexlore no longer keeps: a conflict copy too (review before 1.0.0: it was refused, the text lost).
    unknown = ok(api(token, "PUT", "/api/v1/note", json={"path": "Garden/Plan.md", "content": "x",
                                                          "base_hash": "a" * 64}))
    assert unknown["saved"] is False and (world.vault / unknown["conflict"]).read_bytes() == b"x"


def test_a_note_somebody_edits_is_not_written_over(world: World) -> None:
    token = world.token("write")
    read = ok(api(token, "GET", "/api/v1/note", params={"path": "Garden/Plan.md"}))
    assert world.anna.post("/api/locks", json={"path": "Garden/Plan.md"}).status_code == 200
    saved = ok(api(token, "PUT", "/api/v1/note", json={"path": "Garden/Plan.md", "content": "# Mine\n",
                                                        "base_hash": read["hash"]}))
    assert saved["saved"] is False and saved["conflict"]
    assert (world.vault / "Garden" / "Plan.md").read_bytes() == PLAN.encode()
    assert code(api(token, "POST", "/api/v1/note/append", json={"path": "Garden/Plan.md", "text": "more"})) == (
        409, "note_locked")


def test_append_daily_and_inbox(world: World) -> None:
    token = world.token("write")
    ok(api(token, "POST", "/api/v1/note/append", json={"path": "Garden/Beans.md", "text": "From n8n."}))
    assert (world.vault / "Garden" / "Beans.md").read_bytes().endswith(b"zucchini later\n\nFrom n8n.\n")
    assert newest_source("Garden/Beans.md") == (index.API, "anna")
    daily = ok(api(token, "POST", "/api/v1/daily", json={"space": "Garden", "text": "Rain all day.",
                                                          "now": "2026-10-02T23:30:00+02:00"}))
    assert daily == {"path": "Garden/Daily/2026-10-02.md", "created": True}
    assert (world.vault / "Garden" / "Daily" / "2026-10-02.md").read_bytes().endswith(b"Rain all day.\n")
    assert newest_source("Garden/Daily/2026-10-02.md") == (index.API, "anna")
    again = ok(api(token, "POST", "/api/v1/daily", json={"space": "Garden", "date": "2026-10-02"}))
    assert again["created"] is False
    # Made without text: the version of its making names the program; the day is the program's, not the server's.
    made = ok(api(token, "POST", "/api/v1/daily", json={"space": "Garden", "now": "2031-12-24T09:00:00+01:00"}))
    assert made == {"path": "Garden/Daily/2031-12-24.md", "created": True}
    assert newest_source("Garden/Daily/2031-12-24.md") == (index.API, "anna")
    # Without a space the inbox of the account's main space; the time as the program gives it.
    put = ok(api(token, "POST", "/api/v1/inbox", json={"text": "[ ] call the plumber",
                                                        "now": "2026-10-02T07:30:00+02:00"}))
    assert put["path"] == "Garden/Inbox.md"
    assert "- [ ] call the plumber (07:30)" in (world.vault / "Garden" / "Inbox.md").read_text(encoding="utf-8")
    assert newest_source("Garden/Inbox.md") == (index.API, "anna")
    ok(api(token, "POST", "/api/v1/inbox", json={"text": "second"}))
    assert newest_source("Garden/Inbox.md") == (index.API, "anna")
    # Another own space comes first by name; the main space chosen under Settings wins over it.
    assert world.anna.post("/api/spaces", json={"name": "Attic"}).status_code == 201
    assert ok(api(token, "POST", "/api/v1/inbox", json={"text": "third"}))["path"] == "Attic/Inbox.md"
    assert world.anna.put("/api/me/appearance", json={"home_space": "Garden"}).status_code == 200
    assert ok(api(token, "POST", "/api/v1/inbox", json={"text": "fourth"}))["path"] == "Garden/Inbox.md"
    # A main space the account only reads is passed over.
    assert world.anna.put("/api/me/appearance", json={"home_space": "Shared"}).status_code == 200
    assert ok(api(token, "POST", "/api/v1/inbox", json={"text": "fifth"}))["path"] == "Attic/Inbox.md"
    assert code(api(token, "POST", "/api/v1/inbox", json={"space": "Garden/Templates", "text": "x"}))[0] == 404


def test_tick_a_task_off(world: World) -> None:
    token = world.token("write")
    task = ok(api(token, "GET", "/api/v1/tasks", params={"today": TODAY, "when": "today"}))["items"][0]
    done = ok(api(token, "POST", "/api/v1/tasks/complete", json={
        "path": task["path"], "line": task["line"], "raw": task["raw"], "hash": task["file_hash"], "today": TODAY}))
    assert done["raw"].startswith("- [x] Water the beans") and "✅ 2026-10-02" in done["raw"]
    assert newest_source("Garden/Plan.md") == (index.API, "anna")
    assert ok(api(token, "GET", "/api/v1/tasks", params={"today": TODAY, "when": "today"}))["items"] == []
    # The same line twice since the list: with the hash of then, nothing is guessed at.
    task = ok(api(token, "GET", "/api/v1/tasks", params={"today": TODAY, "when": "week"}))["items"][0]
    plan = world.vault / "Garden" / "Plan.md"
    plan.write_bytes(plan.read_bytes() + task["raw"].encode() + b"\r\n")
    index.scan()
    assert code(api(token, "POST", "/api/v1/tasks/complete", json={
        "path": task["path"], "line": task["line"], "raw": task["raw"], "hash": task["file_hash"],
        "today": TODAY})) == (409, "task_changed")
    assert api(token, "POST", "/api/v1/tasks/complete", json={
        "path": "Secret/Diary.md", "line": 4, "raw": "- [ ] Hidden 2026-10-02"}).status_code == 404


# --- Running out -------------------------------------------------------------------------------------------------------


def test_a_week_before_the_end_the_account_hears_once(world: World, sent: Sent) -> None:
    hooked(world.anna)
    world.token(days=30)
    soon = world.token()
    gone = world.token()
    with SessionLocal() as db:
        rows = {row.id: row for row in db.scalars(select(ApiToken).order_by(ApiToken.id))}
        ids = sorted(rows)
        rows[ids[1]].expires_at = utcnow() + timedelta(days=6)
        rows[ids[1]].name = "soon"
        rows[ids[2]].expires_at = utcnow() + timedelta(days=6)
        rows[ids[2]].blocked_at = utcnow()
        db.commit()
    assert soon and gone
    assert notify.tokens_expiring() == 1
    assert len(sent.posts) == 1
    url, body = sent.posts[0]
    assert url == HOOK and body["event"] == "tokens" and "soon" in body["title"]
    assert notify.tokens_expiring() == 0 and len(sent.posts) == 1
    listed = {row["name"]: row for row in ok(world.anna.get("/api/api-tokens"))["tokens"]}
    assert listed["soon"]["expires_at"] is not None


def test_the_warning_can_be_switched_off(world: World, sent: Sent) -> None:
    hooked(world.anna, tokens=False)
    world.token(days=30)
    with SessionLocal() as db:
        row = db.scalars(select(ApiToken)).one()
        row.expires_at = utcnow() + timedelta(days=2)
        db.commit()
    assert notify.tokens_expiring() == 1
    assert sent.posts == []
    assert ok(world.anna.get("/api/me/notify"))["choices"]["tokens"] is False
