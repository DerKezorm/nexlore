"""``GET /api/v1/versions`` and ``GET /api/v1/versions/{id}/content``: the versions of notes since a moment, with who
made them and whether the change came from outside, for a program that mirrors a space into Git (issue #20).

The world of ``test_api_tokens``: ``anna`` manages ``Garden`` and reads ``Shared`` (bob's); ``Secret`` is bob's alone.
"""

# ruff: noqa: F811  (the fixture world is used by name)
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, File, Version
from app.services import index

from .conftest import join
from .test_api_tokens import PLAN, World, api, code, ok, world  # noqa: F401  (the fixture is used by name)


def mail(name: str, address: str, shown: str = "") -> None:
    with SessionLocal() as db:
        row = db.scalar(select(Account).where(Account.name == name))
        assert row is not None
        row.email, row.email_source, row.display_name = address, "own", shown
        db.commit()


def write(token: str, path: str, text: str) -> None:
    read = ok(api(token, "GET", "/api/v1/note", params={"path": path}))
    assert ok(api(token, "PUT", "/api/v1/note", json={"path": path, "content": text, "base_hash": read["hash"]}))["saved"]


def listed(token: str, **params: Any) -> list[dict]:
    return ok(api(token, "GET", "/api/v1/versions", params=params))["versions"]


def test_each_version_says_which_note_when_who_and_whether_from_outside(world: World) -> None:
    mail("anna", "anna@example.com", "Anna Acker")
    mail("bob", "bob@example.com")
    reader, writer = world.token(), world.token("write")
    bob_writes = world.token("write", who=world.bob)
    write(writer, "Garden/Plan.md", "# Plan\n\nnew\n")
    write(bob_writes, "Shared/Rules.md", "# Rules\n\nbob was here\n")
    (world.vault / "Garden" / "Beans.md").write_bytes(b"# Beans\n\nfrom Syncthing\n")
    index.scan()

    rows = listed(reader)
    assert all(not row["path"].startswith("Secret/") for row in rows)
    assert [row["updated_at"] for row in rows] == sorted(row["updated_at"] for row in rows)
    by_anna = next(row for row in rows if row["path"] == "Garden/Plan.md" and row["source"] == index.API)
    assert (by_anna["outside"], by_anna["space"]) == (False, "Garden")
    # The own address is there; bob's is not, mail addresses of others are the operator's to see.
    assert by_anna["author"] == {"name": "anna", "display_name": "Anna Acker", "email": "anna@example.com"}
    by_bob = next(row for row in rows if row["path"] == "Shared/Rules.md" and row["source"] == index.API)
    assert by_bob["author"] == {"name": "bob", "display_name": "bob", "email": None}
    outside = rows[-1]
    assert (outside["path"], outside["source"], outside["outside"], outside["author"]) == (
        "Garden/Beans.md", index.EXTERNAL, True, None)
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == "Garden/Beans.md"))
    assert outside["file_id"] == file_id and outside["hash"] == index.digest(b"# Beans\n\nfrom Syncthing\n")

    # The operator's token sees every author's address in what it may read.
    join(world.anna, "Garden", "tester", "read")
    as_operator = world.token(who=world.operator)
    authors = {row["author"]["name"]: row["author"]["email"] for row in listed(as_operator) if row["author"]}
    assert authors["anna"] == "anna@example.com"


