"""Security review before 1.0.0, nexlore on the internet: the first setup, the sign-in brake, the operator's network."""

from __future__ import annotations

import logging
import threading

import pytest
from fastapi.testclient import TestClient

from app import security
from app.config import get_settings
from app.main import app
from app.security import DEVICE_COOKIE, brake
from app.services import accounts

from .conftest import PASSWORD, SETUP_CODE, make_account

GOOD = "a long enough password"


def fresh(host: str = "203.0.113.7") -> TestClient:
    return TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-hardening0"},
                      client=(host, 50000))


# --- The first setup ------------------------------------------------------------------------------------------------


def test_setup_without_the_code_or_with_a_wrong_one_is_refused(client: TestClient) -> None:
    assert client.get("/api/setup").json()["code_required"] is True
    for code in ("", "guess"):
        refused = client.post("/api/setup", json={"name": "boss", "password": GOOD, "code": code})
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "setup_code_wrong"
    assert client.get("/api/setup").json()["needs_setup"] is True
    made = client.post("/api/setup", json={"name": "boss", "password": GOOD, "code": SETUP_CODE})
    assert made.status_code == 200


def test_guessing_the_setup_code_is_braked(client: TestClient) -> None:
    brake.forget()
    answers = [client.post("/api/setup", json={"name": "boss", "password": GOOD, "code": f"g{n}"}).status_code
               for n in range(7)]
    assert answers[:5] == [403] * 5 and answers[-1] == 429
    brake.forget()


