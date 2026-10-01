"""Renaming a space (block Y2): the folder, every path in it, and every link that names the space in front follow.

The world: anna manages ``Garden`` and writes in ``Kitchen``; bob's ``Secret`` links into Garden too, and anna may not
read it. Links without the space's name, and relative ones, stay as they were written.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account, Draft, Share, Version
from app.services import index

from .conftest import join, make_account
from .test_mcp import call, switch, value
from .test_profile import person

INSIDE = "# Plan\n\nSee [[Garden/Beds/Tomatoes]] and [[Tomatoes]] and [beds](Beds/Tomatoes.md).\n"
OUTSIDE = (
    "# Shopping\n\nFor [[Garden/Plan]], [[Garden/Plan|the plan]], ![[Garden/Beds/Tomatoes]],\n"
    "[plan](Garden/Plan.md), [top](/Garden/Plan.md), [up](../Garden/Beds/Tomatoes.md).\n"
)
SECRET = "# Diary\n\nThe [[Garden/Plan]] again.\n"


class World:
    def __init__(self, vault: Path) -> None:
        self.vault = vault
        self.anna = person("anna")
        self.bob = person("bob")
        for owner, space in ((self.anna, "Garden"), (self.anna, "Kitchen"), (self.bob, "Secret")):
            assert owner.post("/api/spaces", json={"name": space}).status_code == 201
        (vault / "Garden" / "Beds").mkdir()
        (vault / "Garden" / "Plan.md").write_bytes(INSIDE.encode())
        (vault / "Garden" / "Beds" / "Tomatoes.md").write_bytes(b"# Tomatoes\n")
        (vault / "Kitchen" / "Shopping.md").write_bytes(OUTSIDE.encode())
        (vault / "Secret" / "Diary.md").write_bytes(SECRET.encode())
        index.scan()

    def rename(self, who: TestClient, space: str, name: str):
        return who.post(f"/api/spaces/{space}/rename", json={"name": name})


@pytest.fixture
def world(client: TestClient, account: Account, vault: Path) -> World:
    return World(vault)


def text(world: World, rel: str) -> str:
    return (world.vault / rel).read_bytes().decode()


def test_the_folder_and_every_path_follow(world: World) -> None:
    answer = world.rename(world.anna, "Garden", "Yard")
    assert answer.status_code == 200, answer.text
    assert answer.json()["path"] == "Yard"
    assert not (world.vault / "Garden").exists() and (world.vault / "Yard" / "Beds" / "Tomatoes.md").exists()
    spaces = {space["name"]: space["role"] for space in world.anna.get("/api/spaces").json()}
    assert spaces["Yard"] == "manage" and "Garden" not in spaces
    assert world.anna.get("/api/note", params={"path": "Yard/Plan.md"}).status_code == 200
    assert world.anna.get("/api/note", params={"path": "Garden/Plan.md"}).status_code == 404
    hits = world.anna.get("/api/search", params={"q": "Tomatoes"}).json()
    assert any(hit["path"] == "Yard/Beds/Tomatoes.md" for hit in hits)


def test_links_naming_the_space_follow_in_their_own_spelling(world: World) -> None:
    answer = world.rename(world.anna, "Garden", "Yard")
    assert answer.status_code == 200, answer.text
    assert text(world, "Kitchen/Shopping.md") == (
        "# Shopping\n\nFor [[Yard/Plan]], [[Yard/Plan|the plan]], ![[Yard/Beds/Tomatoes]],\n"
        "[plan](Yard/Plan.md), [top](/Yard/Plan.md), [up](../Yard/Beds/Tomatoes.md).\n"
    )
    # Inside the space: the link with the old name in front leads on without it; the others stay as written.
    assert text(world, "Yard/Plan.md") == (
        "# Plan\n\nSee [[Beds/Tomatoes]] and [[Tomatoes]] and [beds](Beds/Tomatoes.md).\n"
    )
    outgoing = world.anna.get("/api/links", params={"path": "Kitchen/Shopping.md"}).json()["outgoing"]
    assert {link["path"] for link in outgoing} == {"Yard/Plan.md", "Yard/Beds/Tomatoes.md"}
    assert all(link["path"] is not None for link in outgoing)
    # The count names only notes anna may read: Kitchen and Yard, not bob's Secret.
    assert answer.json()["rewritten"] == 2


def test_links_follow_where_the_renamer_may_not_read_too(world: World) -> None:
    join(world.anna, "Garden", "bob", "read")
    assert world.rename(world.anna, "Garden", "Yard").status_code == 200
    assert text(world, "Secret/Diary.md") == "# Diary\n\nThe [[Yard/Plan]] again.\n"


def test_only_a_manager_renames_and_a_foreign_space_is_like_a_missing_one(world: World) -> None:
    join(world.anna, "Garden", "bob", "write")
    assert world.rename(world.bob, "Garden", "Yard").status_code == 403
    foreign = world.rename(world.anna, "Secret", "Mine")
    missing = world.rename(world.anna, "Nowhere", "Mine")
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json()["detail"]["message"] == missing.json()["detail"]["message"]
    assert (world.vault / "Secret").is_dir() and (world.vault / "Garden").is_dir()


def test_a_name_must_be_free_and_valid(world: World) -> None:
    assert world.rename(world.anna, "Garden", "Kitchen").status_code == 409
    assert world.rename(world.anna, "Garden", "kitchen").status_code == 409
    # A name of a space in the trash is taken too: the space may come back.
    assert world.anna.delete("/api/files", params={"path": "Kitchen"}).status_code == 200
    assert world.rename(world.anna, "Garden", "Kitchen").status_code == 409
    # A name nexlore would not give a new space either: the same answer as there.
    made = world.anna.post("/api/spaces", json={"name": "Bad/Name"})
    bad = world.rename(world.anna, "Garden", "Bad/Name")
    assert bad.status_code == made.status_code >= 400
    assert bad.json()["detail"]["code"] == made.json()["detail"]["code"]
    assert world.rename(world.anna, "Garden", "Garden").status_code >= 400
    assert (world.vault / "Garden").is_dir()


def test_only_the_case_changes(world: World) -> None:
    assert world.rename(world.anna, "Garden", "garden").status_code == 200
    assert [p.name for p in world.vault.iterdir() if p.name.lower() == "garden"] == ["garden"]
    assert world.anna.get("/api/note", params={"path": "garden/Plan.md"}).status_code == 200
    # Links naming it in another case still lead there and are left alone.
    assert "[[Garden/Plan]]" in text(world, "Kitchen/Shopping.md")


def test_what_belongs_to_the_space_follows(world: World) -> None:
    switch(shares_allowed=True)
    assert world.anna.put("/api/favorites", json={"path": "Garden/Plan.md"}).status_code == 204
    assert world.anna.put("/api/favorites", json={"path": "Garden/Beds"}).status_code == 204
    assert world.anna.post("/api/shares", json={"path": "Garden/Plan.md"}).status_code == 201
    assert world.anna.put("/api/me/appearance", json={"home_space": "Garden", "start": "note",
                                                       "start_note": "Garden/Plan.md"}).status_code == 200
    # bob's start note elsewhere stays.
    assert world.bob.put("/api/me/appearance", json={"home_space": "Secret"}).status_code == 200
    saved = world.anna.get("/api/note", params={"path": "Garden/Plan.md"}).json()
    assert world.anna.put("/api/note", json={"path": "Garden/Plan.md", "content": INSIDE + "More.\n",
                                             "base_hash": saved["hash"]}).status_code == 200
    assert world.anna.delete("/api/files", params={"path": "Garden/Beds/Tomatoes.md"}).status_code == 200

    assert world.rename(world.anna, "Garden", "Yard").status_code == 200
    assert {f["path"] for f in world.anna.get("/api/favorites").json()} == {"Yard/Plan.md", "Yard/Beds"}
    with SessionLocal() as db:
        assert {share.path for share in db.query(Share).all()} == {"Yard/Plan.md"}
        paths = {version.path for version in db.query(Version).all()}
        assert not any(path.startswith("Garden/") for path in paths)
    look = world.anna.get("/api/auth/me").json()["appearance"]
    assert (look["home_space"], look["start_note"]) == ("Yard", "Yard/Plan.md")
    assert world.bob.get("/api/auth/me").json()["appearance"]["home_space"] == "Secret"
    # What lay in the trash comes back into the renamed space.
    entry = next(e for e in world.anna.get("/api/trash").json() if e["path"].endswith("Tomatoes.md"))
    assert entry["path"] == "Yard/Beds/Tomatoes.md"
    assert world.anna.post(f"/api/trash/{entry['id']}/restore").status_code == 200
    assert (world.vault / "Yard" / "Beds" / "Tomatoes.md").exists()


def test_drafts_follow(world: World) -> None:
    switch(mcp_allowed=True, mcp_max_level="write")
    token = world.anna.post("/api/mcp/keys", json={"name": "d", "level": "draft"}).json()["token"]
    note = value(call(token, "read_note", path="Garden/Plan.md"))
    value(call(token, "propose_change", path="Garden/Plan.md", content="New\n", base_hash=note["hash"]))
    assert world.rename(world.anna, "Garden", "Yard").status_code == 200
    with SessionLocal() as db:
        assert [draft.path for draft in db.query(Draft).all()] == ["Yard/Plan.md"]


def test_a_note_somebody_else_edits_stops_it(world: World) -> None:
    join(world.anna, "Garden", "bob", "write")
    locked = world.bob.post("/api/locks", json={"path": "Garden/Plan.md"})
    assert locked.status_code in (200, 201), locked.text
    refused = world.rename(world.anna, "Garden", "Yard")
    assert refused.status_code == 423
    assert (world.vault / "Garden" / "Plan.md").exists()
    assert {space["name"] for space in world.anna.get("/api/spaces").json()} >= {"Garden"}


def test_not_while_the_vault_is_being_read(world: World) -> None:
    assert index.scan_lock.acquire(blocking=False)
    try:
        assert world.rename(world.anna, "Garden", "Yard").status_code == 409
    finally:
        index.scan_lock.release()
    assert (world.vault / "Garden").is_dir()


def test_mcp_renames_a_space_too(world: World) -> None:
    switch(mcp_allowed=True, mcp_max_level="write")
    made = world.anna.post("/api/mcp/keys", json={"name": "r", "level": "write"}).json()
    assert world.anna.put(f"/api/mcp/keys/{made['key']['id']}/rights",
                          json={"rights": {"rename_space": "allow"}}).status_code == 200
    renamed = value(call(made["token"], "rename_space", space="Garden", name="Yard"))
    assert renamed == {"space": "Yard", "links_rewritten": 2}
    assert (world.vault / "Yard" / "Plan.md").exists()


def test_an_operator_without_membership_cannot_rename_a_members_space(world: World, client: TestClient) -> None:
    make_account("carl")
    assert client.post("/api/spaces/Garden/rename", json={"name": "Yard"}).status_code == 404
