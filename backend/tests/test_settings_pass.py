"""The settings pass (plan "Einstellungen", konten 1.1.0, post 1.1.0): what nexlore does with the shared modules beyond
their contract tests. The storage limit and the right to AI per account, deleting with 30 days to bring back, the
sign-in switches with their rules on the old way and the new one, "Ready for the internet?", the one-time migration of
an older database, notifications as letters of the post module in the account's language."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app.db import SessionLocal, engine
from app.main import _purge_deleted_accounts, app
from app.models import OPERATOR, Account
from app.models_accounts import FormerName
from app.services import ai, konten_wanderung, notify, settings_service
from app.vendor import nexpost
from app.vendor.nexpost import testing

from .conftest import PASSWORD, make_account, sign_in
from .test_profile import person

TAB = {"X-Nexlore-Client": "tab-tests000"}
MB = 1024 * 1024


def row_of(name: str) -> Account:
    with SessionLocal() as db:
        row = db.scalar(select(Account).where(Account.name == name))
        assert row is not None
        db.expunge(row)
        return row


# --- The migration to 1.1.0 ------------------------------------------------------------------------------------------


def test_the_migration_gives_every_account_the_servers_limit_keeps_the_dark_look_and_proves_addresses() -> None:
    """E23, E24: the server's ``quota_mb`` of before becomes every account's own limit, an account that never chose
    light or dark keeps the dark look of 1.16.0, an address that counts needs no link."""
    with SessionLocal() as db:
        settings_service.save(db, {"quota_mb": 5})
        db.add(Account(name="kim", email="kim@example.com", email_confirmed=True, email_proven=False))
        db.add(Account(name="lea", appearance={"mode": "light", "size": 18}))
        db.commit()
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM settings WHERE key = :key"), {"key": konten_wanderung.SETTING_110})
        connection.execute(text("UPDATE accounts SET storage_limit = NULL"))
        konten_wanderung._once_110(connection)
    kim, lea = row_of("kim"), row_of("lea")
    assert kim.storage_limit == lea.storage_limit == 5 * MB
    assert kim.appearance == {"mode": "dark"} and lea.appearance == {"mode": "light", "size": 18}
    assert kim.email_proven is True and kim.ai_allowed is True
    # Once: a second start changes nothing the operator set since.
    with SessionLocal() as db:
        db.scalar(select(Account).where(Account.name == "kim")).storage_limit = None  # type: ignore[union-attr]
        db.commit()
    with engine.begin() as connection:
        konten_wanderung._once_110(connection)
    assert row_of("kim").storage_limit is None


def test_a_new_account_starts_with_the_servers_limit_and_as_the_system() -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"quota_mb": 3})
    make_account("newcomer")
    assert row_of("newcomer").storage_limit == 3 * MB
    assert row_of("newcomer").appearance is None
    with SessionLocal() as db:
        settings_service.save(db, {"quota_mb": 0})
    assert row_of(make_account("unlimited").name).storage_limit is None


# --- Accounts: the operator's functions -----------------------------------------------------------------------------


def test_the_storage_limit_and_the_right_to_ai_are_per_account(client: TestClient, operator: Account) -> None:
    anna = person("anna")
    anna_id = row_of("anna").id
    answer = client.put(f"/api/accounts/{anna_id}/storage-limit", json={"limit": 2 * MB, "current_password": "no"})
    assert answer.status_code == 401
    answer = client.put(f"/api/accounts/{anna_id}/storage-limit", json={"limit": 2 * MB, "current_password": PASSWORD})
    assert answer.status_code == 200 and answer.json()["storage_limit"] == 2 * MB
    assert anna.get("/api/attachments/usage").json()["quota"] == 2 * MB
    # The operator's main switch on: AI for anna, until her right goes.
    with SessionLocal() as db:
        settings_service.save(db, {"ai_allowed": True})
        assert ai.allowed_for(db, db.get(Account, anna_id)) is True  # type: ignore[arg-type]
    taken = client.put(f"/api/accounts/{anna_id}/right", json={"right": "ai", "allowed": False})
    assert taken.status_code == 200 and taken.json()["ai_allowed"] is False
    with SessionLocal() as db:
        assert ai.allowed_for(db, db.get(Account, anna_id)) is False  # type: ignore[arg-type]
    assert anna.get("/api/ai").json()["allowed"] is False
    # The main switch stays the main one: off, nobody, whatever the right.
    client.put(f"/api/accounts/{anna_id}/right", json={"right": "ai", "allowed": True})
    with SessionLocal() as db:
        settings_service.save(db, {"ai_allowed": False})
        assert ai.allowed_for(db, db.get(Account, anna_id)) is False  # type: ignore[arg-type]
    # A member does none of this.
    assert anna.put(f"/api/accounts/{anna_id}/right", json={"right": "ai", "allowed": True}).status_code == 403


def test_deleting_keeps_the_account_thirty_days_then_it_goes_and_its_name_stays(
    client: TestClient, operator: Account
) -> None:
    anna = person("anna")
    anna_id = row_of("anna").id
    confirm = {"current_password": PASSWORD}
    assert client.request("DELETE", f"/api/accounts/{anna_id}", json=confirm).status_code == 204
    # Gone for everybody at once: her session counts for nothing.
    assert anna.get("/api/auth/me").status_code == 401
    listed = {entry["id"]: entry for entry in client.get("/api/accounts").json()}
    assert listed[anna_id]["deleted"] is True and listed[anna_id]["purge_at"]
    back = client.post(f"/api/accounts/{anna_id}/restore", json=confirm)
    assert back.status_code == 200 and back.json()["deleted"] is False
    assert client.request("DELETE", f"/api/accounts/{anna_id}", json=confirm).status_code == 204
    with SessionLocal() as db:
        db.get(Account, anna_id).deleted_at -= timedelta(days=31)  # type: ignore[union-attr, operator]
        db.commit()
    _purge_deleted_accounts()
    with SessionLocal() as db:
        assert db.get(Account, anna_id) is None
        assert db.scalar(select(FormerName).where(FormerName.name == "anna")) is not None
    assert client.post(f"/api/accounts/{anna_id}/restore", json=confirm).status_code == 404


def test_several_operators_but_never_the_last(client: TestClient, operator: Account) -> None:
    person("anna")
    anna_id = row_of("anna").id
    made = client.put(f"/api/accounts/{anna_id}/role", json={"role": OPERATOR, "current_password": PASSWORD})
    assert made.status_code == 200 and made.json()["role"] == OPERATOR
    assert row_of("tester").role == OPERATOR
    own = client.put(f"/api/accounts/{operator.id}/role", json={"role": "member", "current_password": PASSWORD})
    assert own.status_code == 409 and own.json()["detail"]["code"] == "cannot_demote_self"


# --- Server › Sign-in ---------------------------------------------------------------------------------------------------


def test_the_second_factor_for_everybody_goes_off_only_with_the_password_on_both_ways(
    client: TestClient, operator: Account
) -> None:
    from app.services import totp

    with SessionLocal() as db:
        db.get(Account, operator.id).totp_secret_enc = totp.seal_seed(totp.generate_seed())  # type: ignore[union-attr]
        db.commit()
        settings_service.save(db, {"two_factor_required": True})
    refused = client.put("/api/server/sign-in", json={"factor_required": False})
    assert refused.status_code == 401
    refused = client.put("/api/settings", json={"two_factor_required": False})
    assert refused.status_code == 401
    assert client.get("/api/server/sign-in").json()["factor_required"] is True
    done = client.put("/api/settings", json={"two_factor_required": False, "current_password": PASSWORD})
    assert done.status_code == 200 and done.json()["two_factor_required"] is False
    # On again only with a factor of one's own.
    with SessionLocal() as db:
        db.get(Account, operator.id).totp_secret_enc = ""  # type: ignore[union-attr]
        db.commit()
    on = client.put("/api/server/sign-in", json={"factor_required": True})
    assert on.status_code == 409 and on.json()["detail"]["code"] == "own_second_factor_first"


def test_the_passkey_switch_saves_on_the_old_way_too(client: TestClient, operator: Account) -> None:
    """1.16.0's page sent ``passkeys_allowed`` to ``PUT /api/settings``, which dropped it."""
    assert client.put("/api/settings", json={"passkeys_allowed": False}).json()["passkeys_allowed"] is False
    assert client.get("/api/server/sign-in").json()["passkeys_allowed"] is False


