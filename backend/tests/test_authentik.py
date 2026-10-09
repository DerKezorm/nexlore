"""The authentik button against a fake authentik API v3, and the blueprint download.

The fake answers the calls in the order the service makes them and records every request, so the tests can
check that the token travels only in the Authorization header, that the steps stop at the first failure and
that an existing provider is updated instead of duplicated. No network anywhere.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass, field

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.security import encrypt_secret
from app.services import authentik, oidc, settings_service

from .conftest import make_account, sign_in

#: The test clients name their tab already (the header every change needs).
UI: dict[str, str] = {}


def invite_member(client: TestClient, name: str = "member") -> TestClient:
    browser = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-member00"})
    sign_in(browser, make_account(name))
    return browser

URL = "https://auth.example.com"
TOKEN = "one-time-token-that-must-stay-out-of-everything"
ISSUER = f"{URL}/application/o/nexlore/"
REDIRECT = "http://testserver/api/oidc/callback"


@dataclass
class Recorded:
    method: str
    path: str
    query: dict[str, str]
    auth: str
    body: dict | None


@dataclass
class FakeAuthentik:
    """authentik as a MockTransport handler. ``existing`` says which objects are already there."""

    existing: set[str] = field(default_factory=set)
    fail: tuple[str, str, int] | None = None
    discovery_ok: bool = True
    #: The address the existing provider "nexlore" sends people back to, and the client id it carries.
    provider_redirect: str = ""
    provider_client: str = "generated-client-id"
    #: More providers, each with its application: ``{"pk", "name", "client_id", "redirect", "slug"}``. The provider
    #: of another instance, or this one's own under a name with the host added.
    others: list[dict] = field(default_factory=list)
    #: Applications on their own: ``{"slug", "name", "provider"}``, the provider a pk or None (its provider is gone).
    apps: list[dict] = field(default_factory=list)
    #: How many applications one page of the list holds; None: all on one page.
    page_size: int | None = None
    calls: list[Recorded] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host != "auth.example.com":
            raise httpx.ConnectError("no such host")
        method, path = request.method, request.url.path
        query = dict(request.url.params.items())
        body = json.loads(request.content) if request.content else None
        self.calls.append(Recorded(method, path, query, request.headers.get("authorization", ""), body))
        if self.fail and (method, path) == self.fail[:2]:
            return httpx.Response(self.fail[2], text="<html>authentik error page</html>")
        if path.startswith("/application/o/") and path.endswith("/.well-known/openid-configuration"):
            if not self.discovery_ok:
                return httpx.Response(404, text="not found")
            issuer = f"{URL}{path.removesuffix('.well-known/openid-configuration')}"
            return httpx.Response(
                200,
                json={
                    "issuer": issuer,
                    "authorization_endpoint": f"{issuer}authorize/",
                    "token_endpoint": f"{URL}/application/o/token/",
                    "jwks_uri": f"{issuer}jwks/",
                },
            )
        if not path.startswith("/api/v3/"):
            return httpx.Response(404)
        if request.headers.get("authorization") == "Bearer expired-token":
            return httpx.Response(401, json={"detail": "Token invalid/expired"})
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(403, json={"detail": "Authentication credentials were not provided."})
        return self._api(method, path[len("/api/v3") :], query, body)

    def _api(self, method: str, path: str, query: dict[str, str], body: dict | None) -> httpx.Response:
        if (method, path) == ("GET", "/admin/version/"):
            return httpx.Response(200, json={"version_current": "2026.8.1", "version_latest": "2026.8.1"})
        if (method, path) == ("GET", "/crypto/certificatekeypairs/"):
            rows = [{"pk": "cert-uuid", "name": "nexlore"}] if "cert" in self.existing else []
            return httpx.Response(200, json={"results": rows})
        if (method, path) == ("POST", "/crypto/certificatekeypairs/generate/"):
            return httpx.Response(200, json={"pk": "cert-uuid", "name": body["common_name"]})
        if (method, path) == ("GET", "/propertymappings/provider/scope/"):
            rows = [
                {"pk": "map-openid", "managed": "goauthentik.io/providers/oauth2/scope-openid", "name": "authentik default OAuth Mapping: OpenID 'openid'"},
                {"pk": "map-profile", "managed": "goauthentik.io/providers/oauth2/scope-profile", "name": "authentik default OAuth Mapping: OpenID 'profile'"},
                {"pk": "map-email", "managed": "goauthentik.io/providers/oauth2/scope-email", "name": "authentik default OAuth Mapping: OpenID 'email'"},
            ]
            if "mapping" in self.existing:
                rows.append({"pk": "map-own", "managed": None, "name": "nexlore email_verified"})
            if "name" in query:
                rows = [row for row in rows if row["name"] == query["name"]]
            if "managed" in query:
                rows = [row for row in rows if row["managed"] == query["managed"]]
            return httpx.Response(200, json={"results": rows})
        if (method, path) == ("POST", "/propertymappings/provider/scope/"):
            return httpx.Response(201, json={"pk": "map-own", "name": body["name"], "scope_name": body["scope_name"]})
        if (method, path) == ("GET", "/flows/instances/"):
            if query.get("designation") == "authorization":
                rows = [
                    {"pk": "flow-explicit", "slug": "default-provider-authorization-explicit-consent"},
                    {"pk": "flow-implicit", "slug": "default-provider-authorization-implicit-consent"},
                ]
            else:
                rows = [{"pk": "flow-invalidation", "slug": "default-provider-invalidation-flow"}]
            return httpx.Response(200, json={"results": rows})
        if (method, path) == ("GET", "/providers/oauth2/"):
            rows = [{"pk": 7, "name": "nexlore", "client_id": self.provider_client}] if "provider" in self.existing else []
            if rows and self.provider_redirect:
                rows[0]["redirect_uris"] = [{"matching_mode": "strict", "url": self.provider_redirect}]
            rows += [
                {"pk": other["pk"], "name": other["name"], "client_id": other["client_id"],
                 "redirect_uris": [{"matching_mode": "strict", "url": other["redirect"]}]}
                for other in self.others
            ]
            # As authentik's provider serializer: the application a provider is assigned to, by slug and name.
            for row in rows:
                assigned = next((app for app in self._applications() if str(app["provider"]) == str(row["pk"])), None)
                row["assigned_application_slug"] = assigned["slug"] if assigned else ""
                row["assigned_application_name"] = assigned["name"] if assigned else ""
            for key in ("name", "client_id"):
                if key in query:
                    rows = [row for row in rows if row[key] == query[key]]
            return httpx.Response(200, json={"results": rows})
        if (method, path) in (("POST", "/providers/oauth2/"), ("PATCH", "/providers/oauth2/7/")):
            status = 201 if method == "POST" else 200
            client = "generated-client-id" if method == "POST" else self.provider_client
            return httpx.Response(status, json={**body, "pk": 7, "client_id": client, "client_secret": "generated-secret"})
        for other in self.others:
            if (method, path) == ("PATCH", f"/providers/oauth2/{other['pk']}/"):
                return httpx.Response(200, json={**body, "pk": other["pk"], "client_id": other["client_id"],
                                                  "client_secret": "generated-secret"})
            if other["slug"] and (method, path) == ("PATCH", f"/core/applications/{other['slug']}/"):
                return httpx.Response(200, json={**body, "pk": f"app-{other['pk']}"})
        for lone in self.apps:
            if (method, path) == ("PATCH", f"/core/applications/{lone['slug']}/"):
                return httpx.Response(200, json={**body, "pk": f"app-{lone['slug']}"})
        if (method, path) == ("GET", "/core/applications/"):
            # authentik lists only what the token's user may open, unless asked for the full list; it filters by slug
            # (and name, launch URL and a few more), never by provider: an unknown filter is ignored.
            if query.get("superuser_full_list") != "true":
                return httpx.Response(200, json={"results": []})
            rows = self._applications()
            if "slug" in query:
                rows = [row for row in rows if row["slug"] == query["slug"]]
            return httpx.Response(200, json={"results": rows[: self.page_size]})
        if (method, path) in (("POST", "/core/applications/"), ("PATCH", "/core/applications/nexlore/")):
            return httpx.Response(201 if method == "POST" else 200, json={**body, "pk": "app-uuid"})
        return httpx.Response(404, json={"detail": f"no fake answer for {method} {path}"})

    def _applications(self) -> list[dict]:
        rows = [{"pk": "app-uuid", "slug": "nexlore", "name": "nexlore", "provider": 7}] if "application" in self.existing else []
        rows += [{"pk": f"app-{other['pk']}", "slug": other["slug"], "name": other["name"], "provider": other["pk"]}
                 for other in self.others if other["slug"]]
        rows += [{"pk": f"app-{lone['slug']}", **lone} for lone in self.apps]
        return rows


@pytest.fixture
def fake() -> Iterator[FakeAuthentik]:
    server = FakeAuthentik()
    transport = httpx.MockTransport(server)
    authentik.transport_for_tests = transport
    oidc.transport_for_tests = transport
    oidc.clear_cache()
    yield server
    authentik.transport_for_tests = None
    oidc.transport_for_tests = None
    oidc.clear_cache()


def run_setup(client: TestClient, url: str = URL, token: str = TOKEN) -> dict:
    response = client.post("/api/oidc/authentik/setup", json={"url": url, "token": token}, headers=UI)
    assert response.status_code == 200, response.text
    return response.json()


def steps(result: dict) -> list[tuple[str, bool]]:
    return [(step["key"], step["ok"]) for step in result["steps"]]


def stored() -> dict:
    with SessionLocal() as db:
        return {key: settings_service.get(db, key) for key in ("oidc_issuer", "oidc_client_id", "oidc_client_secret_enc", "oidc_provider_name")}


# ---------------------------------------------------------------------------
# The button
# ---------------------------------------------------------------------------


def test_setup_creates_everything_and_fills_the_configuration(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    result = run_setup(client)
    assert steps(result) == [(key, True) for key in authentik.STEP_KEYS]
    assert result["client_id"] == "generated-client-id"
    assert result["issuer"] == ISSUER
    assert "2026.8.1" in result["steps"][0]["detail"]

    # Stored, encrypted, and the sign-in page sees the button.
    values = stored()
    assert values["oidc_issuer"] == ISSUER and values["oidc_client_id"] == "generated-client-id"
    assert values["oidc_provider_name"] == "authentik"
    assert values["oidc_client_secret_enc"] and "generated-secret" not in values["oidc_client_secret_enc"]
    assert client.get("/api/oidc/state").json() == {"enabled": True, "provider_name": "authentik"}
    assert client.get("/api/oidc/config").json()["configured"] is True

    # The provider was created with what the task prescribes.
    created = [call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/")]
    assert len(created) == 1
    body = created[0].body
    assert body["name"] == "nexlore" and body["client_type"] == "confidential"
    # authentik 2026.8 refuses every authorize request whose grant is not listed on the provider.
    assert body["grant_types"] == ["authorization_code"]
    assert body["redirect_uris"] == [{"matching_mode": "strict", "url": REDIRECT}]
    assert body["signing_key"] == "cert-uuid" and body["sub_mode"] == "user_uuid"
    assert body["authorization_flow"] == "flow-implicit" and body["invalidation_flow"] == "flow-invalidation"
    assert sorted(body["property_mappings"]) == ["map-openid", "map-own", "map-profile"]
    generated = [call for call in fake.calls if call.path == "/api/v3/crypto/certificatekeypairs/generate/"]
    assert generated[0].body["common_name"] == "nexlore" and generated[0].body["validity_days"] == 3650
    mapping = [call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/propertymappings/provider/scope/")]
    assert mapping[0].body["scope_name"] == "email" and '"email_verified": True' in mapping[0].body["expression"]
    application = [call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/")]
    assert application[0].body == {"name": "nexlore", "slug": "nexlore", "provider": 7}
    assert not any(call.method == "PATCH" for call in fake.calls)


def test_token_travels_only_in_the_authorization_header(
    client: TestClient, operator: Account, fake: FakeAuthentik, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        result = run_setup(client)
    api_calls = [call for call in fake.calls if call.path.startswith("/api/v3/")]
    assert api_calls
    for call in api_calls:
        assert call.auth == f"Bearer {TOKEN}"
        assert TOKEN not in call.path and TOKEN not in str(call.query) and TOKEN not in json.dumps(call.body)
    assert TOKEN not in caplog.text
    assert TOKEN not in json.dumps(result)
    # Neither the token nor the secret ends up in the answer or the log.
    assert "generated-secret" not in json.dumps(result)
    assert "generated-secret" not in caplog.text


def test_steps_stop_at_the_first_failure_and_nothing_is_stored(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    fake.fail = ("POST", "/api/v3/crypto/certificatekeypairs/generate/", 500)
    result = run_setup(client)
    assert steps(result) == [("reached", True), ("signingKey", False)]
    failed = result["steps"][1]["detail"]
    assert "500" in failed and "generate" in failed
    assert TOKEN not in failed
    assert result["client_id"] == ""
    assert stored()["oidc_issuer"] == ""
    assert client.get("/api/oidc/state").json()["enabled"] is False
    # Nothing beyond the failed call was tried.
    assert not any(call.path.startswith("/api/v3/propertymappings") for call in fake.calls)


def test_unreachable_authentik_fails_at_the_first_step(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    result = run_setup(client, url="https://nowhere.example.com")
    assert steps(result) == [("reached", False)]
    assert "not reachable" in result["steps"][0]["detail"]


def test_wrong_token_is_reported_without_repeating_it(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    result = run_setup(client, token="wrong-token")
    assert steps(result) == [("reached", False)]
    assert "403" in result["steps"][0]["detail"]
    assert "wrong-token" not in json.dumps(result)


def test_existing_objects_are_updated_not_duplicated(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    fake.existing = {"cert", "mapping", "provider", "application"}
    result = run_setup(client)
    assert steps(result) == [(key, True) for key in authentik.STEP_KEYS]
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/7/") in methods
    assert ("PATCH", "/api/v3/core/applications/nexlore/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert ("POST", "/api/v3/core/applications/") not in methods
    assert ("POST", "/api/v3/crypto/certificatekeypairs/generate/") not in methods
    assert ("POST", "/api/v3/propertymappings/provider/scope/") not in methods
    assert "existing" in result["steps"][3]["detail"] and "existing" in result["steps"][4]["detail"]
    patched = next(call for call in fake.calls if call.method == "PATCH" and "providers" in call.path)
    assert patched.body["redirect_uris"] == [{"matching_mode": "strict", "url": REDIRECT}]
    # A provider made by an older button has no grant types; running the button again must add them.
    assert patched.body["grant_types"] == ["authorization_code"]
    assert sorted(patched.body["property_mappings"]) == ["map-openid", "map-own", "map-profile"]


def test_failed_discovery_after_storing_is_reported(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """The values come from authentik and are stored; whether nexlore can reach the issuer is reported."""
    fake.discovery_ok = False
    result = run_setup(client)
    assert steps(result)[:5] == [(key, True) for key in authentik.STEP_KEYS[:5]]
    assert steps(result)[5] == ("filled", False)
    assert "discovery" in result["steps"][5]["detail"]
    assert stored()["oidc_client_id"] == "generated-client-id"


def test_setup_is_operator_only_and_checks_the_address(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    member = invite_member(client)
    response = member.post("/api/oidc/authentik/setup", json={"url": URL, "token": TOKEN}, headers=UI)
    assert response.status_code == 403
    bad = client.post("/api/oidc/authentik/setup", json={"url": "auth.example.com", "token": TOKEN}, headers=UI)
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "url_invalid"
    assert fake.calls == []


# ---------------------------------------------------------------------------
# The blueprint
# ---------------------------------------------------------------------------


class _TagLoader(yaml.SafeLoader):
    """Reads authentik's ``!Find`` and ``!KeyOf`` tags as plain values, enough to check the structure."""


