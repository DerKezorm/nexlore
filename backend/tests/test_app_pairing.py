"""Pairing the iPhone app (block S1): the pairing in the browser, picking the key up, the operator's latch, the
devices in the profile, and who the key says it is (``/api/app/1/me``).

The world: ``anna`` manages ``Garden`` and reads ``Shared`` (bob's); ``Secret`` is bob's alone.
"""

from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.db import SessionLocal
from app.main import app
from app.models import AppDevice, AppPairing, utcnow
from app.services import devices, index

from .conftest import join
from .test_mcp import person, switch

ADDRESS = "https://notes.example.com/lore"


def phone() -> TestClient:
    """The app: no cookie, no tab."""
    return TestClient(app, base_url="http://testserver")


def pair(owner: TestClient, name: str = "Anna's iPhone") -> str:
    made = owner.post("/api/app-pairing", json={"address": ADDRESS})
    assert made.status_code == 201, made.text
    body = made.json()
    secret = re.search(r"secret=([^&]+)", body["link"]).group(1)  # type: ignore[union-attr]
    picked = phone().post(f"/api/app/1/pairing/{body['id']}/key", json={"device": name},
                          headers={"X-Pairing-Secret": secret})
    assert picked.status_code == 200, picked.text
    return picked.json()["key"]


def bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


@pytest.fixture
def world(client: TestClient, operator: object, vault: Path) -> dict[str, TestClient]:
    anna, bob = person("anna"), person("bob")
    for owner, name in ((anna, "Garden"), (bob, "Secret"), (bob, "Shared")):
        assert owner.post("/api/spaces", json={"name": name}).status_code == 201
    join(bob, "Shared", "anna", "read")
    (vault / "Garden" / "Plan.md").write_bytes(b"# Plan\n")
    index.scan()
    return {"operator": client, "anna": anna, "bob": bob}


def test_a_pairing_has_a_code_a_link_and_a_qr_code(world: dict[str, TestClient]) -> None:
    made = world["anna"].post("/api/app-pairing", json={"address": ADDRESS + "/"})
    assert made.status_code == 201
    body = made.json()
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}", body["code"])
    assert body["address"] == ADDRESS
    assert body["link"].startswith("nexlore://connect?address=https%3A%2F%2Fnotes.example.com%2Flore&pairing=")
    assert "&secret=" in body["link"]
    assert body["qr_svg"].startswith("<svg") and "viewBox" in body["qr_svg"]
    assert world["anna"].get(f"/api/app-pairing/{body['id']}").json() == {"state": "waiting", "device": ""}
    with SessionLocal() as db:
        row = db.get(AppPairing, body["id"])
        assert row is not None
        # Neither the secret nor the code is kept as it is.
        assert body["code"].replace("-", "") not in (row.code_hash, row.secret_hash)
        assert (row.expires_at - row.created_at) == timedelta(minutes=10)


def test_the_public_address_wins_and_without_any_address_there_is_no_pairing(world: dict[str, TestClient]) -> None:
    switch(public_url="https://lore.example.com")
    assert world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()["address"] == (
        "https://lore.example.com")
    switch(public_url="")
    missing = world["anna"].post("/api/app-pairing", json={"address": "not an address"})
    assert missing.status_code == 422
    assert missing.json()["detail"]["code"] == "app_address_missing"


def test_at_most_five_pairings_wait(world: dict[str, TestClient]) -> None:
    for _ in range(5):
        assert world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).status_code == 201
    sixth = world["anna"].post("/api/app-pairing", json={"address": ADDRESS})
    assert sixth.status_code == 409
    assert sixth.json()["detail"]["code"] == "app_too_many_pairings"
    # Another account has its own five.
    assert world["bob"].post("/api/app-pairing", json={"address": ADDRESS}).status_code == 201


def test_the_key_is_picked_up_once_with_the_secret(world: dict[str, TestClient]) -> None:
    body = world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()
    secret = re.search(r"secret=([^&]+)", body["link"]).group(1)  # type: ignore[union-attr]
    url = f"/api/app/1/pairing/{body['id']}/key"
    wrong = phone().post(url, json={"device": "x"}, headers={"X-Pairing-Secret": "wrong"})
    assert wrong.status_code == 404 and wrong.json()["detail"]["code"] == "app_pairing_unknown"
    unknown = phone().post("/api/app/1/pairing/nothing/key", json={}, headers={"X-Pairing-Secret": secret})
    assert unknown.status_code == 404 and unknown.json()["detail"]["code"] == "app_pairing_unknown"
    picked = phone().post(url, json={"device": "Anna's iPhone"}, headers={"X-Pairing-Secret": secret})
    assert picked.status_code == 200
    assert picked.headers["cache-control"] == "no-store"
    answer = picked.json()
    assert answer["key"].startswith("nxd_")
    assert answer["account"]["name"] == "anna" and isinstance(answer["account"]["id"], int)
    again = phone().post(url, json={"device": "y"}, headers={"X-Pairing-Secret": secret})
    assert again.status_code == 404 and again.json()["detail"]["code"] == "app_pairing_unknown"
    assert world["anna"].get(f"/api/app-pairing/{body['id']}").json() == {"state": "connected",
                                                                         "device": "Anna's iPhone"}
    with SessionLocal() as db:
        row = db.scalar(select(AppDevice))
        assert row is not None and row.name == "Anna's iPhone"
        assert row.key_hash == devices.digest(answer["key"]) and answer["key"] not in row.key_hash


