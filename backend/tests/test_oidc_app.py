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
from app.security import decrypt_secret, encrypt_secret, hash_password
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
    # An issuer of authentik's form under another name was typed by hand: the button never wrote that name.
    with SessionLocal() as db:
        db.query(OidcProvider).delete()
        db.commit()
    _legacy(provider, label="Company", issuer=AUTHENTIK_ISSUER)
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
    # Never unseen: anna finds it under "New", with the provider's name and who did it.
    told = [(item["kind"], item["actor"], item["subject"]) for item in member.get("/api/notices").json()]
    assert told == [("operator_unlinked", "tester", "SSO")]
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
        # The card sends the browser's own address while nexlore has none (module 1.0.10, never a guessed one).
        body = {"url": ak.base, "token": ak.token, "public_url": "http://testserver"}
        result = client.post("/api/oidc/authentik/setup", json=body, headers=UI).json()
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


def test_the_start_of_nexlore_reads_the_tls_context_of_the_sign_in_module_ahead() -> None:
    """``nexoidc.warm()`` in the lifespan: the first sign-in after a start does not wait for the certificates."""
    from app.main import app
    from app.vendor.nexoidc import tls

    tls.forget()
    assert tls._context is None
    with TestClient(app):
        assert tls._context is not None


# --- The way back to 1.5 (blueprint 01 "Umstieg" 4) -----------------------------------------------------------------


def _old() -> dict[str, object]:
    with SessionLocal() as db:
        values = settings_service.get_all(db)
        subjects = {row.name: row.oidc_subject for row in db.scalars(select(Account))}
        secret = decrypt_secret(str(values["oidc_client_secret_enc"] or ""))
    return {"issuer": values["oidc_issuer"], "client": values["oidc_client_id"], "secret": secret,
            "name": values["oidc_provider_name"], "auto": values["oidc_auto_create"], "subjects": subjects}


