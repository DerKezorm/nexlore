"""MCP decision 15: a change an AI program made stands in the note's history as "MCP · <key>", as nexnotes shows it:
the version keeps the name of the key (or program) it came with (``versions.key_name``, an added column), the history
route gives it beside the source ``mcp``; a version by hand names no key, and one of before (without a name) still says
only "AI (MCP)"."""

from __future__ import annotations

import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import File, Version, utcnow

from .test_mcp import World, call, value


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    return World(client, vault)


def _history(world: World, path: str) -> list[dict]:
    answer = world.anna.get("/api/versions", params={"path": path})
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_a_change_by_an_ai_program_names_its_key(world: World) -> None:
    token = world.key("write")
    made = value(call(token, "create_note", folder="Garden", title="Seeds", content="Beans\n"))
    path = made["path"]
    kept = _history(world, path)
    assert [(row["source"], row["key_name"]) for row in kept] == [("mcp", "agent write")]
    plan = value(call(token, "read_note", path="Garden/Plan.md"))
    value(call(token, "write_note", path="Garden/Plan.md", content=plan["content"] + "Third line.\n",
               base_hash=plan["hash"]))
    assert _history(world, "Garden/Plan.md")[0]["key_name"] == "agent write"


def test_a_change_by_hand_names_no_key_and_one_of_before_stays_as_it_was(world: World) -> None:
    token = world.key("write")
    value(call(token, "create_note", folder="Garden", title="Seeds", content="Beans\n"))
    # By hand, in the browser, right after: no key.
    current = world.anna.get("/api/note", params={"path": "Garden/Seeds.md"}).json()
    saved = world.anna.put("/api/note", json={"path": "Garden/Seeds.md", "content": "Beans and peas\n",
                                              "base_hash": current["hash"]})
    assert saved.status_code == 200, saved.text
    newest = _history(world, "Garden/Seeds.md")[0]
    assert (newest["source"], newest["key_name"]) == ("app", None)
    # A version an AI program made before the column: no name, the source as ever.
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Garden/Plan.md"))
        assert file is not None
        data = b"# Plan\n\nAn older AI line.\n"
        db.add(Version(file_id=file.id, path=file.path, created_at=utcnow(), updated_at=utcnow(), source="mcp",
                       author="anna", hash="0" * 64, size=len(data), content=zlib.compress(data)))
        db.commit()
    older = next(row for row in _history(world, "Garden/Plan.md") if row["source"] == "mcp")
    assert older["key_name"] is None


def test_only_the_programs_own_versions_name_it(world: World) -> None:
    """Links that follow a rename are rewritten as "rename" versions, as ever (``renameBy``): no key on them."""
    token = world.key("write")
    value(call(token, "create_note", folder="Garden", title="Seeds", content="See [[Plan]].\n"))
    value(call(token, "rename_note", path="Garden/Plan.md", title="Plan 2"))
    sources = [(row["source"], row["key_name"]) for row in _history(world, "Garden/Seeds.md")]
    assert sources[0] == ("rename", None) and ("mcp", "agent write") in sources
