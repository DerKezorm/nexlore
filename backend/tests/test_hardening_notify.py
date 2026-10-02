"""Security review before 1.0.0: invitations, notifications, webhooks, the update check, display names and the log."""

from __future__ import annotations

import http.server
import json
import logging
import threading
import time
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Any, Self

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account, SpaceNotice
from app.security import brake
from app.services import logs, mailer, notify, settings_service, updates

from .conftest import join
from .test_notify import HOOK, Sent, hooked, sent  # noqa: F401  (the fixture is used by name)
from .test_profile import person

# --- Invitations by name ----------------------------------------------------------------------------------------------


def invitation_of(who: TestClient) -> int:
    return next(item["id"] for item in who.get("/api/notices").json() if item["kind"] == "invite")


def test_an_invitation_from_a_manager_who_lost_the_right_is_void(client: TestClient, account: Account) -> None:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Stale"}).status_code == 201
    join(anna, "Stale", "bob", "manage")
    assert anna.put("/api/spaces/Stale/members/carl", json={"role": "manage"}).status_code == 202
    assert bob.put("/api/spaces/Stale/members/anna", json={"role": "read"}).status_code == 200
    answer = carl.post(f"/api/notices/{invitation_of(carl)}/accept")
    assert answer.status_code == 404
    assert "Stale" not in [space["name"] for space in carl.get("/api/spaces").json()]


