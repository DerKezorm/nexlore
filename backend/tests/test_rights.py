"""Rights per space: nothing of a space one may not read shows anywhere, and each right allows what it says.

The world of these tests: ``anna`` made the space ``Private`` (nobody else in it) and ``Shared``, where ``bob`` may
read and ``carl`` may write. ``Ops`` came from the disk and has no members: it is the operator's.
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import OPERATOR, Account, Invite, Version, utcnow

from .conftest import PASSWORD, join, make_account, sign_in

SECRET = "classified pineapple"


def person(account: Account, tab: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{tab:0<8}"})
    sign_in(client, account)
    return client


class World:
    def __init__(self, client: TestClient, operator: Account) -> None:
        self.operator = client
        self.anna_row = make_account("anna")
        self.bob_row = make_account("bob")
        self.carl_row = make_account("carl")
        self.anna = person(self.anna_row, "anna")
        self.bob = person(self.bob_row, "bob")
        self.carl = person(self.carl_row, "carl")


@pytest.fixture
def world(client: TestClient, account: Account, vault: Path) -> World:
    (vault / "Ops").mkdir()
    (vault / "Ops" / "Runbook.md").write_text("# Runbook\n\nrestart the pump\n", encoding="utf-8")
    client.post("/api/index/scan")
    w = World(client, account)
    assert w.anna.post("/api/spaces", json={"name": "Private"}).status_code == 201
    assert w.anna.post("/api/spaces", json={"name": "Shared"}).status_code == 201
    made = w.anna.post(
        "/api/notes",
        json={"folder": "Private", "title": "Secret Plan", "content": f"# Secret Plan\n\n{SECRET} #hidden [[Other]]\n"},
    )
    assert made.status_code == 201, made.text
    w.anna.post("/api/notes", json={"folder": "Private", "title": "Other", "content": "links back [[Secret Plan]]"})
    w.anna.post("/api/notes", json={"folder": "Shared", "title": "Common", "content": "for all of us #team"})
    join(w.anna, "Shared", "bob", "read")
    join(w.anna, "Shared", "carl", "write")
    return w


def names(client: TestClient) -> list[str]:
    return [space["name"] for space in client.get("/api/spaces").json()]


def test_everybody_sees_only_their_spaces(world: World) -> None:
    assert names(world.operator) == ["Ops"]
    assert names(world.anna) == ["Private", "Shared"]
    assert names(world.bob) == ["Shared"]
    roles = {space["name"]: space["role"] for space in world.anna.get("/api/spaces").json()}
    assert roles == {"Private": "manage", "Shared": "manage"}
    assert world.bob.get("/api/spaces").json()[0]["role"] == "read"


@pytest.mark.parametrize(
    "url",
    [
        "/api/folder?path=Private",
        "/api/note?path=Private/Secret Plan.md",
        "/api/note/state?path=Private/Secret Plan.md",
        "/api/note/copies?path=Private/Secret Plan.md",
        "/api/links?path=Private/Secret Plan.md",
        "/api/versions?path=Private/Secret Plan.md",
        "/api/files/own?path=Private/Secret Plan.md",
        "/api/file?path=Private/Secret Plan.md",
        "/api/graph/overview?space=Private",
        "/api/graph/overview?space=Private&cloud=tags",
        "/api/graph/tiles?space=Private&t=0:0:0",
        "/api/graph/locate?path=Private/Secret Plan.md",
        "/api/graph/local?path=Private/Secret Plan.md",
        "/api/attachments?space=Private",
        "/api/spaces/Private/report",
        "/api/resolve?source=Private/Secret Plan.md&target=Other",
    ],
)
def test_a_foreign_space_answers_like_a_missing_one(world: World, url: str) -> None:
    foreign = world.operator.get(url)
    missing = world.operator.get(url.replace("Private", "Nowhere"))
    assert foreign.status_code == 404, url
    assert foreign.status_code == missing.status_code
    assert SECRET not in foreign.text and "Secret" not in foreign.text
    # The owner reads all of it.
    assert world.anna.get(url).status_code == 200, url


def test_search_tags_and_trash_leave_foreign_spaces_out(world: World) -> None:
    assert world.anna.get("/api/search", params={"q": "pineapple"}).json()[0]["path"] == "Private/Secret Plan.md"
    for other in (world.operator, world.bob):
        assert other.get("/api/search", params={"q": "pineapple"}).json() == []
        assert other.get("/api/search", params={"q": "Secret"}).json() == []
        tags = [tag["tag"] for tag in other.get("/api/tags").json()]
        assert "hidden" not in tags
        assert other.get("/api/tags", params={"space": "Private"}).json() == []
    assert "team" in [tag["tag"] for tag in world.bob.get("/api/tags").json()]
    world.anna.delete("/api/files", params={"path": "Private/Other.md"})
    assert [entry["path"] for entry in world.anna.get("/api/trash").json()] == ["Private/Other.md"]
    assert world.operator.get("/api/trash").json() == []
    entry = world.anna.get("/api/trash").json()[0]["id"]
    assert world.operator.post(f"/api/trash/{entry}/restore").status_code == 404
    assert world.operator.delete(f"/api/trash/{entry}").status_code == 404
    assert world.anna.post(f"/api/trash/{entry}/restore").status_code == 200


def test_a_version_of_a_foreign_note_is_not_there(world: World) -> None:
    with SessionLocal() as db:
        version_id = db.scalar(select(Version.id).where(Version.path == "Private/Secret Plan.md"))
    assert version_id is not None
    assert world.operator.get(f"/api/versions/{version_id}").status_code == 404
    assert world.operator.post(f"/api/versions/{version_id}/restore").status_code == 404
    assert world.bob.get(f"/api/versions/{version_id}").status_code == 404
    assert SECRET in world.anna.get(f"/api/versions/{version_id}").text


def test_reading_is_not_writing(world: World) -> None:
    bob = world.bob
    note = bob.get("/api/note", params={"path": "Shared/Common.md"}).json()
    assert note["content"] == "for all of us #team"
    refusals = [
        bob.put("/api/note", json={"path": "Shared/Common.md", "content": "mine now", "base_hash": note["hash"]}),
        bob.post("/api/notes", json={"folder": "Shared", "title": "New"}),
        bob.post("/api/folders", json={"parent": "Shared", "name": "Folder"}),
        bob.post("/api/locks", json={"path": "Shared/Common.md"}),
        bob.post("/api/move", json={"source": "Shared/Common.md", "destination": "Shared/Moved.md"}),
        bob.delete("/api/files", params={"path": "Shared/Common.md"}),
        bob.post("/api/attachments", params={"note": "Shared/Common.md", "name": "a.txt"}, content=b"text"),
    ]
    for refused in refusals:
        assert refused.status_code == 403, refused.request.url
        assert refused.json()["detail"]["code"] == "forbidden"
    assert bob.get("/api/trash").json() == []


def test_writing_is_not_managing(world: World) -> None:
    carl = world.carl
    note = carl.get("/api/note", params={"path": "Shared/Common.md"}).json()
    saved = carl.put("/api/note", json={"path": "Shared/Common.md", "content": "edited", "base_hash": note["hash"]})
    assert saved.json()["saved"] is True
    assert carl.post("/api/notes", json={"folder": "Shared", "title": "Carl"}).status_code == 201
    assert carl.delete("/api/files", params={"path": "Shared/Carl.md"}).status_code == 200
    # The whole space is a manager's.
    assert carl.delete("/api/files", params={"path": "Shared"}).status_code == 403
    assert carl.get("/api/spaces/Shared/members").status_code == 403
    assert carl.put("/api/spaces/Shared/members/bob", json={"role": "manage"}).status_code == 403
    assert carl.post("/api/spaces/Shared/invites", json={"role": "read"}).status_code == 403
    assert world.anna.delete("/api/files", params={"path": "Shared"}).status_code == 200


def test_the_operator_reads_nothing_of_a_space_with_members(world: World) -> None:
    # Resetting rights is allowed; taking one is not.
    listed = {row["name"]: row for row in world.operator.get("/api/admin/spaces").json()}
    assert listed["Private"]["managers"] == ["anna"] and listed["Private"]["role"] is None
    assert listed["Ops"]["members"] == 0 and listed["Ops"]["role"] == "manage"
    members = world.operator.get("/api/spaces/Private/members").json()
    assert [row["name"] for row in members["members"]] == ["anna"]
    taking = world.operator.put("/api/spaces/Private/members/tester", json={"role": "read"})
    assert taking.status_code == 403
    join(world.operator, "Private", "bob", "manage")
    assert "Private" in names(world.bob)
    assert world.operator.get("/api/note", params={"path": "Private/Secret Plan.md"}).status_code == 404


def test_a_space_without_members_is_the_operators(world: World) -> None:
    assert world.anna.get("/api/note", params={"path": "Ops/Runbook.md"}).status_code == 404
    assert world.operator.get("/api/note", params={"path": "Ops/Runbook.md"}).status_code == 200
    # Handing it on keeps the operator in as manager.
    join(world.operator, "Ops", "anna", "write")
    assert world.anna.get("/api/note", params={"path": "Ops/Runbook.md"}).status_code == 200
    roles = {row["name"]: row["role"] for row in world.operator.get("/api/spaces/Ops/members").json()["members"]}
    assert roles == {"anna": "write", "tester": "manage"}


def test_the_last_manager_stays_while_others_are_in(world: World) -> None:
    anna = world.anna
    assert anna.delete("/api/spaces/Shared/members/anna").json()["detail"]["code"] == "last_manager"
    assert anna.put("/api/spaces/Shared/members/anna", json={"role": "write"}).status_code == 409
    join(anna, "Shared", "carl", "manage")
    assert anna.delete("/api/spaces/Shared/members/anna").status_code == 204
    assert "Shared" not in names(anna)
    # Anybody may leave a space; bob leaves by himself.
    assert world.bob.delete("/api/spaces/Shared/members/bob").status_code == 204
    assert names(world.bob) == []
    # Somebody without a right cannot remove anyone, and learns nothing.
    assert world.bob.delete("/api/spaces/Shared/members/carl").status_code == 404


def test_an_invitation_into_a_space(world: World, client: TestClient) -> None:
    made = world.anna.post("/api/spaces/Shared/invites", json={"role": "write", "days": 7})
    assert made.status_code == 201
    link = made.json()["link"]
    token = link.rsplit("/", 1)[1]
    assert link.startswith("http://testserver/invite/")
    stranger = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-stranger"})
    offer = stranger.get(f"/api/invite/{token}").json()
    assert offer == {"space": "Shared", "role": "write", "min_password": 12, "signed_in_as": None}
    joined = stranger.post(f"/api/invite/{token}", json={"name": "dora", "password": "a long enough password"})
    assert joined.status_code == 200 and joined.json()["name"] == "dora" and joined.json()["role"] == "member"
    assert names(stranger) == ["Shared"]
    # Used up.
    assert stranger.get(f"/api/invite/{token}").status_code == 404
    again = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-another"})
    assert again.post(f"/api/invite/{token}", json={"name": "eve", "password": "a long enough password"}).status_code == 404


def test_a_signed_in_account_joins_with_an_invitation(world: World) -> None:
    token = world.anna.post("/api/spaces/Private/invites", json={"role": "read"}).json()["link"].rsplit("/", 1)[1]
    assert world.bob.get(f"/api/invite/{token}").json()["signed_in_as"] == "bob"
    assert world.bob.post(f"/api/invite/{token}/join").json() == {"space": "Private"}
    assert "Private" in names(world.bob)
    assert world.bob.get("/api/note", params={"path": "Private/Secret Plan.md"}).status_code == 200


def test_a_join_never_lowers_a_right(world: World) -> None:
    token = world.anna.post("/api/spaces/Shared/invites", json={"role": "read"}).json()["link"].rsplit("/", 1)[1]
    world.carl.post(f"/api/invite/{token}/join")
    roles = {row["name"]: row["role"] for row in world.anna.get("/api/spaces/Shared/members").json()["members"]}
    assert roles["carl"] == "write"


def test_an_expired_invitation_is_not_valid(world: World) -> None:
    token = world.anna.post("/api/spaces/Shared/invites", json={"role": "read", "days": 1}).json()["link"]
    token = token.rsplit("/", 1)[1]
    with SessionLocal() as db:
        for row in db.scalars(select(Invite)):
            row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert world.bob.get(f"/api/invite/{token}").status_code == 404
    assert world.bob.post(f"/api/invite/{token}/join").status_code == 404
    assert world.anna.get("/api/spaces/Shared/members").json()["invites"] == []


def test_invitations_are_checked(world: World) -> None:
    assert world.anna.post("/api/spaces/Shared/invites", json={"role": "boss"}).status_code == 422
    assert world.anna.post("/api/spaces/Shared/invites", json={"role": "read", "days": 99}).status_code == 422
    assert world.anna.post("/api/spaces/Private/invites", json={"role": "read", "email": "no"}).status_code == 422
    # Without a mail server nothing is sent, and asking to send says so.
    before = len(world.anna.get("/api/spaces/Shared/members").json()["invites"])
    sent = world.anna.post("/api/spaces/Shared/invites", json={"role": "read", "email": "a@example.com", "send": True})
    assert sent.status_code == 502 and sent.json()["detail"]["code"] == "mail_off"
    # Nothing stays behind: its link was to go by mail only and would be lost (review P6.13).
    assert len(world.anna.get("/api/spaces/Shared/members").json()["invites"]) == before
    # Inviting into nexlore without a space is the operator's.
    assert world.anna.post("/api/invites", json={}).status_code == 403
    made = world.operator.post("/api/invites", json={"days": 30})
    assert made.status_code == 201 and made.json()["role"] == ""
    assert world.operator.post("/api/invites", json={"role": "read"}).status_code == 422
    # Withdrawing: the one who invited, a manager of the space, or the operator; nobody else learns it exists.
    shared = world.anna.post("/api/spaces/Shared/invites", json={"role": "read"}).json()["id"]
    assert world.bob.delete(f"/api/invites/{shared}").status_code == 404
    assert world.anna.delete(f"/api/invites/{shared}").status_code == 204


def test_a_new_space_belongs_to_whoever_makes_it(world: World) -> None:
    assert world.bob.post("/api/spaces", json={"name": "Bobs"}).json()["role"] == "manage"
    assert names(world.bob) == ["Bobs", "Shared"]
    assert "Bobs" not in names(world.operator)


def test_deleting_the_only_member_hands_the_space_to_the_operator(world: World) -> None:
    ids = {row["name"]: row["id"] for row in world.operator.get("/api/accounts").json()}
    gone = world.operator.request("DELETE", f"/api/accounts/{ids['anna']}", json={"current_password": PASSWORD})
    assert gone.status_code == 204
    assert "Private" in names(world.operator)


def test_an_operator_is_one_by_role_not_by_name(world: World) -> None:
    boss = make_account("boss", OPERATOR)
    other = person(boss, "boss")
    assert "Ops" in names(other) and "Private" not in names(other)


def test_a_deleted_space_comes_back_with_its_members(world: World) -> None:
    assert world.anna.delete("/api/files", params={"path": "Shared"}).json() == {"files": 1}
    assert "Shared" not in names(world.bob)
    # The name stays taken while the space is in the trash: its old members must not see a new one.
    refused = world.carl.post("/api/spaces", json={"name": "Shared"})
    assert refused.status_code == 409
    entry = world.anna.get("/api/trash").json()[0]["id"]
    assert world.anna.post(f"/api/trash/{entry}/restore").status_code == 200
    assert "Shared" in names(world.bob)


def test_a_new_space_under_an_old_name_has_only_its_maker(world: World) -> None:
    world.anna.delete("/api/files", params={"path": "Shared"})
    entry = world.anna.get("/api/trash").json()[0]["id"]
    assert world.anna.delete(f"/api/trash/{entry}").status_code == 200
    assert world.carl.post("/api/spaces", json={"name": "Shared"}).status_code == 201
    assert "Shared" not in names(world.bob) and "Shared" not in names(world.anna)
    members = world.carl.get("/api/spaces/Shared/members").json()["members"]
    assert [row["name"] for row in members] == ["carl"]


def test_creating_a_space_that_is_there_changes_no_rights(world: World) -> None:
    world.anna.post("/api/spaces", json={"name": "Empty"})
    join(world.anna, "Empty", "bob", "read")
    assert world.carl.post("/api/spaces", json={"name": "Empty"}).status_code == 409
    assert "Empty" in names(world.bob)


def test_inviting_into_the_operators_own_space_keeps_the_operator_in(world: World) -> None:
    token = world.operator.post("/api/spaces/Ops/invites", json={"role": "read"}).json()["link"].rsplit("/", 1)[1]
    assert world.bob.post(f"/api/invite/{token}/join").status_code == 200
    assert world.operator.get("/api/note", params={"path": "Ops/Runbook.md"}).status_code == 200
    roles = {row["name"]: row["role"] for row in world.operator.get("/api/spaces/Ops/members").json()["members"]}
    assert roles == {"bob": "read", "tester": "manage"}


def test_the_trash_of_a_space_one_only_reads_is_not_shown(world: World) -> None:
    world.carl.post("/api/notes", json={"folder": "Shared", "title": "Scrap"})
    world.carl.delete("/api/files", params={"path": "Shared/Scrap.md"})
    assert [entry["path"] for entry in world.carl.get("/api/trash").json()] == ["Shared/Scrap.md"]
    assert world.bob.get("/api/trash").json() == []


def test_the_brake_on_deletions_is_the_operators(world: World, vault: Path) -> None:
    from app.services import index

    index.status.held_back = {"Ops": 60}
    try:
        assert world.operator.get("/api/index").json()["held_back"] == {"Ops": 60}
        assert world.anna.get("/api/index").status_code == 403
        refused = world.anna.post("/api/index/scan", params={"confirm_deletions": "true"})
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "operator_only"
    finally:
        index.status.held_back = {}


def test_an_invitation_of_a_manager_who_lost_the_right_is_void(world: World) -> None:
    world.anna.put("/api/spaces/Shared/members/carl", json={"role": "manage"})
    link = world.carl.post("/api/spaces/Shared/invites", json={"role": "write"}).json()["link"]
    token = link.rsplit("/", 1)[1]
    world.anna.put("/api/spaces/Shared/members/carl", json={"role": "read"})
    assert world.bob.get(f"/api/invite/{token}").status_code == 404
    assert world.bob.post(f"/api/invite/{token}/join").status_code == 404


def test_an_invitation_is_used_once_even_at_the_same_moment(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading

    from app.services import accounts

    token = world.anna.post("/api/spaces/Shared/invites", json={"role": "manage"}).json()["link"].rsplit("/", 1)[1]
    both_found = threading.Barrier(2, timeout=10)
    found = accounts.find_invite

    def find_then_wait(db, token):  # type: ignore[no-untyped-def]
        invite = found(db, token)
        # Both requests hold a valid invitation before either uses it: the worst timing, every time.
        both_found.wait()
        return invite

    monkeypatch.setattr(accounts, "find_invite", find_then_wait)
    results: list[str] = []

    def take(name: str) -> None:
        with SessionLocal() as db:
            try:
                accounts.accept_invite(db, token, name, "a long enough password")
                results.append("ok")
            except accounts.AccountError as exc:
                results.append(exc.code)

    threads = [threading.Thread(target=take, args=(name,)) for name in ("racer-one", "racer-two")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["invite_invalid", "ok"]
    managers = [row["name"] for row in world.anna.get("/api/spaces/Shared/members").json()["members"]
                if row["role"] == "manage"]
    assert len([name for name in managers if name.startswith("racer")]) == 1


def test_the_index_tells_members_nothing_about_other_spaces(world: World) -> None:
    world.operator.post("/api/index/scan")
    status = world.bob.get("/api/index").json()
    assert "Private" not in str(status) and "Ops" not in str(status)
    assert world.bob.post("/api/index/scan").status_code == 403


def test_a_foreign_version_or_trash_entry_answers_like_a_missing_one(world: World) -> None:
    with SessionLocal() as db:
        version_id = db.scalar(select(Version.id).where(Version.path == "Private/Secret Plan.md"))
    world.anna.delete("/api/files", params={"path": "Private/Other.md"})
    entry = world.anna.get("/api/trash").json()[0]["id"]
    pairs = [
        (f"/api/versions/{version_id}", f"/api/versions/{version_id + 99999}", "get"),
        (f"/api/versions/{version_id}/restore", f"/api/versions/{version_id + 99999}/restore", "post"),
        (f"/api/trash/{entry}/restore", "/api/trash/f-999999/restore", "post"),
        (f"/api/trash/{entry}", "/api/trash/f-999999", "delete"),
    ]
    for foreign, missing, method in pairs:
        one = getattr(world.bob, method)(foreign)
        other = getattr(world.bob, method)(missing)
        assert one.status_code == other.status_code == 404, foreign
        assert one.json() == other.json(), foreign


def test_a_space_name_in_other_letters_is_not_a_way_in(world: World) -> None:
    for spelled in ("private", "PRIVATE", "pRivate"):
        foreign = world.operator.get("/api/folder", params={"path": spelled})
        missing = world.operator.get("/api/folder", params={"path": "Nowhere"})
        assert foreign.status_code == 404 and foreign.json() == missing.json(), spelled
        assert world.operator.get("/api/note", params={"path": f"{spelled}/Secret Plan.md"}).status_code == 404
