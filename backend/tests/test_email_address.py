"""A mail address for each account (issue #13), since the shared account module (``vendor/nexkonten``): entered in the
profile with the own password (with a mail server it waits for its link, without one it counts at once), from an
invitation, or from the provider; the operator only takes one away. The module's own rules are its contract tests
(``tests/nexkonten``); here are nexlore's routes and what 1.16.0 left behind. The mail server is a stand-in that keeps
what it is given; the provider is the fake of the shared sign-in tests (``tests/oidc_helpers``). Nothing leaves the
machine.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import SIGN_IN_OIDC, Account, OidcLink
from app.models_accounts import MailOutbox
from app.security import hash_token
from app.services import accounts, mailer

from .conftest import PASSWORD, make_account
from .oidc_helpers import UI, FakeProvider, add_provider, error_in, fresh_browser, location, sign_in_via_oidc
from .oidc_helpers import link as link_via
from .test_mcp import switch
from .test_profile import person

# http: the test browsers talk to the app over http, and behind an https address the attempt cookie of a sign-in
# through the provider is Secure (as it must be), which such a browser would not send back.
PUBLIC = "http://notes.example.com"
LINK = re.compile(r"http://notes\.example\.com/email/([A-Za-z0-9_-]+)")


class Postbox:
    """The mail server: takes every message sent at once, or refuses all when ``down``; the mails about an account
    wait in the outbox (``mail_outbox``) and are read from there."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.sent: list[Any] = []
        self.down = False

        def send(_db: Any, message: Any) -> None:
            if self.down:
                raise mailer.MailError("mail_failed", "refused")
            self.sent.append(message)

        monkeypatch.setattr(mailer, "_send", send)

    @property
    def mails(self) -> list[dict[str, str]]:
        found = [{"to": str(message["To"]), "text": message.get_body(("plain",)).get_content()}
                 for message in self.sent]
        with SessionLocal() as db:
            for row in db.query(MailOutbox).order_by(MailOutbox.id):
                letter = json.loads(row.letter)
                found.append({"to": letter["to"], "text": letter["text"]})
        return found

    def link(self, to: str) -> str:
        """The token in the last mail to ``to``."""
        for mail in reversed(self.mails):
            if mail["to"] == to:
                hit = LINK.search(mail["text"])
                assert hit, mail["text"]
                return hit.group(1)
        raise AssertionError(f"no mail to {to}")


@pytest.fixture
def postbox(monkeypatch: pytest.MonkeyPatch) -> Postbox:
    return Postbox(monkeypatch)


def mail_ready() -> None:
    switch(smtp_host="mail.example.com", smtp_from="notes@example.com", public_url=PUBLIC)


def row(name: str) -> Account:
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name=name).one()
        db.expunge(found)
        return found


def give(name: str, address: str, source: str = "own") -> None:
    """An address straight into the database, as 1.16.0 left it."""
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name=name).one()
        found.email, found.email_source = address, source
        db.commit()


def confirm(token: str) -> Any:
    # From a browser without a session: the link itself is the proof.
    return fresh_browser(None).post(f"/api/email/{token}", headers=UI)  # type: ignore[arg-type]


def code_of(answer: Any) -> str:
    return answer.json()["detail"]["code"]


# --- The own address ---------------------------------------------------------------------------------------------------