_TagLoader.add_constructor("!Find", lambda loader, node: ("Find", loader.construct_sequence(node, deep=True)))
_TagLoader.add_constructor("!KeyOf", lambda loader, node: ("KeyOf", loader.construct_scalar(node)))


def test_blueprint_download_creates_the_same_objects(client: TestClient, operator: Account) -> None:
    response = client.get("/api/oidc/authentik/blueprint")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/yaml")
    assert response.headers["content-disposition"] == 'attachment; filename="nexlore-authentik.yaml"'
    text = response.text
    assert "!Find" in text and "!KeyOf" in text

    data = yaml.load(text, Loader=_TagLoader)
    assert data["version"] == 1
    models = [entry["model"] for entry in data["entries"]]
    assert models == [
        "authentik_providers_oauth2.scopemapping",
        "authentik_providers_oauth2.oauth2provider",
        "authentik_core.application",
    ]
    mapping, provider, application = data["entries"]
    assert mapping["identifiers"] == {"name": "nexlore email_verified"}
    assert mapping["attrs"]["scope_name"] == "email"
    assert '"email_verified": True' in mapping["attrs"]["expression"]
    attrs = provider["attrs"]
    assert attrs["client_type"] == "confidential" and attrs["sub_mode"] == "user_uuid"
    assert attrs["grant_types"] == ["authorization_code"]
    assert attrs["redirect_uris"] == [{"matching_mode": "strict", "url": REDIRECT}]
    assert attrs["authorization_flow"] == ("Find", ["authentik_flows.flow", ["slug", "default-provider-authorization-implicit-consent"]])
    assert attrs["signing_key"][0] == "Find" and attrs["signing_key"][1][0] == "authentik_crypto.certificatekeypair"
    assert ("KeyOf", "nexlore-email-verified") in attrs["property_mappings"]
    assert application["identifiers"] == {"slug": "nexlore"}
    assert application["attrs"]["provider"] == ("KeyOf", "nexlore-provider")


