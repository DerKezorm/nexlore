"""A display name per account (block X1): changed by the account itself, shown to whoever shares a space with it,
to nobody else; the name stays what one signs in with and writes after @."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.models import Account

from .conftest import join, make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def test_the_own_display_name_is_set_cleaned_and_taken_back(client: TestClient, account: Account) -> None:
    answer = client.put("/api/me/profile", json={"display_name": "  Tess   Ter  "})
    assert answer.status_code == 200
    assert answer.json()["display_name"] == "Tess Ter"
    assert client.get("/api/auth/me").json()["display_name"] == "Tess Ter"
    # The name to sign in with does not change.
    assert client.get("/api/auth/me").json()["name"] == "tester"
    assert client.put("/api/me/profile", json={"display_name": ""}).json()["display_name"] == ""


def test_a_display_name_is_not_too_long_and_has_no_control_characters(client: TestClient, account: Account) -> None:
    assert client.put("/api/me/profile", json={"display_name": "x" * 80}).status_code == 200
    long = client.put("/api/me/profile", json={"display_name": "x" * 81})
    assert (long.status_code, long.json()["detail"]["code"]) == (422, "display_name_too_long")
    control = client.put("/api/me/profile", json={"display_name": "Tess\nTer"})
    assert (control.status_code, control.json()["detail"]["code"]) == (422, "display_name_invalid")
    assert client.get("/api/auth/me").json()["display_name"] == "x" * 80


def test_display_names_reach_whoever_shares_a_space_and_nobody_else(client: TestClient, account: Account) -> None:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    join(anna, "Garden", "bob", "read")
    for who, shown in ((anna, "Anna Berg"), (bob, "Bob Stein"), (carl, "Carl Weiss")):
        assert who.put("/api/me/profile", json={"display_name": shown}).status_code == 200
    asked = {"name": ["anna", "bob", "carl", "nobody"]}
    # Bob shares Garden with Anna: her name, his own; not Carl's, and an unknown name is no different.
    assert bob.get("/api/people", params=asked).json() == {"anna": "Anna Berg", "bob": "Bob Stein"}
    # Names are asked as written after @, in any case.
    assert bob.get("/api/people", params={"name": ["Anna"]}).json() == {"anna": "Anna Berg"}
    # Carl shares nothing: only his own.
    assert carl.get("/api/people", params=asked).json() == {"carl": "Carl Weiss"}
    # The operator sees every account, as with profile pictures.
    assert client.get("/api/people", params=asked).json() == {"anna": "Anna Berg", "bob": "Bob Stein", "carl": "Carl Weiss"}
    # An account without a display name comes back as nothing: the name is what shows.
    assert anna.put("/api/me/profile", json={"display_name": ""}).status_code == 200
    assert bob.get("/api/people", params={"name": ["anna"]}).json() == {}
    assert client.get("/api/people").json() == {}