def test_since_and_the_cursor_page_through_without_gaps(world: World) -> None:
    reader, writer = world.token(), world.token("write")
    for number in range(5):
        # Saves of one writer close together fold into one version; each round here is its own note.
        ok(api(writer, "POST", "/api/v1/notes", json={"folder": "Garden", "title": f"N{number}", "content": "x\n"}),
           201)
    everything = [row["id"] for row in listed(reader, limit=1000)]
    seen, cursor, rounds = [], None, 0
    while True:
        page = ok(api(reader, "GET", "/api/v1/versions", params={"limit": 2, **({"cursor": cursor} if cursor else {})}))
        seen += [row["id"] for row in page["versions"]]
        cursor, rounds = page["cursor"], rounds + 1
        if not page["more"]:
            break
    assert len(everything) >= 9 and seen == everything and rounds == (len(everything) + 1) // 2
    # Nothing new: an empty page that hands the cursor back, to be kept.
    empty = ok(api(reader, "GET", "/api/v1/versions", params={"cursor": cursor}))
    assert (empty["versions"], empty["more"], empty["cursor"]) == ([], False, cursor)
    write(writer, "Garden/N0.md", "y\n")
    assert [row["path"] for row in listed(reader, cursor=cursor)] == ["Garden/N0.md"]

    with SessionLocal() as db:
        middle = db.get(Version, everything[len(everything) // 2]).updated_at
        later_ids = set(db.scalars(select(Version.id).join(File, File.id == Version.file_id).where(
            Version.updated_at > middle, File.deleted_at.is_(None), ~File.path.startswith("Secret/"))))
    after = [row["id"] for row in listed(reader, since=middle.isoformat(), limit=1000)]
    assert after and set(after) == later_ids
    later = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    assert listed(reader, since=later) == []
    assert code(api(reader, "GET", "/api/v1/versions", params={"since": "2026-11-17T06:00:00"})) == (400, "bad_time")
    assert code(api(reader, "GET", "/api/v1/versions", params={"since": "yesterday"})) == (400, "bad_time")
    assert code(api(reader, "GET", "/api/v1/versions", params={"cursor": "nonsense"})) == (400, "bad_cursor")


def test_only_what_the_token_may_read(world: World) -> None:
    every = world.token()
    assert {row["space"] for row in listed(every)} == {"Garden", "Shared"}
    assert {row["space"] for row in listed(every, space="Shared")} == {"Shared"}
    assert code(api(every, "GET", "/api/v1/versions", params={"space": "Secret"})) == (404, "not_found")
    limited = world.token(spaces=[world.space_id("Shared")])
    assert {row["space"] for row in listed(limited)} == {"Shared"}
    with SessionLocal() as db:
        secret = db.scalar(select(Version.id).join(File, File.id == Version.file_id)
                           .where(File.path == "Secret/Diary.md"))
        garden = db.scalar(select(Version.id).join(File, File.id == Version.file_id)
                           .where(File.path == "Garden/Plan.md"))
    for token, version_id in ((every, secret), (limited, garden), (every, 999_999)):
        assert code(api(token, "GET", f"/api/v1/versions/{version_id}/content")) == (404, "not_found")


def test_the_content_comes_byte_for_byte_and_a_note_in_the_trash_is_gone(world: World) -> None:
    reader = world.token()
    plan = next(row for row in listed(reader) if row["path"] == "Garden/Plan.md")
    got = api(reader, "GET", f"/api/v1/versions/{plan['id']}/content")
    # CRLF and all, as the file was.
    assert got.status_code == 200 and got.content == PLAN.encode()
    assert got.headers["x-nexlore-path"] == "Garden/Plan.md" and got.headers["x-nexlore-hash"] == plan["hash"]
    assert world.anna.delete("/api/files", params={"path": "Garden/Plan.md"}).status_code == 200
    assert all(row["path"] != "Garden/Plan.md" for row in listed(reader))
    assert code(api(reader, "GET", f"/api/v1/versions/{plan['id']}/content")) == (404, "not_found")


def test_a_reading_level_is_enough_and_a_browser_is_refused(world: World) -> None:
    reader = world.token()
    assert api(reader, "GET", "/api/v1/versions").status_code == 200
    assert code(api(reader, "GET", "/api/v1/versions", headers={"Origin": "http://evil"})) == (403, "origin_refused")
    assert code(api(None, "GET", "/api/v1/versions")) == (401, "token_invalid")
    client = TestClient(world.anna.app)
    assert client.get("/api/v1/versions").status_code == 401
