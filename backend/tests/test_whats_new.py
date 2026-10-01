""""What's new" (block X3): every account reads or puts it away for itself, the version it read is kept with it."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import __version__
from app.db import SessionLocal
from app.models import Account
from app.services import accounts

from .conftest import PASSWORD, sign_in
from .test_profile import person


def test_a_new_account_starts_with_its_version_read(client: TestClient, account: Account) -> None:
    # Made the way an invitation or the setup makes it, with a password or through the provider.
    with SessionLocal() as db:
        made = accounts.create_with_password(db, "anna", PASSWORD)
        db.expunge(made)
        assert accounts.create_oidc(db, "Bob", "subject-bob", "bob@example.com").whats_new_seen == __version__
    anna = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-anna0000"})
    sign_in(anna, made)
    me = anna.get("/api/auth/me").json()
    assert (me["version"], me["whats_new_seen"]) == (__version__, __version__)


def test_each_account_puts_it_away_for_itself(client: TestClient, account: Account) -> None:
    anna, bob = person("anna"), person("bob")
    # Both accounts come from an older version.
    with SessionLocal() as db:
        for row in db.query(Account).filter(Account.name.in_(["anna", "bob"])):
            row.whats_new_seen = "0.0.1"
        db.commit()
    assert anna.get("/api/auth/me").json()["whats_new_seen"] == "0.0.1"
    answer = anna.post("/api/me/whats-new/seen")
    assert answer.status_code == 200
    assert answer.json()["whats_new_seen"] == __version__
    assert anna.get("/api/auth/me").json()["whats_new_seen"] == __version__
    assert bob.get("/api/auth/me").json()["whats_new_seen"] == "0.0.1"


def test_only_a_signed_in_account_marks_it(client: TestClient) -> None:
    stranger = TestClient(client.app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-stranger"})
    assert stranger.post("/api/me/whats-new/seen").status_code == 401