def test_without_a_given_token_nexlore_makes_a_code_and_writes_it_to_the_log(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(get_settings(), "setup_token", "")
    monkeypatch.setattr(accounts, "_generated_code", None)
    code = accounts.setup_code()
    assert len(code) == 14 and code == accounts.setup_code()
    from app.db import SessionLocal

    with caplog.at_level(logging.WARNING, logger="nexlore.auth"), SessionLocal() as db:
        accounts.announce_setup_code(db)
    assert code in caplog.text
    made = client.post("/api/setup", json={"name": "boss", "password": GOOD, "code": code.lower()})
    assert made.status_code == 200


def test_ten_setups_at_once_make_exactly_one_operator(client: TestClient) -> None:
    answers: list[int] = []
    start = threading.Barrier(10)

    def one(number: int) -> None:
        person = fresh(f"203.0.113.{number + 1}")
        start.wait()
        answers.append(person.post("/api/setup", json={"name": f"boss{number}", "password": GOOD,
                                                       "code": SETUP_CODE}).status_code)

    threads = [threading.Thread(target=one, args=(n,)) for n in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(answers) == [200] + [409] * 9


# --- Guessing passwords ---------------------------------------------------------------------------------------------


def lock(name: str) -> None:
    """A stranger's ten wrong passwords, each from a new address."""
    for number in range(10):
        brake.forget()
        fresh(f"198.51.100.{number + 1}").post("/api/auth/login", json={"name": name, "password": "wrong guess"})
    brake.forget()


def test_a_locked_account_still_lets_in_the_browser_that_signed_in_before(client: TestClient) -> None:
    make_account("anna")
    own = fresh("192.0.2.10")
    assert own.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200
    assert own.cookies.get(DEVICE_COOKIE)
    own.post("/api/auth/logout")
    lock("anna")
    stranger = fresh("198.51.100.99")
    refused = stranger.post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "wrong_credentials"
    assert own.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 200


def test_a_device_cookie_of_another_account_or_forged_does_not_open_a_lock(client: TestClient) -> None:
    make_account("anna")
    bob = make_account("bob")
    lock("anna")
    other = fresh()
    other.cookies.set(DEVICE_COOKIE, security.device_token(bob.id), path="/api/auth")
    assert other.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 401
    forged = fresh()
    forged.cookies.set(DEVICE_COOKIE, "1.abc." + "0f" * 16, path="/api/auth")  # well-formed, not signed
    assert forged.post("/api/auth/login", json={"name": "anna", "password": PASSWORD}).status_code == 401


def test_sixty_wrong_passwords_at_once_count_no_more_than_the_lock_allows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    make_account("anna")
    counted: list[int] = []
    original = accounts.note_failure

    def counting(db, account) -> None:  # type: ignore[no-untyped-def]
        counted.append(1)
        original(db, account)

    monkeypatch.setattr(accounts, "note_failure", counting)
    start = threading.Barrier(30)

    def one(number: int) -> None:
        person = fresh(f"198.51.{number // 200}.{number % 200 + 1}")
        start.wait()
        person.post("/api/auth/login", json={"name": "anna", "password": "wrong guess"})

    threads = [threading.Thread(target=one, args=(n,)) for n in range(30)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    brake.forget()
    assert len(counted) == 10


def test_behind_a_proxy_nexlore_was_not_told_about_a_stranger_does_not_freeze_everybody(client: TestClient) -> None:
    make_account("anna")
    make_account("bob")
    proxy = fresh("172.18.0.2")
    for number in range(8):
        proxy.post("/api/auth/login", json={"name": "anna", "password": "wrong guess"},
                   headers={"X-Forwarded-For": f"6.6.6.{number}"})
    answer = proxy.post("/api/auth/login", json={"name": "bob", "password": PASSWORD},
                        headers={"X-Forwarded-For": "7.7.7.7"})
    assert answer.status_code == 200
    brake.forget()


def test_signing_in_to_an_own_account_does_not_reset_the_brake_for_guessing_others(client: TestClient) -> None:
    make_account("mallory")
    for name in ("anna", "bob", "carl", "dora", "emil", "fred"):
        make_account(name)
    sprayer = fresh("203.0.113.50")
    answers = []
    for round_ in range(10):
        for name in ("anna", "bob", "carl", "dora"):
            answers.append(sprayer.post("/api/auth/login",
                                        json={"name": name, "password": f"guess {round_}"}).status_code)
        sprayer.post("/api/auth/login", json={"name": "mallory", "password": PASSWORD})
    assert 429 in answers
    brake.forget()


def test_ports_and_spellings_of_one_address_are_one_sender(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.deps import normal_address

    assert {normal_address(x) for x in ("7.7.7.7", "7.7.7.7:4000", "::ffff:7.7.7.7", "[::ffff:7.7.7.7]:1")} == {
        "7.7.7.7"}
    assert normal_address("2001:db8::1") == normal_address("[2001:db8::2]:443") == "2001:db8::/64"
    monkeypatch.setattr(get_settings(), "trusted_proxies", "10.9.0.0/16")
    proxy = fresh("10.9.0.1")
    answers = [proxy.post("/api/auth/login", json={"name": "nobody", "password": "x"},
                          headers={"X-Forwarded-For": f"7.7.7.7:{4000 + n}"}).status_code for n in range(7)]
    assert answers[-1] == 429
    brake.forget()


def test_checking_passwords_has_a_limit_and_answers_busy_beyond_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    make_account("anna")
    monkeypatch.setattr(security, "_hashing", threading.BoundedSemaphore(1))
    monkeypatch.setattr(security, "HASH_WAIT", 0.05)
    security._hashing.acquire()
    try:
        busy = fresh().post("/api/auth/login", json={"name": "anna", "password": PASSWORD})
    finally:
        security._hashing.release()
    assert busy.status_code == 503 and busy.json()["detail"]["code"] == "busy"


def test_the_brake_forgets_after_an_hour_and_keeps_its_table_small(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(security.time, "monotonic", lambda: clock[0])
    own = security.Brake()
    for _ in range(8):
        own.failed("x")
    assert own.wait_seconds("x") > 0
    clock[0] += own.FORGET_AFTER + 1
    assert own.wait_seconds("x") == 0
    monkeypatch.setattr(security.Brake, "MAX_KEYS", 100)
    for number in range(500):
        own.failed(f"k{number}")
    assert len(own._fails) <= 101


# --- Invitations and the operator's network ---------------------------------------------------------------------------


def test_trying_taken_names_on_an_invitation_is_braked(client: TestClient, operator: object) -> None:
    for name in ("anna", "bob", "carl", "dora", "emil", "fred", "gina", "hans", "ida"):
        make_account(name)
    link = client.post("/api/invites", json={"days": 7}).json()["link"].rsplit("/", 1)[-1]
    guest = fresh("203.0.113.77")
    answers = [guest.post(f"/api/invite/{link}", json={"name": name, "password": GOOD}).status_code
               for name in ("anna", "bob", "carl", "dora", "emil", "fred", "gina", "hans", "ida")]
    assert answers[:8] == [409] * 8 and answers[-1] == 429
    brake.forget()


def test_operator_settings_only_from_the_operator_networks(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    boss = make_account("boss", "operator")
    home, away = fresh("192.168.1.20"), fresh("203.0.113.9")
    for person in (home, away):
        assert person.post("/api/auth/login", json={"name": boss.name, "password": PASSWORD}).status_code == 200
    assert away.get("/api/accounts").status_code == 200
    monkeypatch.setattr(get_settings(), "operator_networks", "192.168.0.0/16")
    assert home.get("/api/accounts").status_code == 200
    refused = away.get("/api/accounts")
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "operator_network"
    # Everything else stays open from anywhere.
    assert away.get("/api/spaces").status_code == 200
