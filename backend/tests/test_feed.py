"""The calendar subscription, a space as ZIP, and the key of a feed never in the log.

The world: ``anna`` manages ``Garden`` (tasks with dates) and ``Kitchen``; ``bob`` may only read ``Garden``;
``carl`` has ``Diary`` alone. The operator is ``tester`` (the ``client``).
"""

from __future__ import annotations

import io
import logging
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import feed, logs

from .conftest import join, make_account, sign_in

TODAY = datetime.now().astimezone().date()
SOON = (TODAY + timedelta(days=3)).isoformat()
LONG_AGO = (TODAY - timedelta(days=200)).isoformat()


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def note(client: TestClient, folder: str, title: str, content: str) -> None:
    made = client.post("/api/notes", json={"folder": folder, "title": title, "content": content})
    assert made.status_code == 201, made.text


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    for space in ("Garden", "Kitchen"):
        assert anna.post("/api/spaces", json={"name": space}).status_code == 201
    assert carl.post("/api/spaces", json={"name": "Diary"}).status_code == 201
    note(anna, "Garden", "Beds", f"- [ ] Dig, the beds; now 📅 {SOON}\n- [x] Done already 📅 {SOON}\n- [ ] Old 📅 {LONG_AGO}\n")
    note(anna, "Garden", "Loose", "- [ ] No date at all\n")
    note(anna, "Kitchen", "Jam", f"- [ ] Cook jam 📅 {SOON}\n")
    note(carl, "Diary", "Secret", f"- [ ] Mine 📅 {SOON}\n")
    join(anna, "Garden", "bob", "read")
    return {"anna": anna, "bob": bob, "carl": carl, "operator": client}


def open_feeds(operator: TestClient) -> None:
    assert operator.put("/api/settings", json={"calendar_feed_allowed": True}).status_code == 200
    # The switch says so when read again (its field was once missing from the answer, and it always showed off).
    assert operator.get("/api/settings").json()["calendar_feed_allowed"] is True


def test_the_feed_is_closed_until_the_operator_opens_it(people: dict[str, TestClient]) -> None:
    bob = people["bob"]
    assert bob.get("/api/me/calendar-feed").json() == {"allowed": False, "active": False}
    assert bob.post("/api/me/calendar-feed").json()["detail"]["code"] == "calendar_feed_closed"
    open_feeds(people["operator"])
    made = bob.post("/api/me/calendar-feed")
    assert made.status_code == 200, made.text
    address = made.json()["path"]
    assert address.startswith("/api/calendar/feed/nxc_") and address.endswith(".ics")
    assert bob.get("/api/me/calendar-feed").json() == {"allowed": True, "active": True}
    # Closed again: the address answers like one that never was.
    assert people["operator"].put("/api/settings", json={"calendar_feed_allowed": False}).status_code == 200
    assert TestClient(app).get(address).status_code == 404


def test_the_feed_holds_the_open_dated_tasks_the_account_may_read(people: dict[str, TestClient]) -> None:
    open_feeds(people["operator"])
    bob = people["bob"]
    address = bob.post("/api/me/calendar-feed").json()["path"]
    # No session: a calendar app has only the address.
    answer = TestClient(app).get(address)
    assert answer.status_code == 200
    assert answer.headers["content-type"].startswith("text/calendar")
    body = answer.text
    assert body.startswith("BEGIN:VCALENDAR\r\n") and body.endswith("END:VCALENDAR\r\n")
    assert body.count("BEGIN:VEVENT") == 1
    day = SOON.replace("-", "")
    assert f"DTSTART;VALUE=DATE:{day}" in body
    # Commas and semicolons are escaped; the note is named; its address leads to it.
    assert "SUMMARY:Dig\\, the beds\\; now" in body
    assert "DESCRIPTION:Beds" in body
    assert "URL:http://testserver/note/Garden/Beds.md" in body
    for other in ("Done already", "Old", "No date", "Cook jam", "Mine"):
        assert other not in body
    # anna reads Kitchen too.
    anna_body = TestClient(app).get(people["anna"].post("/api/me/calendar-feed").json()["path"]).text
    assert anna_body.count("BEGIN:VEVENT") == 2 and "Cook jam" in anna_body


