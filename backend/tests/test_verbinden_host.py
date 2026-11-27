"""nexlore as host of nexnotes over a connection made by a click (module verbinden, catalog: nexnotes → nexlore,
purpose ``notes.add``; Runde 2, Teil B): the token of the connection opens ``/api/v1`` to make a note and to see the
spaces it may make one in, only the spaces given, nothing else (403 ``purpose_missing``); its own switch counts, not the
one of API tokens; an account that rests lets it rest. As nexnotes sends it: ``GET /api/v1/spaces``, then
``POST /api/v1/notes`` with ``folder``, ``title`` and ``content``."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import MANAGE, READ, Account, Membership, Space, utcnow
from app.services import settings_service
from app.services.verbinden_store import CONFIG, VerbindenStore
from app.vendor import nexverbinden
from app.vendor.nexmcp import oauthcore

from .conftest import make_account, sign_in

TAB = {"X-Nexlore-Client": "tab-verbinden-host"}


def _space(vault: Path, account: Account, name: str, role: str = MANAGE) -> int:
    (vault / name).mkdir(parents=True, exist_ok=True)
    (vault / name / "Start.md").write_text(f"# {name}\n", encoding="utf-8")
    with SessionLocal() as db:
        space = db.query(Space).filter_by(folder=name).one_or_none()
        if space is None:
            space = Space(folder=name)
            db.add(space)
            db.flush()
        db.add(Membership(space_id=space.id, account_id=account.id, role=role))
        db.commit()
        return space.id


def _connect(account: Account, *, grants: tuple[str, ...] = ("notes.add",), areas: list[int] | None = None) -> str:
    """A connection with nexnotes as the module keeps it after the click and the consent; its access token."""
    token = CONFIG.access_prefix + secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    with SessionLocal() as db:
        store = VerbindenStore(db)
        store.save(nexverbinden.Connection(
            id=secrets.token_urlsafe(16), account_id=account.id, partner="nexnotes",
            partner_base="https://notes.example.com", partner_account="Kim", uses=(), grants=grants,
            areas_granted=areas, areas_used=None, held=store.seal("{}"),
            issued_access_hash=oauthcore.digest(token), issued_refresh_hash=oauthcore.digest(secrets.token_hex(8)),
            issued_access_expires=now + timedelta(hours=1), created_at=now))
        store.commit()
    return token


@pytest.fixture
def kim(client: TestClient, account: object, vault: Path) -> tuple[Account, dict[str, int]]:
    owner = make_account("kim")
    other = make_account("sam")
    spaces = {name: _space(vault, owner, name) for name in ("Wissen", "Arbeit")}
    spaces["Gelesen"] = _space(vault, owner, "Gelesen", READ)
    spaces["Fremd"] = _space(vault, other, "Fremd")
    from app.services import index

    index.scan()
    return owner, spaces


def program() -> TestClient:
    return TestClient(app, base_url="http://testserver")


def test_a_note_goes_into_a_space_given_and_nowhere_else(kim: tuple[Account, dict[str, int]], vault: Path) -> None:
    owner, spaces = kim
    token = _connect(owner, areas=[spaces["Wissen"]])
    auth = {"Authorization": f"Bearer {token}"}
    # API tokens are off on this server: the connection has its own switch.
    with SessionLocal() as db:
        assert not settings_service.get(db, "api_tokens_allowed")
    seen = program().get("/api/v1/spaces", headers=auth)
    assert seen.status_code == 200 and [space["name"] for space in seen.json()] == ["Wissen"]
    made = program().post("/api/v1/notes", headers=auth,
                          json={"folder": "Wissen", "title": "From nexnotes", "content": "- [ ] Milk\n"})
    assert made.status_code == 201, made.text
    assert made.json()["path"] == "Wissen/From nexnotes.md"
    assert (vault / "Wissen" / "From nexnotes.md").read_text(encoding="utf-8") == "- [ ] Milk\n"
    # A space not given is not there for it, one of another account neither.
    for folder in ("Arbeit", "Fremd"):
        refused = program().post("/api/v1/notes", headers=auth, json={"folder": folder, "title": "x", "content": "x"})
        assert refused.status_code == 404, (folder, refused.text)


def test_without_spaces_given_every_space_it_may_write_in(kim: tuple[Account, dict[str, int]]) -> None:
    owner, _spaces = kim
    token = _connect(owner, areas=None)
    auth = {"Authorization": f"Bearer {token}"}
    names = {space["name"] for space in program().get("/api/v1/spaces", headers=auth).json()}
    assert {"Wissen", "Arbeit"} <= names and "Fremd" not in names
    # The card offers only what a note can go into: the spaces the account writes in.
    with SessionLocal() as db:
        offered = [area["name"] for area in VerbindenStore(db).areas(owner.id)]
    assert offered == ["Arbeit", "Wissen"]
    refused = program().post("/api/v1/notes", headers=auth, json={"folder": "Gelesen", "title": "x", "content": "x"})
    assert refused.status_code == 403


def test_the_connection_opens_nothing_but_its_purpose(kim: tuple[Account, dict[str, int]]) -> None:
    owner, spaces = kim
    token = _connect(owner, areas=[spaces["Wissen"]])
    auth = {"Authorization": f"Bearer {token}"}
    for method, path in (("GET", "/api/v1/note?path=Wissen/Start.md"), ("GET", "/api/v1/search?q=Wissen"),
                         ("GET", "/api/v1/tasks"), ("GET", "/api/v1/dashboard"), ("POST", "/api/v1/inbox")):
        answer = program().request(method, path, headers=auth, json={"text": "x"} if method == "POST" else None)
        assert (answer.status_code, answer.json()["detail"]["code"]) == (403, "purpose_missing"), (method, path)
    # A connection that grants nothing here opens nothing either.
    nothing = _connect(owner, grants=())
    answer = program().post("/api/v1/notes", headers={"Authorization": f"Bearer {nothing}"},
                            json={"folder": "Wissen", "title": "x", "content": "x"})
    assert (answer.status_code, answer.json()["detail"]["code"]) == (403, "purpose_missing")
    # A web page is refused before anything else.
    page = program().get("/api/v1/spaces", headers={**auth, "Origin": "https://evil.example.com"})
    assert page.status_code == 403


def test_its_own_switch_and_a_resting_account_close_it(kim: tuple[Account, dict[str, int]], client: TestClient) -> None:
    owner, spaces = kim
    token = _connect(owner, areas=[spaces["Wissen"]])
    auth = {"Authorization": f"Bearer {token}"}
    assert client.put("/api/connect/admin", json={"connections": False}, headers=TAB).status_code == 200
    answer = program().get("/api/v1/spaces", headers=auth)
    assert (answer.status_code, answer.json()["detail"]["code"]) == (403, "connections_off")
    assert client.put("/api/connect/admin", json={"connections": True}, headers=TAB).status_code == 200
    with SessionLocal() as db:
        row = db.get(Account, owner.id)
        assert row is not None
        row.blocked_at = utcnow()
        db.commit()
    answer = program().get("/api/v1/spaces", headers=auth)
    assert (answer.status_code, answer.json()["detail"]["code"]) == (401, "account_resting")
    # A token that is not one stays out.
    assert program().get("/api/v1/spaces", headers={"Authorization": "Bearer nxv_nothing"}).status_code == 401


def test_only_nexnotes_has_a_card(kim: tuple[Account, dict[str, int]]) -> None:
    """V20: nexlore grants notes.add to nexnotes and uses no other app: one card, and no start for another partner."""
    owner, _spaces = kim
    browser = TestClient(app, base_url="http://testserver", headers=TAB)
    sign_in(browser, owner)
    cards = browser.get("/api/connect/partners").json()
    assert [card["partner"] for card in cards] == ["nexnotes"]
    assert cards[0]["grants"] == ["notes.add"] and cards[0]["uses"] == []
    for other in ("nextasks", "nextime", "nexmail"):
        # Since verbinden 0.1.8 (V42) the start takes no address: the operator's or a connection's.
        started = browser.post(f"/api/connect/partners/{other}/start", json={})
        assert started.status_code == 404, other


def test_the_consent_page_shows_the_account_as_its_profile_does(kim: tuple[Account, dict[str, int]]) -> None:
    """verbinden 0.1.8 (B1, V43): ``account_card`` gives the shown name, the user name and the own picture at the
    address nexlore's pages load it from (``Avatar.tsx``); the other app names the account by its user name."""
    owner, _spaces = kim
    with SessionLocal() as db:
        store = VerbindenStore(db)
        assert store.account_card(owner.id) == {"name": "", "username": "kim", "picture": None, "color": None}
        row = db.get(Account, owner.id)
        assert row is not None
        row.display_name = "Kim Example"
        row.avatar_at = datetime(2026, 11, 27, 8, 0, tzinfo=UTC)
        db.commit()
        card = store.account_card(owner.id)
        assert card is not None
        assert (card["name"], card["username"], card["color"]) == ("Kim Example", "kim", None)
        assert card["picture"] == f"/api/avatars/{owner.id}?v=2026-11-27T08%3A00%3A00%2B00%3A00"
        assert store.account_name(owner.id) == "kim"
        assert store.account_card(999999) is None
    # What the consent page gets: the module keeps the picture, a shown name equal to the user name says nothing.
    with SessionLocal() as db:
        shown = nexverbinden.connect.account_card(VerbindenStore(db), owner.id)
    assert shown["name"] == "Kim Example" and shown["picture"].startswith(f"/api/avatars/{owner.id}?v=")
    # The same address the profile builds from ``/api/auth/me`` (``encodeURIComponent`` of ``avatar``).
    browser = TestClient(app, base_url="http://testserver", headers=TAB)
    sign_in(browser, owner)
    me = browser.get("/api/auth/me").json()
    assert shown["picture"] == f"/api/avatars/{me['id']}?v={quote(me['avatar'], safe='')}"
