"""A mail address for each account (issue #13): entered in the profile and confirmed by its link, set by the operator,
from an invitation, or from the provider. The mail server is a stand-in that keeps what it is given; the provider is
the fake of the shared sign-in tests (``tests/oidc_helpers``). Nothing leaves the machine.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import SIGN_IN_OIDC, Account, OidcLink, SpaceNotice
from app.services import accounts, emailaddr, mailer

from .conftest import PASSWORD, make_account
from .oidc_helpers import UI, FakeProvider, add_provider, error_in, fresh_browser, location, sign_in_via_oidc
from .oidc_helpers import link as link_via
from .test_mcp import switch
from .test_profile import person

# http: the test browsers talk to the app over http, and behind an https address the attempt cookie of a sign-in
# through the provider is Secure (as it must be), which such a browser would not send back.
PUBLIC = "http://notes.example.com"
LINK = re.compile(r"http://notes\.example\.com/confirm-email/(nxe_[A-Za-z0-9_-]+)")


class Postbox:
    """The mail server: takes every message, or refuses all when ``down``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.mails: list[Any] = []
        self.down = False

        def send(_db: Any, message: Any) -> None:
            if self.down:
                raise mailer.MailError("mail_failed", "refused")
            self.mails.append(message)

        monkeypatch.setattr(mailer, "_send", send)

    def link(self, to: str) -> str:
        """The token in the last mail to ``to``."""
        for message in reversed(self.mails):
            if message["To"] == to:
                found = LINK.search(message.get_content())
                assert found, message.get_content()
                return found.group(1)
        raise AssertionError(f"no mail to {to}")


@pytest.fixture
def postbox(monkeypatch: pytest.MonkeyPatch) -> Postbox:
    emailaddr.forget_sends()
    return Postbox(monkeypatch)


def mail_ready() -> None:
    switch(smtp_host="mail.example.com", smtp_from="notes@example.com", public_url=PUBLIC)


def row(name: str) -> Account:
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name=name).one()
        db.expunge(found)
        return found


def confirm(token: str) -> Any:
    # From a browser without a session: the link itself is the proof.
    return fresh_browser(None).post("/api/email/confirm", json={"token": token}, headers=UI)  # type: ignore[arg-type]


def code_of(answer: Any) -> str:
    return answer.json()["detail"]["code"]


# --- The own address ---------------------------------------------------------------------------------------------------