def test_a_new_address_ends_the_old_one_and_stopping_ends_both(people: dict[str, TestClient]) -> None:
    open_feeds(people["operator"])
    bob = people["bob"]
    first = bob.post("/api/me/calendar-feed").json()["path"]
    second = bob.post("/api/me/calendar-feed").json()["path"]
    assert first != second
    outside = TestClient(app)
    assert outside.get(first).status_code == 404
    assert outside.get(second).status_code == 200
    assert bob.delete("/api/me/calendar-feed").status_code == 204
    assert outside.get(second).status_code == 404
    assert bob.get("/api/me/calendar-feed").json()["active"] is False
    assert outside.get("/api/calendar/feed/nxc_made-up.ics").status_code == 404
    assert outside.get("/api/calendar/feed/something.ics").status_code == 404


def test_long_lines_are_folded_at_75_octets() -> None:
    folded = feed._fold("SUMMARY:" + "ä" * 60)
    for line in folded.split("\r\n"):
        assert len(line.encode("utf-8")) <= 75
    assert folded.replace("\r\n ", "") == "SUMMARY:" + "ä" * 60


def test_the_key_of_a_feed_never_reaches_the_log(caplog: pytest.LogCaptureFixture) -> None:
    assert logs.redact("GET /api/calendar/feed/nxc_abcdefghijklmnop.ics -> 200") == "GET /api/calendar/feed/nxc_….ics -> 200"
    record = logging.LogRecord("x", logging.WARNING, __file__, 1, "Slow request: %s", ("/api/calendar/feed/nxc_secretsecret1234.ics",), None)
    logs._ContextFilter().filter(record)
    assert "secretsecret" not in record.getMessage()


def test_a_space_comes_as_a_zip_for_whoever_may_read_it(people: dict[str, TestClient], vault: Path) -> None:
    bob, carl = people["bob"], people["carl"]
    (vault / "Garden" / "photo.png").write_bytes(b"\x89PNG fake")
    people["operator"].post("/api/index/scan")
    answer = bob.get("/api/spaces/Garden/zip")
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"] == "application/zip"
    assert "Garden-" in answer.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(answer.content)) as archive:
        names = sorted(archive.namelist())
        assert names == ["Garden/Beds.md", "Garden/Loose.md", "Garden/photo.png"]
        assert archive.read("Garden/Loose.md") == b"- [ ] No date at all\n"
    assert carl.get("/api/spaces/Garden/zip").status_code == 404
    assert bob.get("/api/spaces/Garden%2FDeep/zip").status_code == 404


def test_chosen_files_come_as_a_zip_named_apart_and_only_readable_ones(people: dict[str, TestClient], vault: Path) -> None:
    bob, carl = people["bob"], people["carl"]
    (vault / "Garden" / "photo.png").write_bytes(b"\x89PNG one")
    (vault / "Garden" / "Deep").mkdir()
    (vault / "Garden" / "Deep" / "photo.png").write_bytes(b"\x89PNG two")
    people["operator"].post("/api/index/scan")
    chosen = {"paths": ["Garden/photo.png", "Garden/Deep/photo.png", "Garden/photo.png"], "name": "Beds: pictures"}
    answer = bob.post("/api/files/zip", json=chosen)
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"] == "application/zip"
    assert "Beds%20pictures.zip" in answer.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(answer.content)) as archive:
        # Each once, the second of a name numbered.
        assert archive.namelist() == ["photo.png", "photo (2).png"]
        assert archive.read("photo (2).png") == b"\x89PNG two"
    # Only what may be read, and only files that are there.
    assert carl.post("/api/files/zip", json={"paths": ["Garden/photo.png"]}).status_code == 404
    assert bob.post("/api/files/zip", json={"paths": ["Garden/nothing.png"]}).status_code == 404
    assert bob.post("/api/files/zip", json={"paths": []}).status_code == 422
