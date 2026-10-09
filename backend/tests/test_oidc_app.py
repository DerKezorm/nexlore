"""nexlore's own side of sign-in through providers, around the shared contract tests (``tests/nexoidc``): the
migration from the single provider of 1.5, the buttons of the sign-in page, the operator's account list, the code
step after a provider that is not trusted with the second factor, invitations into a space, and the log.
"""

from __future__ import annotations

import logging
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import OPERATOR, SIGN_IN_OIDC, WRITE, Account, Membership, OidcLink, OidcProvider, Space
from app.routers.auth import PENDING_COOKIE
from app.security import encrypt_secret, hash_password
from app.services import accounts, backups, logs, oidc_store, settings_service, totp, vault

from .conftest import PASSWORD, make_account, sign_in
from .oidc_helpers import UI, FakeProvider, add_provider, error_in, fresh_browser, link, location, sign_in_via_oidc

AUTHENTIK_ISSUER = "https://sso.example.com/application/o/nexlore/"


def _legacy(fake: FakeProvider, *, label: str, issuer: str | None = None, auto_create: bool = False,
            subjects: dict[str, str] | None = None) -> None:
    """nexlore 1.5.2 as it kept its one provider: in the settings, the subject at the account."""
    with SessionLocal() as db:
        settings_service.save(db, {
            "oidc_issuer": issuer or fake.issuer,
            "oidc_client_id": fake.client_id,
            "oidc_client_secret_enc": encrypt_secret(fake.client_secret),
            "oidc_provider_name": label,
            "oidc_auto_create": auto_create,
            oidc_store.MIGRATED: False,
        })
        for name, subject in (subjects or {}).items():
            row = accounts.by_name(db, name)
            assert row is not None
            row.oidc_subject = subject
        db.commit()


def _entries() -> list[OidcProvider]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(OidcProvider).order_by(OidcProvider.id)))
        for row in rows:
            db.expunge(row)
        return rows


# --- The migration --------------------------------------------------------------------------------------------------