def test_a_second_instance_takes_names_of_its_own(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """Another nexlore at the same authentik holds the plain names; taking them would send its people back here.
    The first one stays untouched, this one gets a provider, an application and an issuer of its own."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    result = run_setup(client)
    assert steps(result) == [(key, True) for key in authentik.STEP_KEYS]
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods, "the first instance's provider stays"
    assert ("PATCH", "/api/v3/core/applications/nexlore/") not in methods
    provider = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/"))
    assert provider.body["name"] == "nexlore (testserver)"
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body["slug"] == "nexlore-testserver" and made.body["name"] == "nexlore (testserver)"
    assert result["issuer"] == f"{URL}/application/o/nexlore-testserver/"
    assert stored()["oidc_issuer"] == f"{URL}/application/o/nexlore-testserver/"


def test_its_own_provider_keeps_the_plain_names(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """The plain provider is this nexlore's own when it already sends people here, and also when it carries the
    client id stored here: the operator moved nexlore to a new address and runs the button again. Both update."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = REDIRECT
    run_setup(client)
    assert ("PATCH", "/api/v3/providers/oauth2/7/") in [(call.method, call.path) for call in fake.calls]
    fake.provider_redirect = "https://old-address.example.com/api/oidc/callback"
    fake.calls.clear()
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/7/") in methods, "moved, still its own: updated"
    assert ("PATCH", "/api/v3/core/applications/nexlore/") in methods
    assert result["issuer"] == ISSUER


OLD_HOST = "old.example.com"
OWN_SLUG = "nexlore-old-example-com"
OWN_ISSUER = f"{URL}/application/o/{OWN_SLUG}/"


def configured_as(issuer: str, client_id: str) -> int:
    """nexlore set up by an earlier run of the button, with one account bound to the provider; returns its id."""
    with SessionLocal() as db:
        settings_service.save(db, {"oidc_issuer": issuer, "oidc_client_id": client_id,
                                   "oidc_client_secret_enc": encrypt_secret("old-secret"), "oidc_provider_name": "authentik"})
        db.commit()
    member = make_account("bound")
    with SessionLocal() as db:
        row = db.get(Account, member.id)
        assert row is not None
        row.oidc_subject = "subject-1"
        db.commit()
    return member.id


def test_a_second_instance_keeps_its_own_provider_after_a_move(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The second nexlore at an authentik has a provider named after its old host. Moved to a new address, it finds
    that provider by the client id it stored and updates it: no third provider, the issuer stays, nobody's sign-in
    is dropped."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": f"nexlore ({OLD_HOST})", "client_id": "own-client",
                    "redirect": f"https://{OLD_HOST}/api/oidc/callback", "slug": OWN_SLUG}]
    member = configured_as(OWN_ISSUER, "own-client")
    result = run_setup(client)
    assert steps(result) == [(key, True) for key in authentik.STEP_KEYS]
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("PATCH", f"/api/v3/core/applications/{OWN_SLUG}/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert ("POST", "/api/v3/core/applications/") not in methods
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods, "the first instance's provider stays"
    patched = next(call for call in fake.calls if (call.method, call.path) == ("PATCH", "/api/v3/providers/oauth2/8/"))
    assert patched.body["name"] == f"nexlore ({OLD_HOST})"
    assert patched.body["redirect_uris"] == [{"matching_mode": "strict", "url": REDIRECT}]
    assert result["issuer"] == OWN_ISSUER and stored()["oidc_issuer"] == OWN_ISSUER
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == "subject-1"  # type: ignore[union-attr]


def test_its_own_provider_renamed_in_authentik_keeps_its_name_and_issuer(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The operator renamed the provider in authentik. Found by the stored client id, it keeps the name it has there,
    and the slug comes from the stored issuer, so the issuer stays."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": "Whiteboards", "client_id": "own-client",
                    "redirect": f"https://{OLD_HOST}/api/oidc/callback", "slug": OWN_SLUG}]
    configured_as(OWN_ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("PATCH", f"/api/v3/core/applications/{OWN_SLUG}/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    patched = next(call for call in fake.calls if (call.method, call.path) == ("PATCH", "/api/v3/providers/oauth2/8/"))
    assert patched.body["name"] == "Whiteboards"
    assert result["issuer"] == OWN_ISSUER

def test_a_stored_client_id_never_takes_over_another_instances_provider(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The client id stored here belongs to this instance's own provider, not to the one with the plain name, which
    another instance signs in with. While the own one is there, it is updated; once it is gone from authentik, a new
    one is made under this host's name and the other instance's provider is still left alone."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": "nexlore (testserver)", "client_id": "own-client", "redirect": REDIRECT,
                    "slug": "nexlore-testserver"}]
    configured_as(f"{URL}/application/o/nexlore-testserver/", "own-client")
    run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods
    fake.others = []
    fake.calls.clear()
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods, "never the other instance's provider"
    assert ("PATCH", "/api/v3/core/applications/nexlore/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/"))
    assert made.body["name"] == "nexlore (testserver)"
    assert result["issuer"] == f"{URL}/application/o/nexlore-testserver/"