def test_the_old_settings_and_subjects_always_describe_the_entry_oidc(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    make_account("ben")
    _legacy(provider, label="Company", subjects={"anna": "anna-1", "ben": "ben-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    old = _old()
    assert (old["client"], old["secret"], old["name"], old["auto"]) == (provider.client_id, provider.client_secret,
                                                                       "Company", False)
    assert old["subjects"] == {"tester": "", "anna": "anna-1", "ben": "ben-1"}
    # Unlinked by itself, by the operator, linked anew: the old column says the same as the links.
    anna = fresh_browser()
    sign_in(anna, accounts_row("anna"))
    assert anna.delete("/api/oidc/oidc/link", headers=UI).status_code == 204
    ben_id = accounts_row("ben").id
    assert client.request("DELETE", f"/api/oidc/admin/accounts/{ben_id}/links/{entry.id}",
                          json={"current_password": PASSWORD}, headers=UI).status_code == 204
    assert _old()["subjects"] == {"tester": "", "anna": "", "ben": ""}
    assert location(link(anna, provider, PASSWORD, slug="oidc", sub="anna-9")) == "/account?linked=oidc"
    assert _old()["subjects"]["anna"] == "anna-9"
    # Switched off, the old version finds no client; on with new people allowed, it lets them in as before.
    view = client.get("/api/oidc/admin/providers").json()[0]
    body = {key: view[key] for key in ("label", "issuer", "client_id", "scopes", "trusts_second_factor")}
    assert client.put(f"/api/oidc/admin/providers/{entry.id}", json={**body, "enabled": False, "auto_create": True},
                      headers=UI).status_code == 200
    old = _old()
    assert (old["client"], old["secret"], old["auto"]) == ("", "", False)
    assert client.put(f"/api/oidc/admin/providers/{entry.id}", json={**body, "enabled": True, "auto_create": True},
                      headers=UI).status_code == 200
    old = _old()
    assert (old["client"], old["secret"], old["auto"]) == (provider.client_id, provider.client_secret, True)
    assert old["subjects"]["anna"] == "anna-9"


def test_another_issuer_or_removing_the_entry_oidc_empties_the_old_settings_for_good(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    from .oidc_helpers import fakes

    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    moved = provider.network.add(fakes.FakeProvider("https://moved.example.com", client_id=provider.client_id,
                                                     client_secret=provider.client_secret))
    view = client.get("/api/oidc/admin/providers").json()[0]
    body = {key: view[key] for key in ("label", "client_id", "scopes", "enabled", "auto_create",
                                         "trusts_second_factor")}
    assert client.put(f"/api/oidc/admin/providers/{entry.id}", json={**body, "issuer": moved.issuer},
                      headers=UI).status_code == 200
    old = _old()
    assert (old["issuer"], old["client"], old["secret"], old["subjects"]["anna"]) == ("", "", "", "")
    # Back to the first issuer: the old settings stay empty, a provider gone once does not come back that way.
    assert client.put(f"/api/oidc/admin/providers/{entry.id}", json={**body, "issuer": provider.issuer},
                      headers=UI).status_code == 200
    assert _old()["issuer"] == ""
    make_account("ben")
    _legacy(provider, label="Company", subjects={"ben": "ben-1"})
    with SessionLocal() as db:
        db.query(OidcProvider).delete()
        db.commit()
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None and _old()["subjects"]["ben"] == "ben-1"
    assert client.delete(f"/api/oidc/admin/providers/{entry.id}", headers=UI).status_code == 200
    old = _old()
    assert (old["issuer"], old["client"], old["subjects"]["ben"]) == ("", "", "")


def _change_entry(client: TestClient, entry_id: int, **changes: object) -> None:
    """The operator saves the entry ``oidc`` with ``changes`` laid over what it says now."""
    view = client.get("/api/oidc/admin/providers").json()[0]
    body = {key: view[key] for key in ("label", "issuer", "client_id", "scopes", "enabled", "auto_create",
                                         "trusts_second_factor")}
    assert client.put(f"/api/oidc/admin/providers/{entry_id}", json={**body, **changes},
                      headers=UI).status_code == 200


def test_an_entry_whose_provider_does_not_check_the_second_factor_is_off_for_the_old_settings_both_ways(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """Rule of 10.10.2026: nexlore 1.5 has no such switch and would ask for no code after the provider, so it finds no
    client while the switch is off; switching it on again brings everything back at once."""
    make_account("anna")
    _legacy(provider, label="Company", auto_create=True, subjects={"anna": "anna-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    assert (_old()["client"], _old()["auto"]) == (provider.client_id, True)
    _change_entry(client, entry.id, trusts_second_factor=False)
    old = _old()
    assert (old["client"], old["secret"], old["auto"]) == ("", "", False)
    # Only the way in is closed: the issuer, the name and the subjects stay for the way back to come up again.
    assert (old["issuer"], old["name"], old["subjects"]["anna"]) == (provider.issuer, "Company", "anna-1")
    _change_entry(client, entry.id, trusts_second_factor=True)
    old = _old()
    assert (old["client"], old["secret"], old["auto"]) == (provider.client_id, provider.client_secret, True)
    # Off and untrusted together, then only one of them taken back: still closed.
    _change_entry(client, entry.id, trusts_second_factor=False, enabled=False)
    _change_entry(client, entry.id, enabled=True, trusts_second_factor=False)
    assert _old()["client"] == ""
    _change_entry(client, entry.id, enabled=False, trusts_second_factor=True)
    assert _old()["client"] == ""
    _change_entry(client, entry.id, enabled=True, trusts_second_factor=True)
    assert _old()["client"] == provider.client_id


# --- Up again after the way back (module 1.0.9) -----------------------------------------------------------------------


def _linked_names() -> dict[str, str]:
    with SessionLocal() as db:
        return {db.get(Account, link.account_id).name: link.subject for link in db.scalars(select(OidcLink))}


def test_a_start_takes_over_what_the_older_version_changed_and_makes_a_backup_only_then(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    make_account("ben")
    _legacy(provider, label="Company", subjects={"anna": "anna-1", "ben": "ben-1"})
    assert oidc_store.migrate_settings(backup=False) is not None
    kept = len(backups.entries())
    # A start that changes nothing writes nothing and makes no backup; the secret sealed anew by the older version is
    # no change (the fingerprint reads it decrypted, the stored text differs at every sealing).
    with SessionLocal() as db:
        settings_service.save(db, {"oidc_client_secret_enc": encrypt_secret(provider.client_secret)})
    assert oidc_store.migrate_settings() is None and len(backups.entries()) == kept
    # The older version let ben go and renamed the button: both come over, with a backup first.
    with SessionLocal() as db:
        accounts.by_name(db, "ben").oidc_subject = ""
        db.commit()
        settings_service.save(db, {"oidc_provider_name": "Renamed"})
    assert oidc_store.migrate_settings() is None and len(backups.entries()) == kept + 1
    assert backups.entries()[0].kind == backups.UPDATE
    assert _linked_names() == {"anna": "anna-1"} and _entries()[0].label == "Renamed"
    # The next start has nothing left to take over.
    assert oidc_store.migrate_settings() is None and len(backups.entries()) == kept + 1
    assert _linked_names() == {"anna": "anna-1"} and _old()["subjects"]["ben"] == ""


def test_a_provider_the_older_version_set_up_comes_up_again_with_the_links_it_made(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    # The operator removed the provider here; the older version set one up again and linked anna to another subject.
    assert client.delete(f"/api/oidc/admin/providers/{entry.id}", headers=UI).status_code == 200
    assert _entries() == [] and _old()["client"] == ""
    _legacy(provider, label="Back again", subjects={"anna": "anna-2"})
    with SessionLocal() as db:
        settings_service.save(db, {oidc_store.MIGRATED: True})
    oidc_store.migrate_settings(backup=False)
    [row] = _entries()
    assert (row.slug, row.label, row.enabled, row.trusts_second_factor) == ("oidc", "Back again", True, True)
    assert _linked_names() == {"anna": "anna-2"}
    assert _old()["client"] == provider.client_id


# --- An invitation at a known link (module 1.0.8) -----------------------------------------------------------------


def test_an_invitation_at_a_known_link_adds_its_rights_and_is_used_up(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider)
    vault.create_space("Team")
    make_account("dora")
    member = fresh_browser()
    sign_in(member, accounts_row("dora"))
    assert location(link(member, provider, PASSWORD, sub="dora-1")) == "/account?linked=sso"
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == "Team"))
        assert space is not None
        _invite, token = accounts.create_invite(db, db.get(Account, operator.id), space_id=space.id,
                                                space_role=WRITE, days=7)
        space_id = space.id
    browser = fresh_browser()
    back = sign_in_via_oidc(browser, provider, invite=token, sub="dora-1", preferred_username="dora")
    assert location(back) == "/" and browser.get("/api/auth/me").json()["name"] == "dora"
    with SessionLocal() as db:
        roles = {db.get(Account, row.account_id).name: row.role
                 for row in db.scalars(select(Membership).where(Membership.space_id == space_id))}
    assert roles == {"dora": WRITE, "tester": "manage"}
    # Used up for good: the same link brings nothing a second time.
    again = fresh_browser().get("/api/oidc/sso/start", params={"invite": token})
    assert error_in(again) == "invite_invalid"


# --- The second factor the operator requires (rule of 10.10.2026) ---------------------------------------------------


def _require_second_factor(on: bool) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": on})


def test_a_provider_that_checks_the_second_factor_ends_the_duty_to_enrol_one_but_the_password_does_not(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    entry = add_provider(client, provider, trusts_second_factor=True)
    make_account("anna")
    member = fresh_browser()
    sign_in(member, accounts_row("anna"))
    assert location(link(member, provider, PASSWORD, sub="anna-1")) == "/account?linked=sso"
    _require_second_factor(True)

    # Through the provider: nothing to enrol, the whole app is open.
    through = fresh_browser()
    assert location(sign_in_via_oidc(through, provider, sub="anna-1")) == "/"
    me = through.get("/api/auth/me").json()
    assert me["name"] == "anna" and me["second_factor_setup_required"] is False
    assert through.get("/api/spaces").status_code == 200

    # The same account with its password is made to enrol, as before.
    with_password = fresh_browser()
    assert with_password.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
    assert with_password.get("/api/auth/me").json()["second_factor_setup_required"] is True
    blocked = with_password.get("/api/spaces")
    assert blocked.status_code == 403 and blocked.json()["detail"]["code"] == "second_factor_setup_required"

    # A provider the entry does not trust with the second factor ends nothing: the session counts as the password's.
    # (The operator's own session is a password session as well: the requirement stays off while the entry changes.)
    _require_second_factor(False)
    _change_entry(client, entry["id"], trusts_second_factor=False)
    _require_second_factor(True)
    untrusted = fresh_browser()
    assert location(sign_in_via_oidc(untrusted, provider, sub="anna-1")) == "/"
    assert untrusted.get("/api/auth/me").json()["second_factor_setup_required"] is True
    assert untrusted.get("/api/spaces").status_code == 403

    # An account that only has the provider is not made to enrol either way (it never had to).
    new = fresh_browser()
    _require_second_factor(False)
    _change_entry(client, entry["id"], trusts_second_factor=True, auto_create=True)
    _require_second_factor(True)
    assert location(sign_in_via_oidc(new, provider, sub="new-1", preferred_username="neo")) == "/"
    assert new.get("/api/auth/me").json()["second_factor_setup_required"] is False


def test_the_first_start_with_the_fingerprint_stores_it_takes_nothing_over_and_writes_the_way_back_again(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """A database as module 1.0.7 left it: no fingerprint yet, so what the older version changed since cannot be told
    and nothing is taken over; the start writes the way back anew (the entry does not trust the provider with the
    second factor, so the old client goes) and stores the first fingerprint."""
    from app.models import Setting

    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    assert oidc_store.migrate_settings(backup=False) is not None
    with SessionLocal() as db:
        db.query(OidcProvider).update({"trusts_second_factor": False})
        db.query(Setting).filter(Setting.key == oidc_store.FINGERPRINT).delete()
        db.commit()
        settings_service.save(db, {"oidc_provider_name": "Changed before the first start"})
    kept = len(backups.entries())
    assert oidc_store.migrate_settings() is None
    assert _entries()[0].label == "Company" and len(backups.entries()) == kept
    assert _old()["client"] == "" and _old()["subjects"]["anna"] == "anna-1"
    with SessionLocal() as db:
        assert settings_service.get(db, oidc_store.FINGERPRINT)


# --- Module 1.0.11 ------------------------------------------------------------------------------------------------------


def test_the_issuer_stays_as_the_older_version_wrote_it_letter_by_letter_through_every_change_and_start(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """Six older versions compare the issuer character by character: the one authentik writes (with a slash at the
    end) must come back as it was, after the migration, off and on, a save and a start."""
    make_account("anna")
    written = provider.issuer + "/"
    _legacy(provider, label="authentik", issuer=written, subjects={"anna": "anna-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    assert _old()["issuer"] == written
    _change_entry(client, entry.id, enabled=False)
    assert _old()["issuer"] == written
    _change_entry(client, entry.id, enabled=True)
    assert _old()["issuer"] == written
    _change_entry(client, entry.id, label="Renamed")
    assert _old()["issuer"] == written
    assert oidc_store.migrate_settings() is None
    old = _old()
    assert old["issuer"] == written and old["subjects"]["anna"] == "anna-1"
    # An issuer typed without the slash stays without it.
    with SessionLocal() as db:
        settings_service.save(db, {"oidc_issuer": provider.issuer})
    assert oidc_store.migrate_settings(backup=False) is None
    assert _old()["issuer"] == provider.issuer


def test_a_start_after_a_fingerprint_of_module_1_0_9_makes_a_backup_only_when_the_older_version_changed_something(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """The fingerprint of 1.0.9 is another form than today's: comparing the two forms would see a change at every
    first start. ``changes_since`` compares in the stored form, so the backup follows what really changed."""
    from app.vendor.nexoidc import migrate

    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    assert oidc_store.migrate_settings(backup=False) is not None

    def store_old_form() -> None:
        with SessionLocal() as db:
            legacy, subjects = oidc_store.read_legacy(db)
            settings_service.save(db, {oidc_store.FINGERPRINT: migrate._fingerprint(legacy, subjects, "nexoidc-fp1")})

    store_old_form()
    kept = len(backups.entries())
    assert oidc_store.migrate_settings() is None
    assert len(backups.entries()) == kept
    # The older version let anna go after that start: taken over, with a backup first.
    store_old_form()
    with SessionLocal() as db:
        accounts.by_name(db, "anna").oidc_subject = ""
        db.commit()
    assert oidc_store.migrate_settings() is None
    assert len(backups.entries()) == kept + 1 and _linked_names() == {}
