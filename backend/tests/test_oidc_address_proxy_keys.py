"""nexlore's own side of module 1.0.10, around the shared contract tests (``tests/nexoidc``): the sessions of the
version before the second-factor rule, the anchor of the way back on a database of 1.0.9, the public address (what
the settings page accepts, who may read it), the scheme a trusted proxy names, and the hint beside keys of an
account that must still set up a second factor.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import SESSION_VIA_PASSWORD, SESSION_VIA_PROVIDER, Account, OidcProvider, Setting
from app.security import hash_token, session_via
from app.services import oidc_store, settings_service, totp

from .conftest import PASSWORD, make_account, sign_in
from .oidc_helpers import UI, FakeProvider, add_provider, fresh_browser, link, location, sign_in_via_oidc
from .test_oidc_app import _legacy, _old, accounts_row

# --- A session the version before the column made, and the rule for one that says nothing --------------------------


def test_a_database_made_by_this_version_gives_the_columns_a_default_the_older_version_does_not_know_to_fill(
    operator: Account,
) -> None:
    """Nexlore 1.5.2 inserts ``auth_sessions`` rows without ``via``: on a database this version made fresh (the way
    back after a new installation) its sign-in must not break on a NOT NULL column without a default."""
    with SessionLocal() as db:
        sessions = {row[1]: row[4] for row in db.execute(text("PRAGMA table_info(auth_sessions)"))}
        entries = {row[1]: row[4] for row in db.execute(text("PRAGMA table_info(oidc_providers)"))}
    assert sessions["via"] == "'password'"
    assert entries["registered_redirect"] == "''"
    # The statement the older version's mapper sends: every column it knows, none of the new ones.
    with SessionLocal() as db:
        db.execute(
            text(
                "INSERT INTO auth_sessions (token_hash, account_id, created_at, expires_at, last_seen_at, ip,"
                " user_agent) VALUES ('old-session', :account, '2026-10-10 10:00:00', '2026-11-10 10:00:00',"
                " '2026-10-10 10:00:00', '', '')"
            ),
            {"account": operator.id},
        )
        db.commit()
        assert db.scalar(text("SELECT via FROM auth_sessions WHERE token_hash = 'old-session'")) == "password"


def test_a_session_without_a_way_in_counts_as_the_password_one() -> None:
    """``via`` NULL (a column added to a database by ALTER TABLE has no NOT NULL), empty or unknown: the stricter rule."""
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE auth_sessions (token_hash VARCHAR(64), via VARCHAR(16))"))
        for token, via in (("null", None), ("empty", ""), ("provider", SESSION_VIA_PROVIDER)):
            connection.execute(
                text("INSERT INTO auth_sessions (token_hash, via) VALUES (:hash, :via)"),
                {"hash": hash_token(token), "via": via},
            )
    with Session(engine) as db:
        assert session_via(db, "null") == SESSION_VIA_PASSWORD
        assert session_via(db, "empty") == SESSION_VIA_PASSWORD
        assert session_via(db, "provider") == SESSION_VIA_PROVIDER
        assert session_via(db, "nobody") == SESSION_VIA_PASSWORD
        assert session_via(db, None) == SESSION_VIA_PASSWORD


def _require_second_factor(on: bool) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"two_factor_required": on})


def _anna_through_the_provider(client: TestClient, provider: FakeProvider) -> TestClient:
    """anna (a password account without a second factor) linked to the provider, signed in through it."""
    add_provider(client, provider, trusts_second_factor=True)
    make_account("anna")
    member = fresh_browser()
    sign_in(member, accounts_row("anna"))
    assert location(link(member, provider, PASSWORD, sub="anna-1")) == "/account?linked=sso"
    _require_second_factor(True)
    through = fresh_browser()
    assert location(sign_in_via_oidc(through, provider, sub="anna-1")) == "/"
    return through


def test_a_session_whose_way_in_is_empty_or_unknown_is_made_to_enrol_like_a_password_one(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    through = _anna_through_the_provider(client, provider)
    assert through.get("/api/spaces").status_code == 200
    for way in ("", "something else"):
        with SessionLocal() as db:
            db.execute(text("UPDATE auth_sessions SET via = :way WHERE via = 'provider'"), {"way": way})
            db.commit()
        refused = through.get("/api/spaces")
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "second_factor_setup_required", way
        assert through.get("/api/auth/me").json()["second_factor_setup_required"] is True
        with SessionLocal() as db:
            db.execute(text("UPDATE auth_sessions SET via = 'provider' WHERE via = :way"), {"way": way})
            db.commit()
        assert through.get("/api/spaces").status_code == 200


# --- Keys have no session: the page says so beside them ----------------------------------------------------------------


def test_keys_of_an_account_without_a_second_factor_are_marked_even_where_the_session_is_spared(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    """A password account without a factor, in a session a trusting provider spared: nothing to enrol for the page,
    but tokens, MCP and OAuth keys and the calendar address ask the account and stay dead. ``me`` says so."""
    through = _anna_through_the_provider(client, provider)
    spared = through.get("/api/auth/me").json()
    assert spared["second_factor_setup_required"] is False and spared["keys_need_second_factor"] is True
    # The same account with its password has to enrol, and its keys wait as well.
    with_password = fresh_browser()
    assert with_password.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
    blocked = with_password.get("/api/auth/me").json()
    assert blocked["second_factor_setup_required"] is True and blocked["keys_need_second_factor"] is True
    # Once the account has a factor, or the operator asks for none, there is nothing to say.
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="anna").one()
        row.totp_secret_enc = totp.seal_seed(totp.generate_seed())
        db.commit()
    assert through.get("/api/auth/me").json()["keys_need_second_factor"] is False
    with SessionLocal() as db:
        db.query(Account).filter_by(name="anna").update({"totp_secret_enc": ""})
        db.commit()
    assert through.get("/api/auth/me").json()["keys_need_second_factor"] is True
    _require_second_factor(False)
    assert through.get("/api/auth/me").json()["keys_need_second_factor"] is False


def test_an_account_that_only_has_the_provider_has_no_hint(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    add_provider(client, provider, auto_create=True)
    _require_second_factor(True)
    new = fresh_browser()
    assert location(sign_in_via_oidc(new, provider, sub="neo-1", preferred_username="neo")) == "/"
    assert new.get("/api/auth/me").json()["keys_need_second_factor"] is False


# --- The anchor of the way back on a database of 1.0.9 ------------------------------------------------------------------


class _Lines(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def _anchor() -> str | None:
    with SessionLocal() as db:
        return oidc_store.stored_anchor(db)


def _forget_the_anchor() -> None:
    """A database as 1.0.9 left it: no anchor yet."""
    with SessionLocal() as db:
        db.query(Setting).filter(Setting.key == oidc_store.ANCHOR).delete()
        db.commit()


def _start_logging() -> _Lines:
    lines = _Lines()
    logging.getLogger("nexlore.oidc").addHandler(lines)
    return lines


def test_the_anchor_is_the_issuer_of_the_old_settings_from_the_migration_on(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    assert oidc_store.migrate_settings(backup=False) is not None
    assert _anchor() == provider.issuer.rstrip("/")


def test_the_first_start_with_1_0_10_derives_the_anchor_and_leaves_the_old_settings_as_they_were(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    before = _old()
    _forget_the_anchor()
    lines = _start_logging()
    try:
        assert oidc_store.migrate_settings() is None
    finally:
        logging.getLogger("nexlore.oidc").removeHandler(lines)
    assert _anchor() == provider.issuer.rstrip("/")
    assert _old() == before
    assert not [line for line in lines.lines if "took over" in line], lines.lines
    # Off: the issuer stays in the old settings, so the anchor is derived from it all the same, and on again brings the
    # client back.
    with SessionLocal() as db:
        row = db.get(OidcProvider, entry.id)
        row.enabled = False
        db.commit()
    assert oidc_store.migrate_settings() is None
    off = _old()
    assert off["client"] == "" and str(off["issuer"]).rstrip("/") == provider.issuer.rstrip("/")
    _forget_the_anchor()
    assert oidc_store.migrate_settings() is None
    assert _anchor() == provider.issuer.rstrip("/") and _old() == off
    with SessionLocal() as db:
        db.get(OidcProvider, entry.id).enabled = True
        db.commit()
    assert oidc_store.migrate_settings() is None
    assert _old() == before


def test_a_way_back_that_1_0_9_had_closed_stays_closed_after_the_first_start_with_1_0_10(
    client: TestClient, operator: Account, provider: FakeProvider
) -> None:
    make_account("anna")
    _legacy(provider, label="Company", subjects={"anna": "anna-1"})
    entry = oidc_store.migrate_settings(backup=False)
    assert entry is not None
    # Another issuer here: the old settings go empty for good.
    other = provider.network.add(FakeProvider("https://moved.example.com"))  # type: ignore[attr-defined]
    answer = client.put(
        f"/api/oidc/admin/providers/{entry.id}",
        json={"label": "Company", "issuer": other.issuer, "client_id": other.client_id,
              "client_secret": other.client_secret, "trusts_second_factor": True},
        headers=UI,
    )
    assert answer.status_code == 200, answer.text
    assert _old()["issuer"] == "" and _old()["subjects"]["anna"] == ""
    _forget_the_anchor()
    assert oidc_store.migrate_settings() is None
    assert _anchor() == "-" and _old()["issuer"] == "" and _old()["subjects"]["anna"] == ""


# --- The public address -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "http://my_host",
        "https://" + ".".join(["a" * 60] * 4) + ".com",
        "https://bücher.example.org",
    ],
)
def test_the_settings_page_takes_no_address_the_sign_in_module_would_refuse(
    client: TestClient, operator: Account, value: str
) -> None:
    answer = client.put("/api/settings", json={"public_url": value}, headers=UI)
    assert answer.status_code == 422 and answer.json()["detail"]["code"] == "invalid_url", value
    with SessionLocal() as db:
        assert settings_service.get(db, "public_url") == ""


def test_the_settings_page_stores_the_address_the_way_the_module_does(client: TestClient, operator: Account) -> None:
    answer = client.put("/api/settings", json={"public_url": "HTTPS://Notes.Example.com/"}, headers=UI)
    assert answer.status_code == 200 and answer.json()["public_url"] == "https://notes.example.com"
    assert client.put("/api/settings", json={"public_url": ""}, headers=UI).json()["public_url"] == ""


def test_the_address_card_is_the_operators(client: TestClient, operator: Account) -> None:
    make_account("anna")
    member = fresh_browser()
    sign_in(member, accounts_row("anna"))
    assert member.get("/api/oidc/authentik/address").status_code in (401, 403)
    assert member.post("/api/oidc/authentik/address", json={"public_url": "https://a.example.org"}, headers=UI
                       ).status_code in (401, 403)
    assert member.get("/api/oidc/authentik/blueprint").status_code in (401, 403)
    assert client.get("/api/oidc/authentik/address").status_code == 200


# --- The scheme a proxy names -------------------------------------------------------------------------------------------

PROXY = "10.9.0.5"


def _behind(peer: str, proto: str | None = "https") -> TestClient:
    headers = {**UI, **({"X-Forwarded-Proto": proto} if proto is not None else {})}
    return TestClient(app, base_url="http://testserver", client=(peer, 50000), follow_redirects=False, headers=headers)


def _seen(peer: str, proto: str | None = "https") -> str:
    """What the server takes its own address for, asked as the operator through ``peer``."""
    browser = _behind(peer, proto)
    sign_in(browser, accounts_row("tester"))
    answer = browser.get("/api/oidc/authentik/address")
    assert answer.status_code == 200, answer.text
    return str(answer.json()["seen"])


def test_the_scheme_comes_from_a_proxy_nexlore_trusts_and_from_nobody_else(
    client: TestClient, operator: Account, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No list of proxies: the header counts for nothing, as before.
    assert _seen(PROXY).startswith("http://")
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.9.0.0/16")
    # The proxy of the list: https is taken, and only the scheme (the host stays what the proxy passed on).
    assert _seen(PROXY) == "https://testserver"
    assert _seen(PROXY, "https, http") == "https://testserver"
    assert _seen(PROXY, "HTTP") == "http://testserver"
    # Nonsense is not a scheme, and no header leaves it alone.
    assert _seen(PROXY, "gopher").startswith("http://")
    assert _seen(PROXY, None).startswith("http://")
    # Anybody else may write the header all day.
    assert _seen("10.8.0.5").startswith("http://")
    assert _seen("203.0.113.9").startswith("http://")


def test_the_return_address_of_a_sign_in_through_a_trusted_proxy_is_https(
    client: TestClient, operator: Account, provider: FakeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_provider(client, provider)
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.9.0.0/16")

    def redirect_uri(peer: str) -> str:
        target = location(_behind(peer).get("/api/oidc/sso/start"))
        from .oidc_helpers import fakes

        return fakes.query_of(target)["redirect_uri"]

    assert redirect_uri(PROXY) == "https://testserver/api/oidc/sso/callback"
    assert redirect_uri("10.8.0.5") == "http://testserver/api/oidc/sso/callback"