def test_ready_for_the_internet_is_the_operators(client: TestClient, operator: Account) -> None:
    found = client.get("/api/server/sign-in/readiness").json()
    assert [point["key"] for point in found["points"]][:3] == ["address", "factorForAll", "ownAccount"]
    assert person("anna").get("/api/server/sign-in/readiness").status_code == 403


# --- Mail through post ------------------------------------------------------------------------------------------------


def test_a_notification_mail_is_a_letter_of_post_in_the_accounts_language(client: TestClient, operator: Account) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "smtp.example.com", "smtp_from": "lore@example.com",
                                   "public_url": "https://lore.example.com"})
        row = db.get(Account, operator.id)
        assert row is not None
        row.email, row.language, row.notify = "tester@example.com", "de", {"email": True}
        db.commit()
    with testing.catch_mail() as caught:
        notify.deliver(operator.id, "operator", notify.words("disk_low"), "/settings/storage")
    [letter] = caught.queued
    assert letter.to == "tester@example.com" and letter.subject == "Die Platte von nexlore läuft voll"
    assert ("Content-Language", "de") in letter.headers and "cid:logo" in letter.html
    assert "https://lore.example.com/settings/storage" in letter.text
    with SessionLocal() as db:
        waiting = db.execute(text("SELECT letter FROM mail_outbox")).scalars().all()
    assert [json.loads(entry)["subject"] for entry in waiting] == ["Die Platte von nexlore läuft voll"]


