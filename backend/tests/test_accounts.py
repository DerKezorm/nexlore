"""Accounts: the first one, signing in, the brake and the lock, the own password and language, the operator's list."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import OPERATOR, Account, AuthSession, utcnow
from app.security import MAX_FAILURES, SESSION_COOKIE, decrypt_secret, encrypt_secret, hash_token
from app.services import settings_service

from .conftest import PASSWORD, make_account, sign_in

GOOD = "a long enough password"


def test_the_first_account_is_the_operator_and_only_the_first(client: TestClient) -> None:
    assert client.get("/api/setup").json()["needs_setup"] is True
    short = client.post("/api/setup", json={"name": "boss", "password": "short"})
    assert short.status_code == 422 and short.json()["detail"]["code"] == "password_too_short"
    made = client.post("/api/setup", json={"name": "Boss", "password": GOOD, "language": "de"})
    assert made.status_code == 200
    assert made.json()["name"] == "boss" and made.json()["role"] == OPERATOR and made.json()["language"] == "de"
    # Signed in right away.
    assert client.get("/api/auth/me").json()["name"] == "boss"
    assert client.get("/api/setup").json()["needs_setup"] is False
    again = client.post("/api/setup", json={"name": "other", "password": GOOD})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_set_up"


def test_setup_refuses_a_language_nexlore_does_not_have(client: TestClient) -> None:
    refused = client.post("/api/setup", json={"name": "boss", "password": GOOD, "language": "xx"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "unknown_language"


def test_sign_in_and_out(client: TestClient) -> None:
    make_account("anna")
    assert client.get("/api/auth/me").status_code == 401
    wrong = client.post("/api/auth/login", json={"name": "anna", "password": "wrong password here"})
    unknown = client.post("/api/auth/login", json={"name": "nobody", "password": "wrong password here"})
    # The same answer for a wrong password and an unknown name.
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["detail"] == unknown.json()["detail"]
    signed = client.post("/api/auth/login", json={"name": "ANNA ", "password": PASSWORD})
    assert signed.status_code == 200 and signed.json()["name"] == "anna"
    cookie = signed.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Secure" not in cookie
    token = client.cookies.get(SESSION_COOKIE)
    with SessionLocal() as db:
        # The database knows the hash only.
        assert db.scalar(select(AuthSession).where(AuthSession.token_hash == token)) is None
        assert db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token))) is not None
    assert client.get("/api/auth/me").json()["name"] == "anna"
    assert client.post("/api/auth/logout").status_code == 204
    client.cookies.set(SESSION_COOKIE, token)
    assert client.get("/api/auth/me").status_code == 401


def test_the_cookie_is_secure_behind_https(client: TestClient) -> None:
    make_account("anna")
    signed = client.post(
        "/api/auth/login", json={"name": "anna", "password": PASSWORD}, headers={"X-Forwarded-Proto": "https"}
    )
    assert "Secure" in signed.headers["set-cookie"]


def test_an_expired_session_is_gone(client: TestClient) -> None:
    anna = make_account("anna")
    sign_in(client, anna)
    with SessionLocal() as db:
        for row in db.scalars(select(AuthSession)):
            row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.get("/api/auth/me").status_code == 401
    with SessionLocal() as db:
        assert db.scalar(select(AuthSession)) is None


def test_the_brake_holds_a_guesser_back(client: TestClient) -> None:
    make_account("anna")
    for _ in range(5):
        assert client.post("/api/auth/login", json={"name": "anna", "password": "wrong password"}).status_code == 401
    held = client.post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
    # Even the right password waits: otherwise the brake would tell when a guess was right.
    assert held.status_code == 429 and int(held.headers["Retry-After"]) > 0


def test_the_account_locks_after_ten_failures_from_anywhere(client: TestClient) -> None:
    from app.security import brake

    make_account("anna")
    for number in range(MAX_FAILURES):
        # Every guess from another address: the brake per sender does not help, the lock per account does.
        brake.forget()
        response = client.post(
            "/api/auth/login", json={"name": "anna", "password": "wrong password"},
            headers={"X-Forwarded-For": f"10.0.0.{number}"},
        )
        assert response.status_code == 401
    brake.forget()
    locked = client.post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
    assert locked.status_code == 429 and locked.json()["detail"]["code"] == "account_locked"
    with SessionLocal() as db:
        row = db.scalar(select(Account).where(Account.name == "anna"))
        assert row is not None
        row.locked_until = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_forwarded_for_counts_only_from_a_trusted_proxy(client: TestClient, monkeypatch) -> None:
    from app.config import get_settings
    from app.deps import client_ip

    class Fake:
        def __init__(self, peer: str, forwarded: str) -> None:
            self.client = type("C", (), {"host": peer})()
            self.headers = {"x-forwarded-for": forwarded}

    assert client_ip(Fake("10.1.1.1", "1.2.3.4")) == "10.1.1.1"  # type: ignore[arg-type]
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.1.1.0/24")
    # The rightmost hop that is not a proxy: whatever the sender wrote left of it does not count.
    assert client_ip(Fake("10.1.1.1", "6.6.6.6, 1.2.3.4")) == "1.2.3.4"  # type: ignore[arg-type]
    assert client_ip(Fake("10.1.1.1", "1.2.3.4, 10.1.1.2")) == "1.2.3.4"  # type: ignore[arg-type]
    assert client_ip(Fake("9.9.9.9", "1.2.3.4")) == "9.9.9.9"  # type: ignore[arg-type]


def test_password_sign_in_off_keeps_the_operator_in(client: TestClient) -> None:
    make_account("anna")
    make_account("boss", OPERATOR)
    with SessionLocal() as db:
        settings_service.save(db, {"password_login": False})
    refused = client.post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "password_login_off"
    assert client.post("/api/auth/login", json={"name": "boss", "password": PASSWORD}).status_code == 200
    assert client.get("/api/auth/methods").json() == {"password": False, "oidc": False, "oidc_name": ""}


def test_changing_the_password_ends_the_other_sessions(client: TestClient) -> None:
    anna = make_account("anna")
    other = TestClient(client.app, headers={"X-Nexlore-Client": "tab-other0000"})
    sign_in(other, anna)
    sign_in(client, anna)
    wrong = client.put("/api/auth/password", json={"current": "not the password", "new": GOOD})
    assert wrong.status_code == 401
    too_short = client.put("/api/auth/password", json={"current": PASSWORD, "new": "short"})
    assert too_short.status_code == 422
    assert client.put("/api/auth/password", json={"current": PASSWORD, "new": GOOD}).status_code == 204
    assert client.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 401
    client.cookies.clear()
    assert client.post("/api/auth/login", json={"name": "anna", "password": GOOD}).status_code == 200


def test_a_wrong_current_password_counts_like_a_wrong_sign_in(client: TestClient) -> None:
    anna = make_account("anna")
    sign_in(client, anna)
    for _ in range(5):
        client.put("/api/auth/password", json={"current": "guess guess guess", "new": GOOD})
    held = client.put("/api/auth/password", json={"current": PASSWORD, "new": GOOD})
    assert held.status_code == 429


def test_the_own_language(client: TestClient) -> None:
    sign_in(client, make_account("anna"))
    assert client.put("/api/me/language", json={"language": "de"}).json()["language"] == "de"
    assert client.get("/api/auth/me").json()["language"] == "de"
    assert client.put("/api/me/language", json={"language": "xx"}).status_code == 422
    assert client.put("/api/me/language", json={"language": ""}).json()["language"] == ""


def test_the_operator_manages_accounts(client: TestClient, operator: Account) -> None:
    anna = make_account("anna")
    listed = client.get("/api/accounts").json()
    assert [row["name"] for row in listed] == ["tester", "anna"]
    assert "password_hash" not in listed[0]
    assert client.put(f"/api/accounts/{operator.id}/role", json={"role": "member"}).status_code == 409
    assert client.delete(f"/api/accounts/{operator.id}").status_code == 409
    anna_client = TestClient(client.app, headers={"X-Nexlore-Client": "tab-anna00000"})
    sign_in(anna_client, anna)
    assert anna_client.get("/api/accounts").status_code == 403
    assert client.put(f"/api/accounts/{anna.id}/password", json={"password": GOOD}).status_code == 204
    # A new password from the operator ends the account's sessions.
    assert anna_client.get("/api/auth/me").status_code == 401
    sign_in(anna_client, anna)
    assert client.post(f"/api/accounts/{anna.id}/sign-out").status_code == 204
    assert anna_client.get("/api/auth/me").status_code == 401
    assert client.put(f"/api/accounts/{anna.id}/role", json={"role": "operator"}).json()["role"] == OPERATOR
    assert client.delete(f"/api/accounts/{anna.id}").status_code == 204
    assert [row["name"] for row in client.get("/api/accounts").json()] == ["tester"]


def test_changes_without_the_tab_header_are_refused_even_with_a_session(client: TestClient) -> None:
    anna = make_account("anna")
    bare = TestClient(client.app)
    sign_in(bare, anna)
    # A form from another site carries the cookie but cannot add a header.
    refused = bare.put("/api/me/language", json={"language": "de"})
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "client_required"


def test_server_secrets_are_encrypted_and_bound_to_the_key(monkeypatch) -> None:
    from app.config import get_settings

    sealed = encrypt_secret("smtp password")
    assert "smtp password" not in sealed and decrypt_secret(sealed) == "smtp password"
    monkeypatch.setattr(get_settings(), "secret_key", "another key entirely")
    assert decrypt_secret(sealed) == ""