def test_without_a_mail_server_or_a_public_address_the_profile_cannot_ask_for_a_confirmation(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    anna = person("anna")
    assert anna.get("/api/auth/me").json()["email_confirm"] == "mail_off"
    refused = anna.put("/api/me/email", json={"address": "anna@example.com"})
    assert refused.status_code == 409 and code_of(refused) == "mail_off"
    switch(smtp_host="mail.example.com", smtp_from="notes@example.com")
    assert anna.get("/api/auth/me").json()["email_confirm"] == "public_url_missing"
    refused = anna.put("/api/me/email", json={"address": "anna@example.com"})
    assert refused.status_code == 409 and code_of(refused) == "public_url_missing"
    switch(public_url=PUBLIC)
    assert anna.get("/api/auth/me").json()["email_confirm"] == ""
    assert postbox.mails == [] and row("anna").email_pending == ""


def test_an_address_entered_counts_only_once_its_link_is_opened_and_the_link_works_once(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna = person("anna")
    answer = anna.put("/api/me/email", json={"address": "  anna@example.com "})
    assert answer.status_code == 200 and answer.json()["sent"] is True
    me = anna.get("/api/auth/me").json()
    assert me["email"] == "" and me["email_pending"] == "anna@example.com" and me["email_source"] == ""
    assert len(postbox.mails) == 1
    message = postbox.mails[0]
    assert message["To"] == "anna@example.com" and message["Subject"] == "Confirm your mail address for nexlore"
    token = postbox.link("anna@example.com")
    # Until the link is opened the address is mailed nothing and bridges nothing.
    assert row("anna").email == ""
    confirmed = confirm(token)
    assert confirmed.status_code == 200 and confirmed.json() == {"email": "anna@example.com", "name": "anna"}
    me = anna.get("/api/auth/me").json()
    assert (me["email"], me["email_source"], me["email_pending"]) == ("anna@example.com", "own", "")
    again = confirm(token)
    assert again.status_code == 404 and code_of(again) == "email_link_invalid"


def test_the_address_confirmed_before_stays_in_force_until_the_new_one_is_confirmed(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    anna.put("/api/me/email", json={"address": "anna.new@example.com"})
    me = anna.get("/api/auth/me").json()
    assert me["email"] == "anna@example.com" and me["email_pending"] == "anna.new@example.com"
    confirm(postbox.link("anna.new@example.com"))
    assert anna.get("/api/auth/me").json()["email"] == "anna.new@example.com"


def test_a_link_runs_out_after_a_day(client: TestClient, operator: Account, postbox: Postbox) -> None:
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    token = postbox.link("anna@example.com")
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name="anna").one()
        found.email_pending_until = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    late = confirm(token)
    assert late.status_code == 404 and code_of(late) == "email_link_invalid"
    assert row("anna").email == ""
    # Nor does it show as waiting any more.
    assert anna.get("/api/auth/me").json()["email_pending"] == ""


@pytest.mark.parametrize("token", ["", "nxe_", "nxe_unknown-token-that-was-never-sent", "abc", "nxe_" + "x" * 200])
def test_a_made_up_link_does_nothing(client: TestClient, operator: Account, postbox: Postbox, token: str) -> None:
    answer = confirm(token)
    assert answer.status_code in (404, 422)


def test_cancelling_or_sending_again_makes_the_earlier_link_useless(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    first = postbox.link("anna@example.com")
    assert anna.post("/api/me/email/resend").status_code == 200
    second = postbox.link("anna@example.com")
    assert first != second
    assert confirm(first).status_code == 404
    assert anna.delete("/api/me/email/pending").json()["email_pending"] == ""
    assert confirm(second).status_code == 404
    assert row("anna").email == ""
    nothing = anna.post("/api/me/email/resend")
    assert nothing.status_code == 404 and code_of(nothing) == "email_nothing_waits"


@pytest.mark.parametrize(
    "address",
    ["", "   ", "anna", "anna@", "@example.com", "anna@example", "an na@example.com", "anna@exa mple.com",
     "<anna@example.com>", "anna@example.com\nBcc: x@example.com", "anna@@example.com", "a,b@example.com",
     "anna@example.com.", "x" * 250 + "@example.com"],
)
def test_what_cannot_be_an_address_is_refused_and_nothing_is_sent(
    client: TestClient, operator: Account, postbox: Postbox, address: str
) -> None:
    mail_ready()
    anna = person("anna")
    answer = anna.put("/api/me/email", json={"address": address})
    assert answer.status_code == 422, answer.text
    assert postbox.mails == []


def test_the_own_address_again_sends_nothing(client: TestClient, operator: Account, postbox: Postbox) -> None:
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    answer = anna.put("/api/me/email", json={"address": "ANNA@example.com"})
    assert answer.status_code == 200 and answer.json()["sent"] is False
    assert len(postbox.mails) == 1


def test_one_account_causes_at_most_five_mails_an_hour(client: TestClient, operator: Account, postbox: Postbox) -> None:
    mail_ready()
    anna = person("anna")
    for number in range(emailaddr.SENDS_PER_HOUR):
        assert anna.put("/api/me/email", json={"address": f"a{number}@example.com"}).status_code == 200
    stopped = anna.put("/api/me/email", json={"address": "a9@example.com"})
    assert stopped.status_code == 429 and code_of(stopped) == "email_too_many"
    assert len(postbox.mails) == emailaddr.SENDS_PER_HOUR
    # Another account is not held up by it.
    assert person("ben").put("/api/me/email", json={"address": "ben@example.com"}).status_code == 200


def test_a_mail_server_that_refuses_leaves_nothing_waiting(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    postbox.down = True
    anna = person("anna")
    failed = anna.put("/api/me/email", json={"address": "anna@example.com"})
    assert failed.status_code == 502 and code_of(failed) == "mail_failed"
    found = row("anna")
    assert found.email_pending == "" and found.email_pending_hash == ""


def test_an_address_another_account_holds_is_not_confirmed_twice(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    mail_ready()
    anna, ben = person("anna"), person("ben")
    anna.put("/api/me/email", json={"address": "shared@example.com"})
    ben.put("/api/me/email", json={"address": "Shared@Example.com"})
    assert confirm(postbox.link("shared@example.com")).status_code == 200
    refused = confirm(postbox.link("Shared@Example.com"))
    assert refused.status_code == 409 and code_of(refused) == "email_taken"
    assert row("ben").email == "" and row("ben").email_pending == ""


def test_the_own_address_can_be_removed(client: TestClient, operator: Account, postbox: Postbox) -> None:
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    gone = anna.delete("/api/me/email")
    assert gone.status_code == 200 and gone.json()["email"] == "" and gone.json()["email_source"] == ""


def test_the_log_has_the_address_masked_and_never_the_link(
    client: TestClient, operator: Account, postbox: Postbox, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    mail_ready()
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna.secret@example.com"})
    token = postbox.link("anna.secret@example.com")
    confirm(token)
    assert token not in caplog.text and token[4:] not in caplog.text
    assert "anna.secret@example.com" not in caplog.text
    assert "an***@example.com" in caplog.text


# --- No bridge to the provider ------------------------------------------------------------------------------------------


def links_of(name: str) -> list[str]:
    with SessionLocal() as db:
        found = db.query(Account).filter_by(name=name).one()
        return [entry.subject for entry in db.query(OidcLink).filter_by(account_id=found.id)]


def test_an_address_typed_in_never_catches_somebody_elses_first_sign_in(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    """mallory types the address of a person who never signed in here. When that person signs in through the provider
    the first time, nexlore must not hand them mallory's account."""
    mail_ready()
    add_provider(client, provider, auto_create=True)
    mallory = person("mallory")
    mallory.put("/api/me/email", json={"address": "victim@example.com"})
    victim = fresh_browser(client)
    sign_in_via_oidc(victim, provider, sub="victim-1", email="victim@example.com", preferred_username="victim")
    assert victim.get("/api/auth/me").json()["name"] == "victim"
    assert links_of("mallory") == []


def test_even_a_confirmed_own_address_never_links_a_first_sign_in(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    """The shared blueprint: accounts are never found by their address, not even with ``email_verified: true``. anna
    links herself in the profile instead."""
    mail_ready()
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    browser = fresh_browser(client)
    back = sign_in_via_oidc(browser, provider, sub="anna-1", email="anna@example.com", email_verified=True)
    assert error_in(back) == "oidc_no_account" and browser.get("/api/auth/me").status_code == 401
    assert links_of("anna") == []


def link(member: TestClient, provider: FakeProvider, sub: str, **claims: Any) -> None:
    back = link_via(member, provider, PASSWORD, sub=sub, **claims)
    assert location(back) == "/account?linked=sso", location(back)


def test_an_account_with_a_password_and_no_address_is_offered_the_providers_never_given_it(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    """Blueprint 01: only accounts through the provider alone follow its address; every other one is offered it,
    also one that has none of its own yet."""
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    me = anna.get("/api/auth/me").json()
    assert (me["email"], me["email_source"], me["provider_email"]) == ("", "", "anna.sso@example.com")
    # Signing in there again gives nothing either.
    sign_in_via_oidc(fresh_browser(client), provider, sub="anna-1", email="anna.sso@example.com")
    assert row("anna").email == ""
    taken = anna.post("/api/me/email/provider")
    assert (taken.json()["email"], taken.json()["email_source"]) == ("anna.sso@example.com", "provider")
    # Unlinked, an address taken from the provider goes along with the link.
    assert anna.delete("/api/oidc/sso/link", headers=UI).status_code == 204
    me = anna.get("/api/auth/me").json()
    assert me["email"] == "" and me["email_source"] == ""


def test_an_address_from_a_provider_stays_while_another_link_holds(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    from .oidc_helpers import fakes

    add_provider(client, provider, auto_create=False)
    second = provider.network.add(fakes.FakeProvider("https://second.example.com"))
    add_provider(client, second, slug="second", label="Second")
    anna = person("anna")
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    assert location(link_via(anna, second, PASSWORD, slug="second", sub="anna-2")) == "/account?linked=second"
    anna.post("/api/me/email/provider")
    assert row("anna").email == "anna.sso@example.com"
    # One link goes, another holds: the address stays; with the last one it goes too.
    assert anna.delete("/api/oidc/second/link", headers=UI).status_code == 204
    assert row("anna").email == "anna.sso@example.com"
    assert anna.delete("/api/oidc/sso/link", headers=UI).status_code == 204
    assert row("anna").email == ""


def test_an_offered_address_another_account_holds_is_never_taken(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=False)
    ben_id = make_account("ben").id
    client.put(f"/api/accounts/{ben_id}/email", json={"address": "shared@example.com", "current_password": PASSWORD})
    anna = person("anna")
    link(anna, provider, "anna-1", email="shared@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == "shared@example.com"
    refused = anna.post("/api/me/email/provider")
    assert refused.status_code == 409 and code_of(refused) == "email_taken"
    assert row("anna").email == "" and row("ben").email == "shared@example.com"


def test_removing_the_provider_or_changing_its_issuer_takes_an_address_that_came_from_it(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    """The links go as if each account had unlinked itself: with the last one, an address from the provider."""
    from .oidc_helpers import fakes

    entry = add_provider(client, provider, auto_create=True)
    anna = person("anna")
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    anna.post("/api/me/email/provider")
    sign_in_via_oidc(fresh_browser(client), provider, sub="clara-1", email="clara@example.com",
                     preferred_username="clara")
    assert (row("anna").email, row("clara").email) == ("anna.sso@example.com", "clara@example.com")
    # Another issuer is another provider: its links go, and with them the addresses that came from there.
    moved = provider.network.add(fakes.FakeProvider("https://moved.example.com", client_id=provider.client_id,
                                                     client_secret=provider.client_secret))
    body = {key: entry[key] for key in ("label", "client_id", "scopes", "enabled", "auto_create",
                                         "trusts_second_factor")}
    saved = client.put(f"/api/oidc/admin/providers/{entry['id']}", json={**body, "issuer": moved.issuer},
                       headers=UI)
    assert saved.status_code == 200 and saved.json()["dropped"] == 2
    assert (row("anna").email, row("clara").email) == ("", "")
    # Removing the provider does the same.
    sign_in_via_oidc(fresh_browser(client), moved, sub="clara-1", email="clara@example.com",
                     preferred_username="clara")
    assert row("clara-2").email == "clara@example.com"
    assert client.delete(f"/api/oidc/admin/providers/{entry['id']}", headers=UI).status_code == 200
    assert row("clara-2").email == ""


def test_a_different_address_at_the_provider_is_offered_never_taken_unasked(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    mail_ready()
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    me = anna.get("/api/auth/me").json()
    assert me["email"] == "anna@example.com" and me["email_source"] == "own"
    assert me["provider_email"] == "anna.sso@example.com"
    # Signing in again through the provider changes nothing either.
    sign_in_via_oidc(fresh_browser(client), provider, sub="anna-1", email="anna.sso@example.com")
    assert row("anna").email == "anna@example.com"
    # No more asking about this one ...
    assert anna.delete("/api/me/email/provider").json()["provider_email"] == ""
    # ... but a newer one at the provider is offered again.
    sign_in_via_oidc(fresh_browser(client), provider, sub="anna-1", email="anna.work@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == "anna.work@example.com"
    taken = anna.post("/api/me/email/provider")
    assert taken.status_code == 200
    assert (taken.json()["email"], taken.json()["email_source"]) == ("anna.work@example.com", "provider")
    assert taken.json()["provider_email"] == ""
    # Unlinking now takes the provider's address with it; the own one is not coming back by itself.
    anna.delete("/api/oidc/sso/link", headers=UI)
    assert anna.get("/api/auth/me").json()["email"] == ""


def test_unlinking_keeps_an_own_address(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    mail_ready()
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    link(anna, provider, "anna-1", email="anna@example.com")
    assert anna.delete("/api/oidc/sso/link", headers=UI).status_code == 204
    me = anna.get("/api/auth/me").json()
    assert me["email"] == "anna@example.com" and me["email_source"] == "own" and me["provider_email"] == ""


def test_the_providers_address_is_no_longer_offered_once_the_provider_is_gone(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    mail_ready()
    entry = add_provider(client, provider, auto_create=False)
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    link(anna, provider, "anna-1", email="anna.sso@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == "anna.sso@example.com"
    # The operator removes the provider with its links: nothing is left to take the address from.
    assert client.delete(f"/api/oidc/admin/providers/{entry['id']}", headers=UI).status_code == 200
    me = anna.get("/api/auth/me").json()
    assert me["provider_email"] == "" and me["email"] == "anna@example.com"


def test_email_verified_is_never_read_an_address_marked_unconfirmed_counts_like_any_other(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    """The address finds nobody any more, so whether the provider vouches for it decides nothing (the blueprint)."""
    add_provider(client, provider, auto_create=False)
    anna = person("anna")
    link(anna, provider, "anna-1", email="anna.sso@example.com", email_verified=False)
    assert anna.get("/api/auth/me").json()["provider_email"] == "anna.sso@example.com"


def test_an_account_through_the_provider_only_follows_it_and_cannot_change_it_here(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    mail_ready()
    add_provider(client, provider, auto_create=True)
    browser = fresh_browser(client)
    sign_in_via_oidc(browser, provider, sub="clara-1", email="clara@example.com", preferred_username="clara")
    me = browser.get("/api/auth/me").json()
    assert me["sign_in"] == SIGN_IN_OIDC and me["email"] == "clara@example.com" and me["email_source"] == "provider"
    # The provider changed it: the next sign-in follows, whatever email_verified says.
    sign_in_via_oidc(fresh_browser(client), provider, sub="clara-1", email="clara.new@example.com")
    assert row("clara").email == "clara.new@example.com"
    sign_in_via_oidc(fresh_browser(client), provider, sub="clara-1", email="clara.x@example.com", email_verified=False)
    assert row("clara").email == "clara.x@example.com"
    for refused in (
        browser.put("/api/me/email", json={"address": "clara.own@example.com"}),
        browser.delete("/api/me/email"),
        client.put(f"/api/accounts/{row('clara').id}/email", json={"address": "c@example.com", "current_password": PASSWORD}),
    ):
        assert refused.status_code == 409 and code_of(refused) == "email_from_provider"
    assert postbox.mails == []


def test_a_provider_address_another_account_holds_is_not_followed(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=True)
    browser = fresh_browser(client)
    sign_in_via_oidc(browser, provider, sub="clara-1", email="clara@example.com", preferred_username="clara")
    client.put(f"/api/accounts/{make_account('ben').id}/email",
               json={"address": "ben@example.com", "current_password": PASSWORD})
    sign_in_via_oidc(fresh_browser(client), provider, sub="clara-1", email="ben@example.com")
    assert row("clara").email == "clara@example.com"


# --- The operator ------------------------------------------------------------------------------------------------------


def test_the_operator_sets_an_address_at_once_with_the_own_password_and_the_account_is_told(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    ben = person("ben")
    ben_id = row("ben").id
    wrong = client.put(f"/api/accounts/{ben_id}/email", json={"address": "ben@example.com", "current_password": "nope"})
    assert wrong.status_code == 401
    assert row("ben").email == ""
    answer = client.put(f"/api/accounts/{ben_id}/email", json={"address": "ben@example.com", "current_password": PASSWORD})
    assert answer.status_code == 200, answer.text
    assert (answer.json()["email"], answer.json()["email_source"]) == ("ben@example.com", "operator")
    # No mail server was needed and none was asked.
    assert postbox.mails == []
    notices = ben.get("/api/notices").json()
    assert [(item["kind"], item["actor"], item["subject"]) for item in notices] == [
        ("operator_email", "tester", "ben@example.com")
    ]
    listed = {item["name"]: item for item in client.get("/api/accounts").json()}
    assert listed["ben"]["email"] == "ben@example.com" and listed["ben"]["email_source"] == "operator"
    removed = client.put(f"/api/accounts/{ben_id}/email", json={"address": "", "current_password": PASSWORD})
    assert removed.json()["email"] == ""
    assert [item["kind"] for item in ben.get("/api/notices").json()] == ["operator_email_removed", "operator_email"]


def test_the_operator_cannot_give_an_address_another_account_holds_nor_a_broken_one(
    client: TestClient, operator: Account, postbox: Postbox
) -> None:
    anna_id, ben_id = make_account("anna").id, make_account("ben").id
    client.put(f"/api/accounts/{anna_id}/email", json={"address": "anna@example.com", "current_password": PASSWORD})
    taken = client.put(f"/api/accounts/{ben_id}/email", json={"address": "ANNA@example.com", "current_password": PASSWORD})
    assert taken.status_code == 409 and code_of(taken) == "email_taken"
    broken = client.put(f"/api/accounts/{ben_id}/email", json={"address": "ben@", "current_password": PASSWORD})
    assert broken.status_code == 422 and code_of(broken) == "email_invalid"
    assert row("ben").email == ""


def test_a_member_cannot_set_another_accounts_address(client: TestClient, operator: Account) -> None:
    ben = person("ben")
    refused = ben.put(f"/api/accounts/{operator.id}/email", json={"address": "x@example.com", "current_password": PASSWORD})
    assert refused.status_code == 403
    assert row("tester").email == ""


def test_the_operators_own_address_is_set_without_a_notice(client: TestClient, operator: Account) -> None:
    client.put(f"/api/accounts/{operator.id}/email", json={"address": "op@example.com", "current_password": PASSWORD})
    assert row("tester").email == "op@example.com"
    with SessionLocal() as db:
        assert db.query(SpaceNotice).count() == 0


def test_an_operator_address_replaces_a_waiting_one(client: TestClient, operator: Account, postbox: Postbox) -> None:
    mail_ready()
    ben = person("ben")
    ben.put("/api/me/email", json={"address": "ben.own@example.com"})
    token = postbox.link("ben.own@example.com")
    client.put(f"/api/accounts/{row('ben').id}/email", json={"address": "ben@example.com", "current_password": PASSWORD})
    assert confirm(token).status_code == 404
    assert row("ben").email == "ben@example.com"


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


def test_an_invitation_to_an_address_gives_the_new_account_that_address(client: TestClient, operator: Account) -> None:
    with SessionLocal() as db:
        by = db.get(Account, operator.id)
        _invite, token = accounts.create_invite(db, by, space_id=None, space_role="", days=7, email="new@example.com")
        made = accounts.accept_invite(db, token, "newbie", PASSWORD)
        assert (made.email, made.email_source) == ("new@example.com", "invite")


def test_an_invitation_to_an_address_another_account_holds_gives_no_address(client: TestClient, operator: Account) -> None:
    client.put(f"/api/accounts/{operator.id}/email", json={"address": "new@example.com", "current_password": PASSWORD})
    with SessionLocal() as db:
        by = db.get(Account, operator.id)
        _invite, token = accounts.create_invite(db, by, space_id=None, space_role="", days=7, email="NEW@example.com")
        made = accounts.accept_invite(db, token, "newbie", PASSWORD)
        assert made.email == "" and made.email_source == ""


def test_the_link_of_a_confirmation_never_stands_in_the_log() -> None:
    from app.services import logs

    token = "nxe_" + "Ab3_-" * 9
    for line in (f"GET /confirm-email/{token} 200", f"GET /api/confirm-email/{token}", f"opened {token}"):
        assert token[4:] not in logs.redact(line), line


@pytest.mark.parametrize("char", ["\x00", "\x07", "\x1b", "\x7f"])
def test_an_address_with_a_control_character_is_refused(
    client: TestClient, operator: Account, postbox: Postbox, char: str
) -> None:
    mail_ready()
    anna = person("anna")
    answer = anna.put("/api/me/email", json={"address": f"an{char}na@example.com"})
    assert answer.status_code == 422 and code_of(answer) == "email_invalid"
    assert postbox.mails == []


def test_the_providers_address_is_not_taken_when_another_account_holds_it(
    client: TestClient, operator: Account, postbox: Postbox, provider: FakeProvider
) -> None:
    mail_ready()
    add_provider(client, provider, auto_create=False)
    ben_id = make_account("ben").id
    anna = person("anna")
    anna.put("/api/me/email", json={"address": "anna@example.com"})
    confirm(postbox.link("anna@example.com"))
    link(anna, provider, "anna-1", email="shared@example.com")
    assert anna.get("/api/auth/me").json()["provider_email"] == "shared@example.com"
    # Meanwhile the operator gave that address to ben.
    client.put(f"/api/accounts/{ben_id}/email", json={"address": "shared@example.com", "current_password": PASSWORD})
    refused = anna.post("/api/me/email/provider")
    assert refused.status_code == 409 and code_of(refused) == "email_taken"
    assert row("anna").email == "anna@example.com"