def test_a_letter_with_a_key_goes_into_the_outbox_once() -> None:
    from app.services.post_store import PostStore

    letter = nexpost.app_letters.write("kim@example.com", kind="notify.tasks", subject="Tasks", paragraphs=["x"],
                                       key="tasks:1:2026-11-26")
    with SessionLocal() as db:
        store = PostStore(db)
        first = nexpost.outbox.queue(store, letter)
        second = nexpost.outbox.queue(store, letter)
        db.commit()
        assert first == second and store.waiting() == 1


def test_the_test_mail_of_the_settings_goes_through_post(client: TestClient, operator: Account) -> None:
    """Both ways (the old ``/api/settings/mail-test`` and the module's ``/api/server/mail/test``) send the module's
    test mail with nexlore's logo, in the language asked for."""
    sent: list[object] = []

    class Server:
        def send_message(self, message: object) -> None:
            sent.append(message)

        def quit(self) -> None:
            pass

        def close(self) -> None:
            pass

    client.put("/api/settings", json={"smtp_host": "smtp.example.com", "smtp_from": "lore@example.com"})
    nexpost.use_smtp(lambda _settings, _timeout, _context: Server())
    try:
        assert client.post("/api/settings/mail-test", json={"to": "dora@example.com"}).status_code == 204
        assert client.post("/api/server/mail/test", json={"to": "dora@example.com", "language": "de"}).status_code == 204
    finally:
        nexpost.use_smtp(None)
    assert len(sent) == 2
    assert [message["Content-Language"] for message in sent] == ["en", "de"]  # type: ignore[index]
    assert all("image/png" in str(message) for message in sent)


@pytest.mark.parametrize("path", ["/api/server/mail", "/api/server/sign-in", "/api/server/storage"])
def test_the_new_ways_are_the_operators(path: str) -> None:
    anonymous = TestClient(app, base_url="http://testserver", headers=TAB)
    assert anonymous.get(path).status_code == 401
    member = TestClient(app, base_url="http://testserver", headers=TAB)
    sign_in(member, make_account("member"))
    assert member.get(path).status_code == 403


# --- The old ways of the keys run through the key module -------------------------------------------------------------


def test_the_old_key_ways_answer_as_before_through_the_key_module(client: TestClient, operator: Account) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"api_tokens_allowed": True, "mcp_allowed": True, "mcp_max_level": "read"})
    anna = person("anna")
    made = anna.post("/api/api-tokens", json={"name": "  ", "level": "read"})
    assert made.status_code == 201
    token = made.json()["token"]
    # The old fallback name, the old form; and it is the module's key api-<row>.
    assert token["name"] == "API" and token["spaces"] is None and made.json()["secret"].startswith("nxa_")
    assert f"api-{token['id']}" in [key["id"] for key in anna.get("/api/connections/keys").json()["keys"]]
    refused = anna.post("/api/api-tokens", json={"name": "Few", "level": "read", "spaces": []})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "invalid_input"
    assert refused.json()["detail"]["message"] == "Choose spaces you may read."
    days = anna.post("/api/api-tokens", json={"name": "Odd", "level": "read", "days": 7})
    assert days.status_code == 422 and days.json()["detail"]["code"] == "invalid_input"
    # The MCP key above the operator's ceiling: the old code.
    high = anna.post("/api/mcp/keys", json={"name": "High", "level": "write"})
    assert high.status_code == 403 and high.json()["detail"]["code"] == "level_not_allowed"
    low = anna.post("/api/mcp/keys", json={"name": "Low", "level": "read"})
    assert low.status_code == 201 and low.json()["token"].startswith("nxl_")
    assert [key["name"] for key in anna.get("/api/mcp/keys").json()["keys"]] == ["Low"]
    # The operator blocks on the old way and unblocks on the module's: the old list follows.
    assert client.post(f"/api/admin/api-tokens/{token['id']}/block").json()["blocked"] is True
    assert client.post(f"/api/connections/admin/keys/api-{token['id']}/unblock").status_code == 200
    listed = [row for row in client.get("/api/admin/api-tokens").json() if row["id"] == token["id"]]
    assert listed and listed[0]["blocked"] is False and listed[0]["account"] == "anna"
    # The operator sees no start of a key (schluessel E36): the old field holds the bare prefix.
    assert listed[0]["prefix"] == "nxa_"
    # Revoking twice: the second answers as the old way did.
    assert anna.delete(f"/api/api-tokens/{token['id']}").status_code == 204
    again = anna.delete(f"/api/api-tokens/{token['id']}")
    assert again.status_code == 404 and again.json()["detail"]["code"] == "not_found"
    assert anna.delete(f"/api/mcp/keys/{low.json()['key']['id']}").status_code == 204
    assert anna.get("/api/mcp/keys").json()["keys"] == []