def test_its_own_application_keeps_a_slug_with_capitals_and_underscores(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """authentik allows capitals and underscores in a slug. The operator gave the application one; after a move the
    button still finds its own provider and application by it, and the issuer stays."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": "Boards", "client_id": "own-client",
                    "redirect": f"https://{OLD_HOST}/api/oidc/callback", "slug": "My_Boards"}]
    member = configured_as(f"{URL}/application/o/My_Boards/", "own-client")
    result = run_setup(client)
    assert steps(result) == [(key, True) for key in authentik.STEP_KEYS]
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("PATCH", "/api/v3/core/applications/My_Boards/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert ("POST", "/api/v3/core/applications/") not in methods
    assert result["issuer"] == f"{URL}/application/o/My_Boards/"
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == "subject-1"  # type: ignore[union-attr]


@pytest.mark.parametrize("name", [f"nexlore ({OLD_HOST})", "Whiteboards"])
def test_its_own_application_is_found_by_its_provider_when_the_issuer_names_no_slug(
    client: TestClient, operator: Account, fake: FakeAuthentik, name: str
) -> None:
    """The stored issuer was typed by hand and names no slug: the application that belongs to the own provider says
    which one it is. Never the plain name only because nothing else was readable."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": name, "client_id": "own-client",
                    "redirect": f"https://{OLD_HOST}/api/oidc/callback", "slug": OWN_SLUG}]
    fake.page_size = 1
    configured_as(f"{URL}/issuer-typed-by-hand", "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("PATCH", f"/api/v3/core/applications/{OWN_SLUG}/") in methods
    assert ("PATCH", "/api/v3/core/applications/nexlore/") not in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert result["issuer"] == OWN_ISSUER


def test_the_stored_issuer_never_bends_another_instances_application(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The client id belongs to the own provider, but the stored issuer names the slug of the application the first
    instance signs in with (set by hand or left from before). That application stays as it is; the own provider's
    application is the one updated."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": f"nexlore ({OLD_HOST})", "client_id": "own-client",
                    "redirect": f"https://{OLD_HOST}/api/oidc/callback", "slug": OWN_SLUG}]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/core/applications/nexlore/") not in methods, "the first instance's application stays"
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods
    assert ("PATCH", f"/api/v3/core/applications/{OWN_SLUG}/") in methods
    assert result["issuer"] == OWN_ISSUER