def test_the_short_code_takes_dashes_spaces_and_small_letters(world: dict[str, TestClient]) -> None:
    body = world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()
    typed = " " + body["code"].lower().replace("-", " - ") + " "
    picked = phone().post("/api/app/1/pairing/code", json={"code": typed, "device": "Phone"})
    assert picked.status_code == 200, picked.text
    assert picked.json()["account"]["name"] == "anna"
    used = phone().post("/api/app/1/pairing/code", json={"code": body["code"], "device": "Phone"})
    assert used.status_code == 404 and used.json()["detail"]["code"] == "app_pairing_unknown"


def test_an_expired_or_withdrawn_pairing_is_unknown(world: dict[str, TestClient]) -> None:
    old = world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()
    with SessionLocal() as db:
        db.execute(update(AppPairing).where(AppPairing.id == old["id"]).values(expires_at=utcnow()))
        db.commit()
    assert world["anna"].get(f"/api/app-pairing/{old['id']}").json()["state"] == "expired"
    late = phone().post("/api/app/1/pairing/code", json={"code": old["code"], "device": "x"})
    assert late.status_code == 404 and late.json()["detail"]["code"] == "app_pairing_unknown"
    gone = world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()
    assert world["anna"].delete(f"/api/app-pairing/{gone['id']}").status_code == 204
    withdrawn = phone().post("/api/app/1/pairing/code", json={"code": gone["code"], "device": "x"})
    assert withdrawn.status_code == 404
    # Somebody else's pairing is not there for bob.
    mine = world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()
    assert world["bob"].get(f"/api/app-pairing/{mine['id']}").status_code == 404
    assert world["bob"].delete(f"/api/app-pairing/{mine['id']}").json()["detail"]["code"] == "app_pairing_unknown"


def test_guessing_codes_meets_the_sign_in_brake(world: dict[str, TestClient]) -> None:
    for _ in range(5):
        assert phone().post("/api/app/1/pairing/code", json={"code": "AAAA-AAAA", "device": "x"}).status_code == 404
    braked = phone().post("/api/app/1/pairing/code", json={"code": "AAAA-AAAA", "device": "x"})
    assert braked.status_code == 429
    assert braked.json()["detail"]["code"] == "too_many"
    assert int(braked.headers["retry-after"]) > 0
    # The QR code's way counts at the same brake.
    assert phone().post("/api/app/1/pairing/x/key", json={}, headers={"X-Pairing-Secret": "y"}).status_code == 429


def test_the_operator_closes_the_app_and_the_devices_stay(world: dict[str, TestClient]) -> None:
    key = pair(world["anna"])
    assert world["anna"].get("/api/app-pairing/allowed").json() == {"allowed": True}
    assert world["operator"].get("/api/settings").json()["app_pairing_allowed"] is True
    member = world["anna"].put("/api/app-pairing/allowed", json={"allowed": False})
    assert member.status_code == 403 and member.json()["detail"]["code"] == "operator_only"
    waiting = world["anna"].post("/api/app-pairing", json={"address": ADDRESS}).json()
    assert world["operator"].put("/api/app-pairing/allowed", json={"allowed": False}).json() == {"allowed": False}
    closed = phone().get("/api/app/1/me", headers=bearer(key))
    assert closed.status_code == 403 and closed.json()["detail"]["code"] == "app_disabled"
    refused = world["anna"].post("/api/app-pairing", json={"address": ADDRESS})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "app_disabled"
    pickup = phone().post("/api/app/1/pairing/code", json={"code": waiting["code"], "device": "x"})
    assert pickup.status_code == 403 and pickup.json()["detail"]["code"] == "app_disabled"
    assert len(world["anna"].get("/api/app-devices").json()) == 1
    # Through the settings too, and open again the device works as before.
    world["operator"].put("/api/settings", json={"app_pairing_allowed": True})
    assert phone().get("/api/app/1/me", headers=bearer(key)).status_code == 200


