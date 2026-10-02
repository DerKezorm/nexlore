"""Notifications (block Z2): occasions per account, a webhook that is always open, mail only with the operator's
server, and what sets them off: @ names and answers, invitations, AI requests, the tasks of the morning, the operator's
troubles. No test sends anything out: the webhook and the mail server are stand-ins here.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account
from app.services import index, mailer, notify, settings_service, updates

from .conftest import join
from .test_mcp import call, switch, value
from .test_profile import person

HOOK = "https://hooks.example.com/nexlore/secret-token"


class Sent:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []
        self.mails: list[Any] = []
        self.status = 200
        self.fail = False

        def post(url: str, body: dict[str, Any]) -> int:
            if self.fail:
                raise OSError("no network")
            self.posts.append((url, body))
            return self.status

        def mail(_db: Any, message: Any) -> None:
            self.mails.append(message)

        monkeypatch.setattr(notify, "_post", post)
        monkeypatch.setattr(mailer, "_send", mail)

    def titles(self) -> list[str]:
        return [body["title"] for _, body in self.posts]


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> Sent:
    return Sent(monkeypatch)


def hooked(who: TestClient, **choices: Any) -> None:
    answer = who.put("/api/me/notify", json={"webhook": HOOK, "choices": choices or None})
    assert answer.status_code == 200, answer.text


# --- Settings ----------------------------------------------------------------------------------------------------------


def test_choices_have_defaults_and_are_checked(client: TestClient, account: Account) -> None:
    anna = person("anna")
    shown = anna.get("/api/me/notify").json()
    assert shown["choices"] == {"email": False, "mention": True, "invite": True, "approval": True, "tasks": False,
                                "tasks_time": "07:00", "operator": True, "tokens": True}
    assert shown["webhook"] == {"set": False, "host": ""} and shown["operator"] is False
    saved = anna.put("/api/me/notify", json={"choices": {"tasks": True, "tasks_time": "06:45"}}).json()
    assert saved["choices"]["tasks"] is True and saved["choices"]["tasks_time"] == "06:45"
    for wrong in ({"tasks_time": "25:00"}, {"tasks_time": "7:00"}, {"tasks_time": "07:000"}, {"tasks_time": "07:5"},
                  {"loud": True}, {"mention": "yes"}):
        assert anna.put("/api/me/notify", json={"choices": wrong}).status_code == 422, wrong


def test_the_webhook_is_kept_encrypted_and_shown_only_by_its_host(client: TestClient, account: Account) -> None:
    anna = person("anna")
    shown = anna.put("/api/me/notify", json={"webhook": HOOK}).json()
    assert shown["webhook"] == {"set": True, "host": "hooks.example.com"}
    assert "secret-token" not in str(anna.get("/api/me/notify").json())
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="anna").one()
        assert row.notify_webhook_enc and "secret-token" not in row.notify_webhook_enc
    for wrong in ("ftp://hooks.example.com/x", "not an address", "https://", "https://exa mple.com/x"):
        assert anna.put("/api/me/notify", json={"webhook": wrong}).status_code == 422, wrong
    assert anna.put("/api/me/notify", json={"webhook": ""}).json()["webhook"] == {"set": False, "host": ""}


def test_the_test_goes_out_at_once_and_says_how_it_went(client: TestClient, account: Account, sent: Sent) -> None:
    anna = person("anna")
    assert anna.post("/api/me/notify/test").status_code == 409
    hooked(anna)
    assert anna.post("/api/me/notify/test").json() == {"webhook": "ok"}
    url, body = sent.posts[-1]
    assert url == HOOK and body["app"] == "nexlore" and body["event"] == "test"
    sent.status = 500
    assert anna.post("/api/me/notify/test").json() == {"webhook": "status 500"}
    sent.fail = True
    assert anna.post("/api/me/notify/test").json() == {"webhook": "unreachable"}


def test_mail_only_with_the_operators_server_and_an_address(client: TestClient, account: Account, sent: Sent) -> None:
    anna = person("anna")
    anna.put("/api/me/notify", json={"choices": {"email": True}})
    with SessionLocal() as db:
        db.query(Account).filter_by(name="anna").one().email = "anna@example.com"
        db.commit()
    # No mail server: no way to send.
    assert anna.get("/api/me/notify").json()["email"]["possible"] is False
    assert anna.post("/api/me/notify/test").status_code == 409
    # With a webhook but still no mail server: the webhook only.
    hooked(anna)
    assert anna.post("/api/me/notify/test").json() == {"webhook": "ok"}
    assert sent.mails == []
    switch(smtp_host="mail.example.com", smtp_from="notes@example.com")
    assert anna.get("/api/me/notify").json()["email"]["possible"] is True
    anna.put("/api/me/notify", json={"webhook": ""})
    assert anna.post("/api/me/notify/test").json() == {"email": "ok"}
    assert sent.mails[-1]["To"] == "anna@example.com"


# --- What sets them off ------------------------------------------------------------------------------------------------


@pytest.fixture
def garden(client: TestClient, account: Account, vault: Path) -> tuple[TestClient, TestClient, TestClient]:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    (vault / "Garden" / "Plan.md").write_bytes(b"# Plan\n\nThe fern needs water.\n")
    index.scan()
    join(anna, "Garden", "bob", "write")
    return anna, bob, carl


def test_a_name_with_at_tells_who_may_read_and_never_the_words(garden: tuple, sent: Sent) -> None:
    anna, bob, carl = garden
    hooked(anna)
    # bob and carl listen too: bob writes the comments, carl may not read Garden.
    for who in (bob, carl):
        assert who.put("/api/me/notify", json={"webhook": HOOK.replace("secret-token", who.get("/api/auth/me").json()["name"])}).status_code == 200
    started = bob.post("/api/comments", json={"path": "Garden/Plan.md", "quote": "fern", "before": "The ",
                                               "after": " needs", "body": "@anna @carl private words here"})
    assert started.status_code == 201
    assert sent.titles() == ["bob names you in a comment on Plan"]
    assert [url for url, _ in sent.posts] == [HOOK]
    assert "private words" not in str(sent.posts)
    assert sent.posts[0][1]["url"] == ""  # no public address set: no link
    # The author hears nothing of their own comment.
    bob.post("/api/comments", json={"path": "Garden/Plan.md", "quote": "water", "before": "needs ", "after": ".",
                                    "body": "@bob note to self"})
    assert len(sent.posts) == 1


def test_an_answer_tells_who_takes_part_in_the_thread(garden: tuple, sent: Sent) -> None:
    anna, bob, _ = garden
    hooked(anna)
    switch(public_url="https://notes.example.com")
    thread = anna.post("/api/comments", json={"path": "Garden/Plan.md", "quote": "fern", "before": "The ",
                                               "after": " needs", "body": "Twice a week?"}).json()["id"]
    assert sent.posts == []
    assert bob.post(f"/api/comments/{thread}/replies", json={"path": "Garden/Plan.md", "body": "Yes."}).status_code == 201
    assert sent.titles() == ["bob answered in a thread on Plan"]
    assert sent.posts[0][1]["url"] == "https://notes.example.com/note/Garden/Plan.md"


def test_occasions_switched_off_stay_silent(garden: tuple, sent: Sent) -> None:
    anna, bob, _ = garden
    hooked(anna, mention=False)
    bob.post("/api/comments", json={"path": "Garden/Plan.md", "quote": "fern", "before": "The ", "after": " needs",
                                    "body": "@anna"})
    assert sent.posts == []


def test_an_invitation_tells_the_invited(client: TestClient, account: Account, sent: Sent) -> None:
    anna, bob = person("anna"), person("bob")
    hooked(bob)
    assert anna.post("/api/spaces", json={"name": "Kitchen"}).status_code == 201
    assert anna.put("/api/spaces/Kitchen/members/bob", json={"role": "read"}).status_code == 202
    assert sent.titles() == ["anna invites you into Kitchen"]


def test_an_ai_request_tells_its_account(garden: tuple, sent: Sent) -> None:
    anna, _, _ = garden
    hooked(anna)
    switch(mcp_allowed=True, mcp_max_level="write")
    token = anna.post("/api/mcp/keys", json={"name": "Agent", "level": "write"}).json()["token"]
    waiting = value(call(token, "create_note", folder="Garden", title="x", content="x"))
    assert waiting["status"] == "waiting"
    assert sent.titles() == ["Agent waits for your approval"]
    assert sent.posts[0][1]["event"] == "approval"


def test_the_tasks_of_the_morning_go_out_once_at_the_chosen_time(garden: tuple, sent: Sent, vault: Path) -> None:
    anna, _, _ = garden
    hooked(anna, tasks=True, tasks_time="07:30")
    today = datetime.now().astimezone().date()
    (vault / "Garden" / "Tasks.md").write_bytes(f"- [ ] Water the fern 📅 {today.isoformat()}\n- [ ] Old 📅 2020-01-01\n".encode())
    index.scan()
    early = datetime.combine(today, datetime.min.time()).replace(hour=7, minute=0).astimezone()
    assert notify.tasks_due(early) == 0
    later = early.replace(hour=8)
    assert notify.tasks_due(later) == 1
    assert sent.titles() == ["1 due today, 1 overdue"]
    assert "Water the fern" in sent.posts[0][1]["message"]
    assert notify.tasks_due(later.replace(hour=9)) == 0


def test_operators_hear_of_the_disk_and_a_new_version_once(client: TestClient, account: Account, sent: Sent,
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    hooked(client)
    anna = person("anna")
    hooked(anna)
    monkeypatch.setattr(notify, "disk_low", lambda: True)
    monkeypatch.setattr(updates, "_ask", lambda: "v99.0.0")
    now = datetime.now().astimezone()
    notify.daily_operator_checks(now)
    assert sorted(sent.titles()) == ["The disk of nexlore runs full", "nexlore 99.0.0 is out"]
    # Only operators, and each only once.
    assert {url for url, _ in sent.posts} == {HOOK}
    assert len(sent.posts) == 2
    notify.daily_operator_checks(now)
    assert len(sent.posts) == 2
    with SessionLocal() as db:
        assert settings_service.get(db, "notify_version") == "v99.0.0"


def test_a_failed_backup_tells_the_operators(client: TestClient, account: Account, sent: Sent) -> None:
    hooked(client)
    notify.operators("A backup of nexlore failed", "x")
    assert sent.titles() == ["A backup of nexlore failed"]


def test_server_troubles_never_reach_a_member(client: TestClient, account: Account, sent: Sent) -> None:
    anna = person("anna")
    hooked(anna)
    anna_id = anna.get("/api/auth/me").json()["id"]
    notify.send(anna_id, "operator", "The disk of nexlore runs full", "x")
    assert sent.posts == []
