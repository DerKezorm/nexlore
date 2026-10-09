"""Microsoft Entra ID with ``common`` or ``organizations`` as the issuer, against a fake Entra.

Entra's discovery at ``.../common/v2.0`` names ``.../{tenantid}/v2.0`` as its issuer, and every token carries the
real tenant in ``iss`` and ``tid``. The tokens here are real RS256 tokens signed with the key of ``test_oidc``; the
fake answers discovery, keys and the token endpoint like Entra, under Entra's addresses. No test touches the network.
"""

from __future__ import annotations

import asyncio
import base64
import time
from collections.abc import Iterator
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import Account
from app.services import oidc

from .test_oidc import _KEY_PEM, CLIENT_ID, CLIENT_SECRET, CODE, KID, UI, _invite, _jwk, account_count, fresh_browser

BASE = "https://login.microsoftonline.com"
COMMON = f"{BASE}/common/v2.0"
PUBLISHED = f"{BASE}/{{tenantid}}/v2.0"
TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"
OTHER_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47"


def _token(**overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": f"{BASE}/{TENANT}/v2.0",
        "tid": TENANT,
        "sub": "entra-subject-1",
        "oid": "00000000-0000-0000-0000-000000000001",
        "aud": CLIENT_ID,
        "exp": now + 300,
        "iat": now,
        "nbf": now,
        # Entra's UPN; ``email`` only as an optional claim, ``email_verified`` never.
        "preferred_username": "max@example.com",
        "name": "Max Example",
    }
    claims.update(overrides)
    claims = {key: value for key, value in claims.items() if value is not None}
    return jwt.encode(claims, _KEY_PEM, algorithm="RS256", headers={"kid": KID})


class FakeEntra:
    """Entra as discovery, keys and token endpoint. ``claims`` overrides the id token."""

    def __init__(self) -> None:
        self.claims: dict = {}
        self.challenge = ""
        self.published = PUBLISHED

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "graph.microsoft.com":
            # The userinfo endpoint wants a token for Graph; nexlore goes on without it.
            return httpx.Response(401, json={"error": {"code": "InvalidAuthenticationToken"}})
        if f"{request.url.scheme}://{request.url.host}" != BASE:
            raise httpx.ConnectError("no such host")
        path = request.url.path
        if path.endswith("/v2.0/.well-known/openid-configuration"):
            return httpx.Response(
                200,
                json={
                    "issuer": self.published,
                    "authorization_endpoint": f"{BASE}/common/oauth2/v2.0/authorize",
                    "token_endpoint": f"{BASE}/common/oauth2/v2.0/token",
                    "jwks_uri": f"{BASE}/common/discovery/v2.0/keys",
                    "userinfo_endpoint": "https://graph.microsoft.com/oidc/userinfo",
                },
            )
        if path == "/common/discovery/v2.0/keys":
            return httpx.Response(200, json={"keys": [_jwk()]})
        if path == "/common/oauth2/v2.0/token":
            expected = "Basic " + base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
            form = {key: value[0] for key, value in parse_qs(request.content.decode()).items()}
            if request.headers.get("authorization") != expected or form.get("code") != CODE:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(
                200, json={"id_token": _token(**self.claims), "access_token": "graph-token", "token_type": "Bearer"}
            )
        return httpx.Response(404)


@pytest.fixture
def entra() -> Iterator[FakeEntra]:
    fake = FakeEntra()
    oidc.transport_for_tests = httpx.MockTransport(fake)
    oidc.clear_cache()
    oidc.forget_used_states()
    yield fake
    oidc.transport_for_tests = None
    oidc.clear_cache()
    oidc.forget_used_states()


def configure(client: TestClient, issuer: str = COMMON, auto_create: bool = True) -> httpx.Response:
    payload = {
        "issuer": issuer, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "provider_name": "Microsoft",
        "auto_create": auto_create,
    }
    return client.put("/api/oidc/config", json=payload, headers=UI)