def test_the_migration_makes_a_backup_first_and_keeps_name_auto_create_and_every_link(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    make_account("ben")
    _legacy(provider, label="Company", auto_create=True, subjects={"anna": "anna-1", "ben": "ben-1"})
    before = len(backups.entries())
    entry = oidc_store.migrate_settings()
    assert entry is not None and len(backups.entries()) == before + 1
    assert backups.entries()[0].kind == backups.UPDATE
    [row] = _entries()
    assert (row.slug, row.label, row.auto_create, row.trusts_second_factor, row.managed, row.enabled) == (
        "oidc", "Company", True, True, "", True)
    with SessionLocal() as db:
        links = sorted((link.subject, link.issuer) for link in db.scalars(select(OidcLink)))
    assert links == [("anna-1", provider.issuer.rstrip("/")), ("ben-1", provider.issuer.rstrip("/"))]
    # The secret came over, sealed for the entry now.
    with SessionLocal() as db:
        assert oidc_store.SqlStore(db).provider_by_slug("oidc").client_secret == provider.client_secret
    # A second start does nothing, no second backup either.
    assert oidc_store.migrate_settings() is None and len(backups.entries()) == before + 1
    # The old address still signs anna in.
    provider.person = {"sub": "anna-1", "preferred_username": "anna"}
    browser = fresh_browser()
    target = location(browser.get("/api/oidc/oidc/start"))
    assert "%2Fapi%2Foidc%2Fcallback" in target
    assert location(browser.get("/api/oidc/callback", params=provider.authorize(target))) == "/"
    assert browser.get("/api/auth/me").json()["name"] == "anna"


def test_removing_every_entry_after_the_migration_brings_the_old_provider_back_never(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    _legacy(provider, label="Company")
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    assert client.delete(f"/api/oidc/admin/providers/{entry.id}", headers=UI).status_code == 200
    assert oidc_store.migrate_settings(backup=False) is None and _entries() == []


def test_the_button_of_1_5_becomes_an_entry_the_button_looks_after_and_keeps_its_address(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    _legacy(provider, label="authentik", issuer=AUTHENTIK_ISSUER)
    oidc_store.migrate_settings(backup=False)
    [row] = _entries()
    assert (row.slug, row.managed, row.issuer, row.redirect_path) == (
        "oidc", "authentik", AUTHENTIK_ISSUER.rstrip("/"), "")
    view = client.get("/api/oidc/admin/providers").json()[0]
    assert view["redirect_uri"] == "http://testserver/api/oidc/callback"
    # A provider named so by hand, with another issuer, is the operator's own.
    with SessionLocal() as db:
        db.query(OidcProvider).delete()
        db.commit()
    _legacy(provider, label="authentik")
    oidc_store.migrate_settings(backup=False)
    assert _entries()[0].managed == ""


def test_without_a_provider_in_the_settings_nothing_is_made(client: TestClient, operator: Account) -> None:
    assert oidc_store.migrate_settings(backup=False) is None and _entries() == []
    with SessionLocal() as db:
        assert settings_service.get(db, oidc_store.MIGRATED) is True


# --- The buttons and the operator's list ---------------------------------------------------------------------------


def test_the_sign_in_page_learns_the_active_providers_in_their_order_and_nothing_else(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    first = add_provider(client, provider, slug="sso", label="SSO")
    second = add_provider(client, provider, slug="work", label="Work")
    assert fresh_browser().get("/api/auth/methods").json() == {
        "password": True, "providers": [{"slug": "sso", "label": "SSO"}, {"slug": "work", "label": "Work"}]}
    client.put("/api/oidc/admin/providers/order", json={"ids": [second["id"], first["id"]]}, headers=UI)
    body = {key: first[key] for key in ("label", "issuer", "client_id", "scopes", "auto_create",
                                         "trusts_second_factor")}
    assert client.put(f"/api/oidc/admin/providers/{first['id']}", json={**body, "enabled": False},
                      headers=UI).status_code == 200
    assert fresh_browser().get("/api/oidc/providers").json() == [{"slug": "work", "label": "Work"}]
    assert "client_secret" not in str(client.get("/api/oidc/admin/providers").json())


def test_password_sign_in_can_go_off_only_with_an_active_provider_and_members_then_come_through_it(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    refused = client.put("/api/settings", json={"password_login": False})
    assert refused.json()["detail"]["code"] == "provider_first"
    add_provider(client, provider)
    assert client.put("/api/settings", json={"password_login": False}).status_code == 200
    make_account("anna")
    anna = fresh_browser()
    assert anna.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 403
    member = fresh_browser()
    sign_in(member, accounts_row("anna"))
    assert location(link(member, provider, PASSWORD, sub="anna-1")) == "/account?linked=sso"
    browser = fresh_browser()
    assert location(sign_in_via_oidc(browser, provider, sub="anna-1")) == "/"
    assert browser.get("/api/auth/me").json()["name"] == "anna"


def accounts_row(name: str) -> Account:
    with SessionLocal() as db:
        row = accounts.by_name(db, name)
        assert row is not None
        db.expunge(row)
        return row


def test_the_account_list_shows_each_accounts_providers_and_the_operator_unlinks_with_the_own_password(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    entry = add_provider(client, provider, label="SSO")
    make_account("anna")
    member = fresh_browser()
    sign_in(member, accounts_row("anna"))
    link(member, provider, PASSWORD, sub="anna-1")
    listed = {row["name"]: row for row in client.get("/api/accounts").json()}
    assert listed["anna"]["providers"] == [{"id": entry["id"], "slug": "sso", "label": "SSO"}]
    assert listed["tester"]["providers"] == []
    anna_id = listed["anna"]["id"]
    address = f"/api/oidc/admin/accounts/{anna_id}/links/{entry['id']}"
    wrong = client.request("DELETE", address, json={"current_password": "not it"}, headers=UI)
    assert wrong.status_code == 401
    assert client.request("DELETE", address, json={"current_password": PASSWORD}, headers=UI).status_code == 204
    assert client.get("/api/accounts").json()[1]["providers"] == []
    gone = client.request("DELETE", address, json={"current_password": PASSWORD}, headers=UI)
    assert gone.status_code == 404


def test_the_operator_cannot_take_the_last_link_of_an_account_without_a_password(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    entry = add_provider(client, provider, auto_create=True)
    sign_in_via_oidc(fresh_browser(), provider, sub="clara-1", preferred_username="clara")
    clara = accounts_row("clara")
    assert clara.sign_in == SIGN_IN_OIDC
    refused = client.request("DELETE", f"/api/oidc/admin/accounts/{clara.id}/links/{entry['id']}",
                             json={"current_password": PASSWORD}, headers=UI)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "oidc_only_account"


def test_an_account_without_a_password_cannot_start_a_link(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=True)
    browser = fresh_browser()
    sign_in_via_oidc(browser, provider, sub="clara-1", preferred_username="clara")
    refused = browser.post("/api/oidc/sso/link", json={"password": "anything at all"}, headers=UI)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "oidc_only_account"


def test_my_providers_say_which_are_linked(client: TestClient, operator: Account, provider: FakeProvider) -> None:
    add_provider(client, provider, slug="sso", label="SSO")
    add_provider(client, provider, slug="work", label="Work")
    make_account("anna")
    member = fresh_browser()
    sign_in(member, accounts_row("anna"))
    link(member, provider, PASSWORD, sub="anna-1", slug="work")
    assert member.get("/api/oidc/me").json() == [
        {"slug": "sso", "label": "SSO", "linked": False}, {"slug": "work", "label": "Work", "linked": True}]


# --- The second factor after a provider that is not trusted with it --------------------------------------------------


def test_the_code_step_of_the_sign_in_page_finishes_a_sign_in_through_an_untrusted_provider(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, trusts_second_factor=False)
    seed = totp.generate_seed()
    with SessionLocal() as db:
        db.add(Account(name="anna", role="member", password_hash=hash_password(PASSWORD),
                       totp_secret_enc=totp.seal_seed(seed)))
        db.commit()
    member = fresh_browser()
    member.post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
    member.post("/api/auth/login/totp", json={"code": totp.code_at(seed, time.time())})
    assert location(link(member, provider, PASSWORD, sub="anna-1")) == "/account?linked=sso"
    browser = fresh_browser()
    back = sign_in_via_oidc(browser, provider, sub="anna-1")
    assert location(back) == "/login?step=code" and browser.get("/api/auth/me").status_code == 401
    assert browser.cookies.get(PENDING_COOKIE)
    wrong = browser.post("/api/auth/login/totp", json={"code": "000000"})
    assert wrong.status_code == 401
    done = browser.post("/api/auth/login/totp", json={"code": totp.code_at(seed, time.time() + 30)})
    assert done.status_code == 200 and browser.get("/api/auth/me").json()["name"] == "anna"


# --- Invitations into a space ----------------------------------------------------------------------------------------


def test_an_invitation_through_the_provider_brings_the_right_in_its_space_and_the_inviter_stays_manager(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider)
    vault.create_space("Team")
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == "Team"))
        assert space is not None
        inviter = db.get(Account, operator.id)
        _invite, token = accounts.create_invite(db, inviter, space_id=space.id, space_role=WRITE, days=7)
        space_id = space.id
    browser = fresh_browser()
    back = sign_in_via_oidc(browser, provider, invite=token, sub="dora-1", preferred_username="dora")
    assert location(back) == "/" and browser.get("/api/auth/me").json()["name"] == "dora"
    with SessionLocal() as db:
        roles = {db.get(Account, row.account_id).name: row.role
                 for row in db.scalars(select(Membership).where(Membership.space_id == space_id))}
    assert roles == {"dora": WRITE, "tester": "manage"}
    # Used up: the next one with the same link does not even get to the provider.
    again = fresh_browser().get("/api/oidc/sso/start", params={"invite": token})
    assert error_in(again) == "invite_invalid"


def test_a_new_account_through_a_provider_gets_a_clean_unique_name(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=True)
    make_account("max", OPERATOR)
    sign_in_via_oidc(fresh_browser(), provider, sub="m-1", preferred_username="Max@example.com")
    sign_in_via_oidc(fresh_browser(), provider, sub="m-2", preferred_username="", name="", email="")
    with SessionLocal() as db:
        names = set(db.scalars(select(Account.name)))
    assert {"max-2", "user"} <= names


@pytest.mark.parametrize("raw", ["a" * 80 + "-2", "Ä Ö", "x", "--", "max.mustermann"])
def test_names_from_a_provider_follow_the_rules_of_nexlore(raw: str) -> None:
    cleaned = oidc_store.clean_name(raw)
    assert cleaned == "" or accounts.NAME_PATTERN.match(cleaned)
    assert len(cleaned) <= 64
    if raw.endswith("-2"):
        assert cleaned.endswith("-2")


# --- The log ------------------------------------------------------------------------------------------------------


def test_no_secret_and_no_invitation_leaves_a_trace_in_the_log(
    client: TestClient, operator: Account, provider: FakeProvider, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        add_provider(client, provider, auto_create=True)
        browser = fresh_browser()
        target = location(browser.get("/api/oidc/sso/start"))
        params = provider.authorize(target)
        browser.get("/api/oidc/sso/callback", params=params)
    session = browser.cookies.get("nexlore_session")
    assert session
    for secret in (provider.client_secret, params["state"], params["code"], session):
        assert secret not in caplog.text
    for line in ("GET /api/oidc/sso/start?invite=AbCdEfGhIjKlMnOp12 -> 303",
                 "GET /api/oidc/sso/callback?code=abc123def&state=zzz999 -> 303"):
        for kept_out in ("AbCdEfGhIjKlMnOp12", "abc123def", "zzz999"):
            assert kept_out not in logs.redact(line)


def test_the_button_pressed_again_after_the_migration_keeps_the_old_address_the_entry_and_its_links(
    client: TestClient, operator: Account
) -> None:
    """Blueprint 01 "Umstieg" 3: the entry ``oidc`` keeps ``/api/oidc/callback`` when the operator presses the
    authentik button again; the provider is its own (found by its client id), so no link is dropped."""
    from app.vendor import nexoidc as module

    from .oidc_helpers import fakes

    network = fakes.Network()
    ak = network.add(fakes.FakeAuthentik())
    made = ak.add_provider("nexlore", "http://testserver/api/oidc/callback", slug="nexlore")
    issuer = f"{ak.base}/application/o/nexlore/"
    signer = ak.sign_in_with(issuer, made["client_id"], made["client_secret"])
    module.use_transport(network.transport())
    try:
        make_account("anna")
        _legacy(signer, label="authentik", issuer=issuer, subjects={"anna": "anna-1"})
        oidc_store.migrate_settings(backup=False)
        result = client.post("/api/oidc/authentik/setup", json={"url": ak.base, "token": ak.token}, headers=UI).json()
        assert result["ok"] and result["links_dropped"] == 0, result
        [row] = _entries()
        assert (row.slug, row.managed, row.redirect_path) == ("oidc", "authentik", "")
        assert len(ak.providers) == 1
        assert ak.providers[0]["redirect_uris"][0]["url"] == "http://testserver/api/oidc/callback"
        signer.person = {"sub": "anna-1"}
        browser = fresh_browser()
        target = location(browser.get("/api/oidc/oidc/start"))
        back = browser.get("/api/oidc/callback", params=signer.authorize(target))
        assert location(back) == "/" and browser.get("/api/auth/me").json()["name"] == "anna"
    finally:
        module.use_transport(None)