def test_an_invitation_older_than_thirty_days_is_void(client: TestClient, account: Account) -> None:
    anna, carl = person("anna"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Old"}).status_code == 201
    assert anna.put("/api/spaces/Old/members/carl", json={"role": "write"}).status_code == 202
    notice = invitation_of(carl)
    with SessionLocal() as db:
        row = db.get(SpaceNotice, notice)
        assert row is not None
        row.created_at = datetime.now(UTC) - timedelta(days=40)
        db.commit()
    assert carl.post(f"/api/notices/{notice}/accept").status_code == 404


def test_naming_the_same_account_again_does_not_notify_again(client: TestClient, account: Account,
                                                             sent: Sent) -> None:  # noqa: F811
    anna, carl = person("anna"), person("carl")
    hooked(carl)
    assert anna.post("/api/spaces", json={"name": "Again"}).status_code == 201
    for _ in range(5):
        anna.put("/api/spaces/Again/members/carl", json={"role": "write"})
    anna.put("/api/spaces/Again/members/carl", json={"role": "read"})
    assert len(sent.posts) == 2  # the invitation, and its new right


def test_invitations_by_name_have_an_hourly_limit_for_known_and_unknown_names(client: TestClient,
                                                                              account: Account) -> None:
    anna = person("anna")
    person("carl")
    assert anna.post("/api/spaces", json={"name": "Flood"}).status_code == 201
    answers = [anna.put(f"/api/spaces/Flood/members/{'carl' if n % 2 else f'nobody{n}'}",
                        json={"role": "read"}).status_code for n in range(62)]
    assert answers[:60] == [202] * 60 and answers[-1] == 429
    brake.forget()


def test_an_invitation_mail_needs_the_public_address_and_has_a_limit(client: TestClient, account: Account,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    mails: list[str] = []
    monkeypatch.setattr(mailer, "send_invite", lambda _db, to, link, **_: mails.append(link))
    anna = person("anna")
    assert anna.post("/api/spaces", json={"name": "Mail"}).status_code == 201
    asked = {"email": "guest@example.com", "send": True, "role": "read"}
    refused = anna.post("/api/spaces/Mail/invites", json=asked, headers={"Host": "evil.example"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "public_url_missing"
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": "https://notes.example.com"})
    answers = [anna.post("/api/spaces/Mail/invites", json=asked, headers={"Host": "evil.example"}).status_code
               for _ in range(21)]
    assert answers[:20] == [201] * 20 and answers[-1] == 429
    assert all(link.startswith("https://notes.example.com/invite/") for link in mails)
    brake.forget()


# --- Notifications and webhooks -----------------------------------------------------------------------------------------


def test_one_account_gets_at_most_sixty_notifications_an_hour(client: TestClient, account: Account,
                                                              sent: Sent) -> None:  # noqa: F811
    carl = person("carl")
    hooked(carl)
    me = carl.get("/api/auth/me").json()["id"]
    for number in range(70):
        notify.send(me, "mention", f"Mention {number}", "x")
    assert len(sent.posts) == 60


class _Slow(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.send_response(200)
        self.send_header("Content-Length", str(300 * 1024 * 1024))
        self.end_headers()
        try:
            for _ in range(30):
                self.wfile.write(b"x" * 1024)
                self.wfile.flush()
                time.sleep(0.2)
        except OSError:
            pass

    def log_message(self, *_: Any) -> None:
        return


def test_a_webhook_answer_is_never_read(client: TestClient) -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        started = time.perf_counter()
        status = notify._post(f"http://127.0.0.1:{server.server_address[1]}/hook", {"title": "x"})
        assert status == 200
        assert time.perf_counter() - started < 3
    finally:
        server.shutdown()


def test_the_webhook_test_has_an_hourly_limit(client: TestClient, account: Account, sent: Sent) -> None:  # noqa: F811
    carl = person("carl")
    hooked(carl)
    answers = [carl.post("/api/me/notify/test").status_code for _ in range(11)]
    assert answers[:10] == [200] * 10 and answers[-1] == 429
    brake.forget()


def test_a_mail_subject_is_one_line_whatever_the_title(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[EmailMessage] = []
    monkeypatch.setattr(mailer, "_send", lambda _db, message: built.append(message))
    with SessionLocal() as db:
        notify._mail(db, "carl@example.com", "Line\none\r\x00two three\x85four", "message", "")
    assert built[0]["Subject"] == "Line one two three four"


# --- The update check ---------------------------------------------------------------------------------------------------


def test_a_failed_check_keeps_the_newer_version_found_before(monkeypatch: pytest.MonkeyPatch) -> None:
    updates.forget()
    tags = iter(["v99.0.0", None])
    monkeypatch.setattr(updates, "_ask", lambda: next(tags))
    first = updates.state(force=True)
    assert first.newer and first.latest == "v99.0.0"
    again = updates.state(force=True)
    assert again.newer and again.latest == "v99.0.0"
    updates.forget()


@pytest.mark.parametrize("tag", ["1.2.3<img src=x onerror=alert(1)>", "v2.0.0\nX-Evil: 1", "v" + "9" * 300 + ".0.0",
                                 "v1.0.0-rc1", 7, None, ["v1.0.0"]])
def test_only_a_tag_that_reads_as_a_version_is_taken(monkeypatch: pytest.MonkeyPatch, tag: object) -> None:
    class Answer:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_bytes(self):  # type: ignore[no-untyped-def]
            yield json.dumps({"tag_name": tag}).encode()

    class Client:
        def __init__(self, **_: object) -> None:
            pass

        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def stream(self, *_: object, **__: object) -> Answer:
            return Answer()

    monkeypatch.setattr(updates.httpx, "Client", Client)
    assert updates._ask() is None


# --- Display names ------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("shown", "status"), [
    ("Anna", 409), ("ANNA", 409), ("Anna Garten", 409), (chr(0x202E) + "Bob Admin", 422), ("zero\u200bwidth", 422),
    ("Bob Builder", 200),
])
def test_a_display_name_never_passes_for_another_account(client: TestClient, account: Account, shown: str,
                                                         status: int) -> None:
    anna = person("anna")
    assert anna.put("/api/me/profile", json={"display_name": "Anna Garten"}).status_code == 200
    bob = person("bob")
    assert bob.put("/api/me/profile", json={"display_name": shown}).status_code == status


# --- The log ------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(("line", "kept_out"), [
    ("GET /api/invite/AbCdEfGhIjKlMnOp12 -> 200", "AbCdEfGhIjKlMnOp12"),
    ("GET /api/public/AbCdEfGhIjKlMnOp12/x.md -> 200", "AbCdEfGhIjKlMnOp12"),
    ("GET /api/v1/me?access_token=secretsecret&x=1 -> 401", "secretsecret"),
    ("GET /api/oidc/callback?code=abc123def&state=zzz999 -> 302", "abc123def"),
    ("GET /api/oidc/callback?code=abc123def&state=zzz999 -> 302", "zzz999"),
])
def test_tokens_in_addresses_never_reach_the_log(line: str, kept_out: str) -> None:
    assert kept_out not in logs.redact(line)


def test_the_libraries_that_see_addresses_stay_quiet_at_every_level(client: TestClient, account: Account) -> None:
    for mode in ("detailed", "trace"):
        assert client.put("/api/logs/level", json={"mode": mode, "minutes": 60}).status_code == 200
        for name in ("httpx", "httpcore", "uvicorn.access"):
            assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING, (mode, name)
    client.put("/api/logs/level", json={"mode": "normal", "minutes": 0})


def test_detailed_logging_always_ends(client: TestClient, account: Account) -> None:
    refused = client.put("/api/logs/level", json={"mode": "detailed", "minutes": 0})
    assert refused.status_code == 422
    assert client.put("/api/logs/level", json={"mode": "normal", "minutes": 0}).status_code == 200