@pytest.mark.parametrize("slug", [OWN_SLUG, "My_Boards"])
def test_a_deleted_own_provider_comes_back_under_its_application(
    client: TestClient, operator: Account, fake: FakeAuthentik, slug: str
) -> None:
    """The own provider was deleted in authentik, its application is still there without one, and nexlore moved.
    The button makes the provider again for that application: the issuer stays, and so does every account bound to
    it. Also for a slug with capitals and underscores, which authentik allows."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.apps = [{"slug": slug, "name": f"nexlore ({OLD_HOST})", "provider": None}]
    issuer = f"{URL}/application/o/{slug}/"
    member = configured_as(issuer, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/"))
    assert made.body["name"] == f"nexlore ({OLD_HOST})"
    assert ("PATCH", f"/api/v3/core/applications/{slug}/") in methods
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods
    assert result["issuer"] == issuer and stored()["oidc_issuer"] == issuer
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == "subject-1"  # type: ignore[union-attr]


def test_an_application_of_another_provider_is_not_taken_for_a_deleted_own_one(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The own provider is gone, and the application the stored issuer names now belongs to another provider: that is
    somebody else's. The button leaves it alone and makes names of its own."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.apps = [{"slug": OWN_SLUG, "name": f"nexlore ({OLD_HOST})", "provider": 7}]
    configured_as(OWN_ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", f"/api/v3/core/applications/{OWN_SLUG}/") not in methods
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/"))
    assert made.body["name"] == "nexlore (testserver)"
    assert result["issuer"] == f"{URL}/application/o/nexlore-testserver/"


def test_a_left_application_named_like_another_instances_provider_is_not_taken(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The own provider is gone and its application is left without one, but it carries the plain name, and the
    provider of that name signs another instance in. Making the provider again under that name would update that
    one instead: the button makes names of its own."""
    fake.existing = {"cert", "mapping", "provider"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.apps = [{"slug": "nexlore", "name": "nexlore", "provider": None}]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/"))
    assert made.body["name"] == "nexlore (testserver)"
    assert result["issuer"] == f"{URL}/application/o/nexlore-testserver/"


def test_an_issuer_without_a_slug_never_adopts_a_left_application(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The stored issuer was typed by hand and names no slug, and the own provider is gone. A left application under
    the plain slug is not taken for this instance's by guessing: the button goes by the plain names as on a first
    run, and the renamed application gets the provider's name."""
    fake.existing = {"cert", "mapping"}
    fake.apps = [{"slug": "nexlore", "name": "Whiteboards", "provider": None}]
    configured_as(f"{URL}/issuer-typed-by-hand", "own-client")
    result = run_setup(client)
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/providers/oauth2/"))
    assert made.body["name"] == "nexlore"
    assert result["issuer"] == ISSUER


def own_without_application(fake: FakeAuthentik) -> None:
    """The plain names belong to the first instance; this one's provider is there, its application is not."""
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_redirect = "https://first.example.com/api/oidc/callback"
    fake.provider_client = "the-first-instance"
    fake.others = [{"pk": 8, "name": f"nexlore ({OLD_HOST})", "client_id": "own-client",
                    "redirect": f"https://{OLD_HOST}/api/oidc/callback", "slug": None}]


def test_its_own_provider_without_an_application_gets_it_back_under_the_stored_slug(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The application was deleted in authentik, the own provider is still there, and nexlore moved. The provider is
    updated, never a second one made, and the application comes back under the slug the issuer names: the issuer stays,
    and so does every account bound to it."""
    own_without_application(fake)
    member = configured_as(OWN_ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert ("PATCH", "/api/v3/providers/oauth2/7/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body == {"name": f"nexlore ({OLD_HOST})", "slug": OWN_SLUG, "provider": 8}
    assert result["issuer"] == OWN_ISSUER and stored()["oidc_issuer"] == OWN_ISSUER
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == "subject-1"  # type: ignore[union-attr]


def test_its_own_provider_without_an_application_takes_a_left_one_under_the_stored_slug(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The application the issuer names is still there, but without a provider: it is free, and the own one is hung
    onto it again. Also when the provider was renamed and its name gives another slug: the issuer stays."""
    own_without_application(fake)
    fake.others[0]["name"] = "Boards"
    fake.apps = [{"slug": OWN_SLUG, "name": f"nexlore ({OLD_HOST})", "provider": None}]
    configured_as(OWN_ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert ("POST", "/api/v3/core/applications/") not in methods
    patched = next(call for call in fake.calls if (call.method, call.path) == ("PATCH", f"/api/v3/core/applications/{OWN_SLUG}/"))
    assert patched.body == {"name": "Boards", "slug": OWN_SLUG, "provider": 8}
    assert result["issuer"] == OWN_ISSUER


def test_its_own_provider_without_an_application_never_takes_another_ones(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The issuer names the application of the first instance. That one stays; the own provider gets a new application
    under its own name, and still no second provider is made."""
    own_without_application(fake)
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/providers/oauth2/8/") in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    assert ("PATCH", "/api/v3/core/applications/nexlore/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body == {"name": f"nexlore ({OLD_HOST})", "slug": OWN_SLUG, "provider": 8}
    assert result["issuer"] == OWN_ISSUER


def test_a_new_application_for_its_own_provider_never_takes_a_slug_in_use(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The slug the own provider's name gives is held by another provider's application: the new one gets the
    provider's number added instead of bending that one."""
    own_without_application(fake)
    fake.others[0]["name"] = "Boards"
    fake.apps = [{"slug": "boards", "name": "Boards", "provider": 7}]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/core/applications/boards/") not in methods
    assert ("POST", "/api/v3/providers/oauth2/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body == {"name": "Boards", "slug": "boards-8", "provider": 8}
    assert result["issuer"] == f"{URL}/application/o/boards-8/"


def test_applications_are_looked_up_in_the_full_list(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """authentik lists only the applications the token's user may open, unless asked for the full list: without it, an
    application of this instance would look missing and a second one would be made."""
    own_without_application(fake)
    fake.apps = [{"slug": OWN_SLUG, "name": f"nexlore ({OLD_HOST})", "provider": None}]
    configured_as(OWN_ISSUER, "own-client")
    run_setup(client)
    lookups = [call for call in fake.calls if (call.method, call.path) == ("GET", "/api/v3/core/applications/")]
    assert lookups
    assert all(call.query.get("superuser_full_list") == "true" for call in lookups), [call.query for call in lookups]


def test_a_new_application_counts_on_past_slugs_in_use(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """The slug of the own name and the one with the provider's number added are both held by other providers'
    applications: the button counts on and never hangs one of them onto its own provider."""
    own_without_application(fake)
    fake.others[0]["name"] = "Boards"
    fake.apps = [{"slug": "boards", "name": "Boards", "provider": 7}, {"slug": "boards-8", "name": "Boards", "provider": 9}]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("PATCH", "/api/v3/core/applications/boards/") not in methods
    assert ("PATCH", "/api/v3/core/applications/boards-8/") not in methods
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body == {"name": "Boards", "slug": "boards-8-2", "provider": 8}
    assert result["issuer"] == f"{URL}/application/o/boards-8-2/"


def test_when_every_slug_is_in_use_the_step_says_so(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """Every slug the button would try belongs to another provider's application: it stops at the provider step with a
    reason of its own, before anything is made or changed."""
    own_without_application(fake)
    fake.others[0]["name"] = "Boards"
    slugs = ["boards", "boards-8"] + [f"boards-8-{number}" for number in range(2, 10)]
    fake.apps = [{"slug": slug, "name": "Boards", "provider": 9} for slug in slugs]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    assert steps(result)[-1] == ("provider", False)
    assert "belongs to an application of another provider" in result["steps"][-1]["detail"]
    changes = [call for call in fake.calls if call.method in ("POST", "PATCH") and "/core/applications/" in call.path]
    assert not changes
    assert not any(call.method in ("POST", "PATCH") and "/providers/oauth2/" in call.path for call in fake.calls)


def test_a_left_application_under_a_fallback_slug_is_taken(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """The slug of the own name is held by another provider's application; under the next one an application was left
    without a provider. That one is free: the own provider is hung onto it, no new one is made."""
    own_without_application(fake)
    fake.others[0]["name"] = "Boards"
    fake.apps = [{"slug": "boards", "name": "Boards", "provider": 7}, {"slug": "boards-8", "name": "Old boards", "provider": None}]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    methods = [(call.method, call.path) for call in fake.calls]
    assert ("POST", "/api/v3/core/applications/") not in methods
    assert ("PATCH", "/api/v3/core/applications/boards/") not in methods
    patched = next(call for call in fake.calls if (call.method, call.path) == ("PATCH", "/api/v3/core/applications/boards-8/"))
    assert patched.body == {"name": "Boards", "slug": "boards-8", "provider": 8}
    assert result["issuer"] == f"{URL}/application/o/boards-8/"


def test_the_fallback_slug_counts_on_until_one_is_free(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    own_without_application(fake)
    fake.others[0]["name"] = "Boards"
    held = ["boards", "boards-8", "boards-8-2", "boards-8-3", "boards-8-4"]
    fake.apps = [{"slug": slug, "name": "Boards", "provider": 9} for slug in held]
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body == {"name": "Boards", "slug": "boards-8-5", "provider": 8}
    assert not any(call.method == "PATCH" and "/core/applications/" in call.path for call in fake.calls)
    assert result["issuer"] == f"{URL}/application/o/boards-8-5/"


def test_a_slug_from_a_name_with_umlauts_spells_them_out(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """Umlauts and sharp s are written out as German does, other letters lose their accents: no letter falls away."""
    own_without_application(fake)
    fake.others[0]["name"] = "Tafel Ü (Büro), Straße, Café"
    configured_as(ISSUER, "own-client")
    result = run_setup(client)
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body["slug"] == "tafel-ue-buero-strasse-cafe"
    assert result["issuer"] == f"{URL}/application/o/tafel-ue-buero-strasse-cafe/"


def test_a_slug_for_a_long_name_stays_within_what_authentik_takes(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """authentik keeps a slug to 50 characters. With the provider's number added to a long name, the name gives way;
    otherwise the application call fails after the provider was already changed."""
    own_without_application(fake)
    fake.others[0]["name"] = "Whiteboards of the marketing department in building B"
    fake.apps = [{"slug": "whiteboards-of-the-marketing-department-in-buildin", "name": "x", "provider": 7}]
    configured_as(ISSUER, "own-client")
    run_setup(client)
    made = next(call for call in fake.calls if (call.method, call.path) == ("POST", "/api/v3/core/applications/"))
    assert made.body["slug"] == "whiteboards-of-the-marketing-department-in-build-8"
    assert len(made.body["slug"]) <= authentik.SLUG_MAX


def test_saving_the_form_unchanged_after_the_button_keeps_the_links(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    """The button stores the issuer with the slash at the end, the form without it: the same provider, so nobody's
    sign-in is dropped."""
    member = configured_as(ISSUER, "own-client")
    shown = client.get("/api/oidc/config").json()
    assert shown["issuer"] == ISSUER
    response = client.put(
        "/api/oidc/config",
        json={"issuer": shown["issuer"], "client_id": shown["client_id"], "client_secret": "",
              "provider_name": "authentik", "auto_create": False},
        headers=UI,
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == "subject-1"  # type: ignore[union-attr]


def test_the_button_after_an_issuer_typed_by_hand_keeps_the_links(
    client: TestClient, operator: Account, fake: FakeAuthentik
) -> None:
    fake.existing = {"cert", "mapping", "provider", "application"}
    fake.provider_client = "own-client"
    member = configured_as(ISSUER.rstrip("/"), "own-client")
    result = run_setup(client)
    assert result["issuer"] == ISSUER
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == "subject-1"  # type: ignore[union-attr]


def test_another_provider_still_drops_the_links(client: TestClient, operator: Account, fake: FakeAuthentik) -> None:
    """Only the slash is forgiven: a different issuer is a different provider, and its subjects mean someone else."""
    member = configured_as(f"{URL}/application/o/other/", "own-client")
    run_setup(client)
    with SessionLocal() as db:
        assert db.get(Account, member).oidc_subject == ""  # type: ignore[union-attr]