def test_me_names_the_account_the_device_and_the_spaces_it_reads(world: dict[str, TestClient]) -> None:
    key = pair(world["anna"], "Anna's iPhone")
    world["anna"].put("/api/me/profile", json={"display_name": "Anna Example"})
    assert world["anna"].put("/api/looks", json={"path": "Garden", "icon": "leaf", "color": "#a3e635"}).status_code == 204
    me = phone().get("/api/app/1/me", headers=bearer(key))
    assert me.status_code == 200, me.text
    body = me.json()
    assert body["account"]["name"] == "Anna Example" and body["account"]["username"] == "anna"
    assert body["account"]["operator"] is False
    assert body["device"]["name"] == "Anna's iPhone"
    assert set(body["features"]) >= {"changes", "batch", "files", "wait", "base"}
    spaces = {space["name"]: space for space in body["spaces"]}
    assert set(spaces) == {"Garden", "Shared"}
    assert spaces["Garden"]["icon"] == "leaf" and spaces["Garden"]["color"] == "#a3e635"
    assert spaces["Garden"]["role"] == "manage" and spaces["Shared"]["role"] == "read"
    assert isinstance(spaces["Garden"]["id"], int)
    assert set(spaces["Garden"]) >= {"id", "name", "role", "color", "icon"}


def test_only_a_device_key_opens_the_app_and_it_opens_nothing_else(world: dict[str, TestClient]) -> None:
    key = pair(world["anna"])
    assert phone().get("/api/app/1/me").json()["detail"]["code"] == "not_signed_in"
    assert phone().get("/api/app/1/me", headers=bearer("nxd_nothing")).status_code == 401
    # The browser's cookie counts for nothing here.
    cookie = world["anna"].get("/api/app/1/me")
    assert cookie.status_code == 401 and cookie.json()["detail"]["code"] == "not_signed_in"
    switch(api_tokens_allowed=True)
    token = world["anna"].post("/api/api-tokens", json={"name": "n8n", "level": "write"}).json()["secret"]
    assert phone().get("/api/app/1/me", headers=bearer(token)).status_code == 401
    # And the device key nowhere outside.
    assert phone().get("/api/v1/me", headers=bearer(key)).status_code == 401
    assert phone().get("/api/spaces", headers=bearer(key)).status_code == 401
    assert phone().post("/api/mcp", headers=bearer(key), json={}).status_code in (401, 404)


def test_a_device_shows_in_the_profile_and_goes_when_disconnected(world: dict[str, TestClient]) -> None:
    key = pair(world["anna"], "Pocket")
    listed = world["anna"].get("/api/app-devices").json()
    assert [entry["name"] for entry in listed] == ["Pocket"]
    assert listed[0]["last_seen_at"] is None
    phone().get("/api/app/1/me", headers=bearer(key))
    assert world["anna"].get("/api/app-devices").json()[0]["last_seen_at"] is not None
    assert world["bob"].delete(f"/api/app-devices/{listed[0]['id']}").status_code == 404
    assert world["bob"].get("/api/app-devices").json() == []
    assert world["anna"].delete(f"/api/app-devices/{listed[0]['id']}").status_code == 204
    assert phone().get("/api/app/1/me", headers=bearer(key)).json()["detail"]["code"] == "not_signed_in"


def test_the_device_disconnects_itself(world: dict[str, TestClient]) -> None:
    key = pair(world["anna"])
    assert phone().delete("/api/app/1/device", headers=bearer(key)).status_code == 204
    assert phone().get("/api/app/1/me", headers=bearer(key)).status_code == 401
    assert world["anna"].get("/api/app-devices").json() == []


def test_signing_out_everywhere_and_a_new_password_disconnect_the_devices(world: dict[str, TestClient]) -> None:
    first = pair(world["anna"])
    assert world["anna"].post("/api/auth/logout-all").status_code == 204
    assert phone().get("/api/app/1/me", headers=bearer(first)).status_code == 401
    second = pair(world["anna"])
    changed = world["anna"].put("/api/auth/password", json={"current": "correct horse battery",
                                                            "new": "another horse battery"})
    assert changed.status_code == 204, changed.text
    assert phone().get("/api/app/1/me", headers=bearer(second)).status_code == 401
    third = pair(world["bob"])
    with SessionLocal() as db:
        bob_id = db.scalar(select(AppDevice.account_id))
    reset = world["operator"].put(f"/api/accounts/{bob_id}/password",
                                  json={"password": "a brand new password", "current_password": "correct horse battery"})
    assert reset.status_code == 204, reset.text
    assert phone().get("/api/app/1/me", headers=bearer(third)).status_code == 401


def test_a_device_has_a_rate(world: dict[str, TestClient], monkeypatch: pytest.MonkeyPatch) -> None:
    key = pair(world["anna"])
    monkeypatch.setattr(devices, "PER_MINUTE", 3)
    for _ in range(3):
        assert phone().get("/api/app/1/me", headers=bearer(key)).status_code == 200
    braked = phone().get("/api/app/1/me", headers=bearer(key))
    assert braked.status_code == 429
    assert braked.json()["detail"]["code"] == "too_many" and braked.headers["retry-after"] == "60"