def sign_in(browser: TestClient, entra: FakeEntra, invite: str | None = None, **claims) -> httpx.Response:
    start = browser.get(f"/api/oidc/start?invite={invite}" if invite else "/api/oidc/start", follow_redirects=False)
    assert start.status_code == 302, start.text
    target = urlsplit(start.headers["location"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == f"{BASE}/common/oauth2/v2.0/authorize"
    values = {key: value[0] for key, value in parse_qs(target.query).items()}
    entra.challenge = values["code_challenge"]
    entra.claims = {"nonce": values["nonce"], **claims}
    return browser.get(f"/api/oidc/callback?code={CODE}&state={values['state']}", follow_redirects=False)


def test_common_is_accepted_as_the_issuer(client: TestClient, operator: Account, entra: FakeEntra) -> None:
    """The discovery at ``common`` calls itself ``{tenantid}``: that is Entra, not a mismatch."""
    response = configure(client)
    assert response.status_code == 200, response.text
    assert response.json()["issuer"] == COMMON
    assert configure(client, f"{BASE}/organizations/v2.0").status_code == 200


def test_a_placeholder_never_stands_for_more_than_one_segment(
    client: TestClient, operator: Account, entra: FakeEntra
) -> None:
    """The placeholder takes the place of one path segment, nothing more: a discovery that names it is no licence for
    any address at the same host."""
    for issuer in (f"{BASE}/common/x/v2.0", f"{BASE}/v2.0"):
        refused = configure(client, issuer)
        assert refused.status_code == 422, issuer
        assert refused.json()["detail"]["code"] == "issuer_invalid"
    # Another host, another version, or the placeholder only as part of a segment: no match either.
    for published in (
        "https://login.example.com/{tenantid}/v2.0",
        f"{BASE}/{{tenantid}}/v1.0",
        f"{BASE}/{{tenantid}}/v2",
        f"{BASE}/x{{tenantid}}/v2.0",
    ):
        entra.published = published
        oidc.clear_cache()
        refused = configure(client)
        assert refused.status_code == 422, published
        assert refused.json()["detail"]["code"] == "issuer_invalid"


def test_a_token_of_its_tenant_signs_in_with_the_name_before_the_at(
    client: TestClient, operator: Account, entra: FakeEntra
) -> None:
    """Entra sends no ``email_verified``; the invitation lets the person in, and the account is named after the part
    of the UPN before the @, not ``max-example.com``."""
    assert configure(client, auto_create=False).status_code == 200
    token = _invite(client)
    browser = fresh_browser(client)
    response = sign_in(browser, entra, invite=token)
    assert response.headers["location"] == "/", response.headers["location"]
    me = browser.get("/api/auth/me").json()
    assert me["name"] == "max" and me["sign_in"] == "oidc"
    with SessionLocal() as db:
        assert db.query(Account).filter(Account.name == "max").one().oidc_subject == "entra-subject-1"
    # Again, from the same tenant: the same account.
    again = fresh_browser(client)
    assert sign_in(again, entra).headers["location"] == "/"
    assert again.get("/api/auth/me").json()["name"] == "max"


@pytest.mark.parametrize(
    "claims",
    [
        # Issued by another tenant than the one the token names.
        {"iss": f"{BASE}/{OTHER_TENANT}/v2.0"},
        {"tid": OTHER_TENANT},
        # The placeholder itself, with or without a tenant.
        {"iss": PUBLISHED},
        {"iss": PUBLISHED, "tid": None},
        # No tenant, or one that is no tenant id: nothing to fill the placeholder with.
        {"tid": None},
        {"iss": f"{BASE}/common/v2.0", "tid": "common"},
        {"iss": f"{BASE}/{TENANT}x/v2.0", "tid": f"{TENANT}x"},
        {"iss": f"{BASE}/../v2.0", "tid": ".."},
    ],
    ids=["other-iss", "other-tid", "placeholder", "placeholder-no-tid", "no-tid", "tid-common", "tid-longer", "tid-dots"],
)
def test_a_token_whose_issuer_is_not_its_tenant_is_refused(
    client: TestClient, operator: Account, entra: FakeEntra, claims: dict
) -> None:
    assert configure(client).status_code == 200
    with SessionLocal() as db:
        db.query(Account).filter(Account.name == "tester").update({"oidc_subject": "entra-subject-1"})
        db.commit()
    browser = fresh_browser(client)
    response = sign_in(browser, entra, **claims)
    assert response.headers["location"] == "/login?error=oidc_token_invalid"
    assert not browser.cookies.get("nexlore_session")


def test_an_address_without_confirmation_links_no_account(
    client: TestClient, operator: Account, entra: FakeEntra
) -> None:
    """Entra's ``email`` comes without ``email_verified``: an account with the same address is not taken over, and
    no account is made, even with new accounts allowed."""
    assert configure(client).status_code == 200
    with SessionLocal() as db:
        db.query(Account).filter(Account.name == "tester").update({"email": "max@example.com"})
        db.commit()
    browser = fresh_browser(client)
    response = sign_in(browser, entra, email="max@example.com")
    assert response.headers["location"] == "/login?error=oidc_email_unverified"
    assert account_count() == 1
    with SessionLocal() as db:
        assert db.query(Account).filter(Account.name == "tester").one().oidc_subject == ""


def test_a_single_tenant_issuer_works_as_before(client: TestClient, operator: Account, entra: FakeEntra) -> None:
    """Set up with the tenant's own address, the discovery names that one: no placeholder, compared as it is."""
    entra.published = f"{BASE}/{TENANT}/v2.0"
    assert configure(client, f"{BASE}/{TENANT}/v2.0").status_code == 200
    with SessionLocal() as db:
        db.query(Account).filter(Account.name == "tester").update({"oidc_subject": "entra-subject-1"})
        db.commit()
    assert sign_in(fresh_browser(client), entra).headers["location"] == "/"
    refused = sign_in(fresh_browser(client), entra, iss=f"{BASE}/{OTHER_TENANT}/v2.0", tid=OTHER_TENANT)
    assert refused.headers["location"] == "/login?error=oidc_token_invalid"


@pytest.mark.parametrize(
    ("claims", "name"),
    [
        ({"preferred_username": "max@example.com"}, "max"),
        ({"preferred_username": " max.power@example.com "}, "max.power"),
        ({"preferred_username": "alex"}, "alex"),
        ({"preferred_username": "@example.com", "name": "Max Example"}, "Max Example"),
        ({"preferred_username": "", "name": "Max Example"}, "Max Example"),
        ({"name": "Max Example"}, "Max Example"),
        ({}, ""),
    ],
)
def test_the_username_is_the_part_before_the_at(claims: dict, name: str) -> None:
    assert oidc.username_from(claims) == name


def _verify(published: str, **claims) -> dict:
    """``_verify_token`` straight, for the claims the browser run cannot vary on its own."""
    now = int(time.time())
    token = jwt.encode(
        {"sub": "s", "aud": CLIENT_ID, "exp": now + 300, "iat": now, **claims}, _KEY_PEM, algorithm="RS256",
        headers={"kid": KID},
    )
    description = {"issuer": published, "jwks_uri": f"{BASE}/common/discovery/v2.0/keys"}
    return asyncio.run(oidc._verify_token(description, CLIENT_ID, token, purpose="test", required=("exp", "iss", "aud", "sub")))


def test_any_tenant_the_registration_lets_in_is_taken_when_iss_and_tid_agree(entra: FakeEntra) -> None:
    """Which tenants get in is the app registration's business at Entra; nexlore only insists that the token's issuer is
    the tenant it names."""
    assert _verify(PUBLISHED, iss=f"{BASE}/{OTHER_TENANT}/v2.0", tid=OTHER_TENANT)["tid"] == OTHER_TENANT


@pytest.mark.parametrize("tid", [[TENANT], {"id": TENANT}, f" {TENANT}", TENANT + chr(10)])
def test_a_tid_that_is_not_plainly_a_tenant_id_fills_in_nothing(entra: FakeEntra, tid: object) -> None:
    with pytest.raises(oidc.OidcError):
        _verify(PUBLISHED, iss=f"{BASE}/{TENANT}/v2.0", tid=tid)


def test_an_issuer_with_a_slash_at_the_end_is_still_compared_as_it_is(entra: FakeEntra) -> None:
    issuer = "https://auth.example.com/application/o/nexlore/"
    assert _verify(issuer, iss=issuer)["iss"] == issuer
    with pytest.raises(oidc.OidcError):
        _verify(issuer, iss=issuer.rstrip("/"))