def test_a_deleted_account_keeps_its_memberships_out_of_sight_until_it_comes_back(
    client: TestClient, operator: Account
) -> None:
    from app.models import MANAGE, Membership, Space
    from app.services import comments

    assert client.post("/api/spaces", json={"name": "Team"}).status_code == 201
    person("anna")
    anna_id = row_of("anna").id
    with SessionLocal() as db:
        space_id = db.scalar(select(Space.id).where(Space.folder == "Team"))
        db.add(Membership(space_id=space_id, account_id=anna_id, role=MANAGE))
        db.commit()

    def shown() -> list[str]:
        return [entry["name"] for entry in client.get("/api/spaces/Team/members").json()["members"]]

    def offered() -> list[str]:
        with SessionLocal() as db:
            return comments.people(db, space_id, "")  # type: ignore[arg-type]

    assert "anna" in shown() and "anna" in offered()
    confirm = {"current_password": PASSWORD}
    assert client.request("DELETE", f"/api/accounts/{anna_id}", json=confirm).status_code == 204
    # Out of sight, offered for nobody's @, not to be given a right or taken out; the membership waits.
    assert "anna" not in shown() and "anna" not in offered()
    given = client.put("/api/spaces/Team/members/anna", json={"role": "read"})
    assert given.status_code == 202 and given.json()["invited"] is True
    assert client.delete("/api/spaces/Team/members/anna").status_code == 404
    with SessionLocal() as db:
        assert db.get(Membership, (space_id, anna_id)).role == MANAGE  # type: ignore[union-attr]
    # Brought back: there again, with its right.
    assert client.post(f"/api/accounts/{anna_id}/restore", json=confirm).status_code == 200
    assert "anna" in shown()
    # Gone for good: the memberships go with it.
    assert client.request("DELETE", f"/api/accounts/{anna_id}", json=confirm).status_code == 204
    with SessionLocal() as db:
        db.get(Account, anna_id).deleted_at -= timedelta(days=31)  # type: ignore[union-attr, operator]
        db.commit()
    _purge_deleted_accounts()
    with SessionLocal() as db:
        assert db.get(Membership, (space_id, anna_id)) is None


def test_nothing_goes_out_to_an_account_while_it_is_out(client: TestClient, operator: Account,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[str] = []
    monkeypatch.setattr(notify, "_post", lambda url, body: sent.append(url) or 200)
    person("anna")
    anna_id = row_of("anna").id
    with SessionLocal() as db:
        notify.set_webhook(db.get(Account, anna_id), "https://hooks.example.com/anna")  # type: ignore[arg-type]
        db.commit()
    said = notify.words("test")
    assert notify.deliver(anna_id, "test", said) == {"webhook": "ok"} and len(sent) == 1
    confirm = {"current_password": PASSWORD}
    assert client.post(f"/api/accounts/{anna_id}/block", json=confirm).status_code in (200, 204)
    # Handed on before the block, delivered after it: nothing goes, the webhook stays for its return.
    assert notify.deliver(anna_id, "test", said) == {} and len(sent) == 1
    with SessionLocal() as db:
        assert notify.webhook_of(db.get(Account, anna_id)) == "https://hooks.example.com/anna"  # type: ignore[arg-type]
    assert client.post(f"/api/accounts/{anna_id}/unblock", json=confirm).status_code in (200, 204)
    assert notify.deliver(anna_id, "test", said) == {"webhook": "ok"} and len(sent) == 2