def test_without_a_mail_server_an_address_counts_at_once_with_the_password(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    """The draft: without a mail server nobody could ever confirm, so the address counts at once (1.16.0 refused
    it); it asks for the own password like every change of address."""
    anna = person("anna")
    assert anna.get("/api/auth/me").json()["email_confirm"] == "mail_off"
    wrong = anna.put("/api/me/profile", json={"email": "anna@example.com", "password": "not the password"})
    assert wrong.status_code == 401 and row("anna").email == ""
    answer = anna.put("/api/me/profile", json={"email": "  anna@example.com ", "password": PASSWORD})
    assert answer.status_code == 200, answer.text
    me = answer.json()
    assert (me["email"], me["email_source"], me["email_confirmed"], me["email_proven"]) == (
        "anna@example.com", "own", True, False)
    assert postbox.mails == []


def test_with_a_mail_server_an_address_counts_once_its_link_is_opened_and_the_link_works_once(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna = person("anna")
    answer = anna.put("/api/me/profile", json={"email": "anna@example.com", "password": PASSWORD})
    assert answer.status_code == 200, answer.text
    me = answer.json()
    assert me["email"] == "" and me["pending_email"] == me["email_pending"] == "anna@example.com"
    token = postbox.link("anna@example.com")
    assert fresh_browser(None).get(f"/api/email/{token}").json() == {"email": "anna@example.com"}
    confirmed = confirm(token)
    assert confirmed.status_code == 200 and confirmed.json()["email"] == "anna@example.com"
    me = anna.get("/api/auth/me").json()
    assert (me["email"], me["email_source"], me["email_proven"], me["pending_email"]) == (
        "anna@example.com", "own", True, "")
    assert confirm(token).status_code == 404


def test_the_old_route_of_1_16_0_takes_a_link_of_1_16_0(client: TestClient, operator: Account) -> None:
    """Mails of 1.16.0 led to ``/confirm-email/nxe_…`` and the page posted the token to ``/api/email/confirm``: an
    address still waiting from before counts with it."""
    make_account("anna")
    token = "nxe_" + "Ab3_-" * 9
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name="anna").one()
        found.email_pending = "anna@example.com"
        found.email_pending_hash = hash_token(token)
        from datetime import timedelta

        from app.models import utcnow

        found.email_pending_until = utcnow() + timedelta(hours=1)
        db.commit()
    answer = fresh_browser(None).post("/api/email/confirm", json={"token": token}, headers=UI)  # type: ignore[arg-type]
    assert answer.status_code == 200, answer.text
    assert (row("anna").email, row("anna").email_source, row("anna").email_proven) == ("anna@example.com", "own", True)


@pytest.mark.parametrize("token", ["nxe_", "nxe_unknown-token-that-was-never-sent", "abc"])
def test_a_made_up_link_does_nothing(client: TestClient, operator: Account, postbox: Postbox, token: str) -> None:
    assert confirm(token).status_code == 404


def test_the_address_confirmed_before_stays_in_force_until_the_new_one_is_confirmed(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna = person("anna")
    give("anna", "anna@example.com")
    anna.put("/api/me/profile", json={"email": "anna.new@example.com", "password": PASSWORD})
    assert row("anna").email == "anna@example.com"
    assert confirm(postbox.link("anna.new@example.com")).status_code == 200
    assert row("anna").email == "anna.new@example.com"
    # The address of before hears of it.
    assert any(mail["to"] == "anna@example.com" for mail in postbox.mails)


def test_withdrawing_or_sending_again_makes_the_earlier_link_useless(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/profile", json={"email": "anna@example.com", "password": PASSWORD})
    first = postbox.link("anna@example.com")
    assert anna.post("/api/me/email/resend").status_code == 200
    second = postbox.link("anna@example.com")
    assert first != second and confirm(first).status_code == 404
    assert anna.delete("/api/me/email/pending").json()["pending_email"] == ""
    assert confirm(second).status_code == 404 and row("anna").email == ""


@pytest.mark.parametrize("address", ["anna", "anna@", "@example.com", "an na@example.com", "anna@example.com\nBcc: x",
                                     "an\x00na@example.com"])
def test_what_cannot_be_an_address_is_refused_and_nothing_is_sent(
    client: TestClient, operator: Account, postbox: Postbox, address: str
) -> None:
    mail_ready()
    anna = person("anna")
    answer = anna.put("/api/me/profile", json={"email": address, "password": PASSWORD})
    assert answer.status_code == 422, answer.text
    # 1.16.0's code stays for scripts; the module's own beside it.
    assert code_of(answer) == "invalid_email" and answer.json()["detail"]["account_code"] == "email_invalid"
    assert postbox.mails == []


def test_an_address_another_account_holds_is_refused(client: TestClient, operator: Account) -> None:
    make_account("ben")
    give("ben", "shared@example.com")
    anna = person("anna")
    refused = anna.put("/api/me/profile", json={"email": "SHARED@example.com", "password": PASSWORD})
    assert refused.status_code == 409 and code_of(refused) == "email_taken"


def test_the_own_address_goes_only_with_the_password(client: TestClient, operator: Account) -> None:
    anna = person("anna")
    give("anna", "anna@example.com")
    assert anna.request("DELETE", "/api/me/email", json={"password": "wrong"}).status_code == 401
    assert row("anna").email == "anna@example.com"
    removed = anna.request("DELETE", "/api/me/email", json={"password": PASSWORD})
    assert removed.status_code == 200 and removed.json()["email"] == ""


def test_a_paired_device_never_changes_the_address(client: TestClient, operator: Account) -> None:
    anna = person("anna")
    refused = anna.put("/api/me/profile", json={"email": "anna@example.com", "password": PASSWORD},
                       headers={"Authorization": "Bearer nla_whatever"})
    assert refused.status_code in (401, 403)
    assert row("anna").email == ""


# --- The provider ------------------------------------------------------------------------------------------------------


def links_of(name: str) -> list[str]:
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name=name).one()
        return [entry.subject for entry in db.query(OidcLink).filter_by(account_id=found.id)]


def link(member: TestClient, provider: FakeProvider, sub: str, **claims: Any) -> None:
    back = link_via(member, provider, PASSWORD, sub=sub, **claims)
    assert location(back) == "/account?linked=sso", location(back)


def test_an_address_typed_in_never_catches_somebody_elses_first_sign_in(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """mallory types the address of a person who never signed in here. When that person signs in through the provider
    the first time, nexlore must not hand them mallory's account."""
    add_provider(client, provider, auto_create=True)
    mallory = person("mallory")
    mallory.put("/api/me/profile", json={"email": "victim@example.com", "password": PASSWORD})
    victim = fresh_browser(client)
    sign_in_via_oidc(victim, provider, sub="victim-1", email="victim@example.com", preferred_username="victim")
    assert victim.get("/api/auth/me").json()["name"] == "victim"
    assert links_of("mallory") == []


def test_even_a_confirmed_own_address_never_links_a_first_sign_in(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=False)
    make_account("anna")
    give("anna", "anna@example.com")
    browser = fresh_browser(client)
    back = sign_in_via_oidc(browser, provider, sub="anna-1", email="anna@example.com", email_verified=True)
    assert error_in(back) == "oidc_no_account" and browser.get("/api/auth/me").status_code == 401
    assert links_of("anna") == []


def test_an_account_with_a_password_is_offered_the_providers_address_and_takes_it_with_the_password(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    me = anna.get("/api/auth/me").json()
    assert (me["email"], me["provider_email"], me["provider_email_from"]) == ("", "anna.sso@example.com", "SSO")
    # Signing in there again gives nothing either.
    sign_in_via_oidc(fresh_browser(client), provider, sub="anna-1", email="anna.sso@example.com")
    assert row("anna").email == ""
    assert anna.post("/api/me/email/provider", json={"password": "wrong"}).status_code == 401
    taken = anna.post("/api/me/email/provider", json={"password": PASSWORD})
    assert taken.status_code == 200, taken.text
    # Taken with the password it is the account's own, like any address it enters (the shared module), and stays
    # when the link goes (1.16.0 let it go with the link).
    assert (taken.json()["email"], taken.json()["email_source"]) == ("anna.sso@example.com", "own")
    assert anna.delete("/api/oidc/sso/link", headers=UI).status_code == 204
    assert anna.get("/api/auth/me").json()["email"] == "anna.sso@example.com"


def test_no_thanks_holds_for_that_address_a_newer_one_is_offered_again(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    give("anna", "anna@example.com")
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == "anna.sso@example.com"
    assert anna.delete("/api/me/email/provider").json()["provider_email"] == ""
    sign_in_via_oidc(fresh_browser(client), provider, sub="anna-1", email="anna.sso@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == ""
    sign_in_via_oidc(fresh_browser(client), provider, sub="anna-1", email="anna.work@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == "anna.work@example.com"
    assert row("anna").email == "anna@example.com"


def test_an_offered_address_another_account_holds_is_never_taken(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=False)
    make_account("ben")
    give("ben", "shared@example.com")
    anna = person("anna")
    link(anna, provider, "anna-1", email="shared@example.com")
    refused = anna.post("/api/me/email/provider", json={"password": PASSWORD})
    assert refused.status_code in (404, 409)
    assert row("anna").email == "" and row("ben").email == "shared@example.com"


def test_unlinking_keeps_an_own_address(client: TestClient, operator: Account, provider: FakeProvider) -> None:
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    give("anna", "anna@example.com")
    link(anna, provider, "anna-1", email="anna@example.com")
    assert anna.delete("/api/oidc/sso/link", headers=UI).status_code == 204
    me = anna.get("/api/auth/me").json()
    assert me["email"] == "anna@example.com" and me["email_source"] == "own" and me["provider_email"] == ""


def test_an_account_through_the_provider_only_follows_it_without_it_counting(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """The draft: an address from the provider counts only once the person confirms it (providers report addresses
    unreliably); the account follows a new one at the provider until it enters one of its own."""
    add_provider(client, provider, auto_create=True)
    browser = fresh_browser(client)
    sign_in_via_oidc(browser, provider, sub="clara-1", email="clara@example.com", preferred_username="clara")
    me = browser.get("/api/auth/me").json()
    assert me["sign_in"] == SIGN_IN_OIDC and me["email"] == "clara@example.com" and me["email_source"] == "provider"
    assert me["email_confirmed"] is False
    sign_in_via_oidc(fresh_browser(client), provider, sub="clara-1", email="clara.new@example.com")
    assert row("clara").email == "clara.new@example.com"


def test_a_provider_address_another_account_holds_is_not_followed(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=True)
    browser = fresh_browser(client)
    sign_in_via_oidc(browser, provider, sub="clara-1", email="clara@example.com", preferred_username="clara")
    make_account("ben")
    give("ben", "ben@example.com")
    sign_in_via_oidc(fresh_browser(client), provider, sub="clara-1", email="ben@example.com")
    assert row("clara").email == "clara@example.com"


# --- The operator ------------------------------------------------------------------------------------------------------


def test_the_operator_no_longer_sets_an_address_but_takes_one_away_with_the_own_password(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    """Decided by the owner of the apps: a reset link would otherwise go wherever the operator chose."""
    make_account("ben")
    ben_id = row("ben").id
    refused = client.put(f"/api/accounts/{ben_id}/email", json={"address": "ben@example.com",
                                                                 "current_password": PASSWORD})
    assert refused.status_code == 409 and code_of(refused) == "not_allowed" and row("ben").email == ""
    give("ben", "ben@example.com")
    wrong = client.request("DELETE", f"/api/accounts/{ben_id}/email", json={"current_password": "nope"})
    assert wrong.status_code == 401 and row("ben").email == "ben@example.com"
    removed = client.request("DELETE", f"/api/accounts/{ben_id}/email", json={"current_password": PASSWORD})
    assert removed.status_code == 200 and removed.json()["email"] == ""
    # 1.16.0's way with an empty address still takes one away.
    give("ben", "ben@example.com")
    emptied = client.put(f"/api/accounts/{ben_id}/email", json={"address": "", "current_password": PASSWORD})
    assert emptied.status_code == 200 and row("ben").email == ""


def test_a_member_cannot_take_another_accounts_address(client: TestClient, operator: Account) -> None:
    ben = person("ben")
    give("tester", "op@example.com")
    refused = ben.request("DELETE", f"/api/accounts/{operator.id}/email", json={"current_password": PASSWORD})
    assert refused.status_code == 403 and row("tester").email == "op@example.com"


def test_the_list_says_when_an_address_is_held_twice(client: TestClient, operator: Account) -> None:
    """1.16.0 could leave one address at two accounts: it signs neither in, and the operator's list says so."""
    make_account("kim")
    make_account("lou")
    give("kim", "Kim@Example.org", "operator")
    give("lou", "kim@example.org", "operator")
    listed = {item["name"]: item for item in client.get("/api/accounts").json()}
    assert listed["kim"]["email_duplicate"] is True and listed["lou"]["email_duplicate"] is True
    assert listed["tester"]["email_duplicate"] is False
    assert listed["kim"]["email_source"] == "operator"


# --- Invitations -------------------------------------------------------------------------------------------------------


def test_an_address_from_before_is_counted_as_where_it_could_have_come_from(client: TestClient, operator: Account) -> None:
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name="tester").one()
        found.email = "old@example.com"
        db.commit()
    assert client.get("/api/auth/me").json()["email_source"] == "invite"
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name="tester").one()
        found.oidc_subject = "someone"
        db.commit()
    assert client.get("/api/auth/me").json()["email_source"] == "provider"


def _invite(operator: Account, email: str) -> str:
    with SessionLocal() as db:
        by = db.get(Account, operator.id)
        _invite, token = accounts.create_invite(db, by, space_id=None, space_role="", days=7, email=email)
    return token


def test_an_invitation_to_an_address_gives_the_new_account_that_address(client: TestClient, operator: Account) -> None:
    token = _invite(operator, "new@example.com")
    answer = fresh_browser(None).post(f"/api/invite/{token}", headers=UI,  # type: ignore[arg-type]
                                      json={"name": "newbie", "password": PASSWORD})
    assert answer.status_code == 200, answer.text
    assert (row("newbie").email, row("newbie").email_source, row("newbie").email_confirmed) == (
        "new@example.com", "invite", True)


def test_an_invitation_of_1_16_0_to_an_address_another_account_took_since_gives_no_address(
    client: TestClient, operator: Account
) -> None:
    token = _invite(operator, "new@example.com")
    give("tester", "NEW@example.com")
    answer = fresh_browser(None).post(f"/api/invite/{token}", headers=UI,  # type: ignore[arg-type]
                                      json={"name": "newbie", "password": PASSWORD})
    assert answer.status_code == 200, answer.text
    assert row("newbie").email == ""


def test_the_link_of_a_confirmation_never_stands_in_the_log() -> None:
    from app.services import logs

    token = "nxe_" + "Ab3_-" * 9
    for line in (f"GET /confirm-email/{token} 200", f"GET /api/confirm-email/{token}", f"opened {token}"):
        assert token[4:] not in logs.redact(line), line
