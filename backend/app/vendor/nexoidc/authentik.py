"""The authentik button and the blueprint (Bauplan 03).

The operator hands over the address of authentik and a one-time API token. The app then does through the authentik
API v3 what one would otherwise click together in a dozen forms: a signing key, the provider with authentik's own
scope mappings, the application, and finally its entry in the provider list. Every step reports ``ok``, a technical
``detail`` for the log, and on failure a ``reason`` with ``status`` that the page says as a sentence in the operator's
language. The first failure stops the run; what came before stays in authentik, and running the button again updates
instead of duplicating.

The token is used for these calls only: in the ``Authorization`` header and nowhere else, never stored, never logged.
The answer of a failed call goes to the log at DEBUG only, never to the page: the address comes from the operator and
could point at any service on the network.

No mapping of its own that vouches for ``email_verified``: the app never finds anybody by an address.

Several instances of one app can hang on one authentik (``_names``): first the own provider, found by the client id
stored here under whatever name (after a move to a new address, too); then an application the stored issuer names that
was left without a provider; else the plain names ``<app>``, unless a provider of that name sends people elsewhere,
then ``<app> (<host>)``. An application of another provider is never taken. Applications are searched with
``superuser_full_list``; otherwise the token sees only those its user may open.

Written against the authentik API v3 of 2024.x to 2026.8. Since 2026.8 a provider carries ``grant_types``, and the
authorize endpoint refuses every request whose grant is not listed there with ``invalid_request``; older versions
ignore the field.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import config, flow, protocol, providers
from .errors import OidcError
from .model import (
    DEFAULT_SCOPES,
    MANAGED_AUTHENTIK,
    MANAGED_HAND,
    Provider,
    ProviderValues,
    Store,
)

STEP_KEYS = ("reached", "signingKey", "mapping", "provider", "application", "filled")
#: Only in apps with one account (Bauplan 06): authentik lets only the token's own user into the application.
STEP_BINDING = "binding"
REASONS = ("unreachable", "unusable", "token", "malformed", "answered", "slug", "coupled")
#: authentik's own mappings, found by their managed names.
MANAGED_MAPPINGS = (
    "goauthentik.io/providers/oauth2/scope-openid",
    "goauthentik.io/providers/oauth2/scope-email",
    "goauthentik.io/providers/oauth2/scope-profile",
)
#: The one grant the app uses: no refresh tokens, no client credentials, no device codes.
GRANT_TYPES = ("authorization_code",)
PREFERRED_AUTHORIZATION_FLOW = "default-provider-authorization-implicit-consent"
PREFERRED_INVALIDATION_FLOW = "default-provider-invalidation-flow"
BLUEPRINT_CERTIFICATE = "authentik Self-signed Certificate"
CERT_VALIDITY_DAYS = 3650
TIMEOUT = httpx.Timeout(15.0, connect=5.0)
DETAIL_MAX = 300
#: The entry the button keeps in the provider list.
ENTRY_SLUG = "authentik"
ENTRY_LABEL = "authentik"
#: Slugs of applications: authentik keeps them to 50 characters (a Django SlugField); a host suffix to 40.
SLUG_MAX = 50
HOST_MAX = 40
SLUG_TRIES = 10
#: The slug in an issuer the button wrote: ``<authentik>/application/o/<slug>/``.
_ISSUER_SLUG = re.compile(r"/application/o/([-A-Za-z0-9_]+)/?$")
_SPELLED_OUT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"})


def _log() -> logging.Logger:
    return logging.getLogger(f"{config.current().log_name}.authentik")


def step_keys() -> tuple[str, ...]:
    """The steps of this app, in their order."""
    return STEP_KEYS + ((STEP_BINDING,) if config.current().single_account else ())


def app_name() -> str:
    return config.current().app_name


class StepFailed(Exception):
    """``detail`` is the technical line for the log; ``reason`` (with ``status``) names the failure for the page."""

    def __init__(self, detail: str, reason: str = "answered", status: int = 0) -> None:
        super().__init__(detail)
        if reason not in REASONS:
            raise ValueError(f"unknown reason {reason!r}")
        self.detail, self.reason, self.status = detail, reason, status


@dataclass
class Step:
    key: str
    ok: bool
    detail: str = ""
    reason: str = ""
    status: int = 0

    def as_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"key": self.key, "ok": self.ok, "detail": self.detail}
        if not self.ok:
            data["reason"] = self.reason
            data["status"] = self.status
        return data


@dataclass
class SetupResult:
    steps: list[Step] = field(default_factory=list)
    client_id: str = ""
    issuer: str = ""
    provider_id: int | None = None
    links_dropped: int = 0

    @property
    def ok(self) -> bool:
        return len(self.steps) == len(step_keys()) and all(step.ok for step in self.steps)

    def as_dict(self) -> dict[str, Any]:
        """The answer of ``POST <api>/oidc/authentik/setup``: always 200 with the steps that ran. Never the token,
        never the client secret."""
        return {
            "ok": self.ok,
            "steps": [step.as_dict() for step in self.steps],
            "client_id": self.client_id,
            "issuer": self.issuer,
            "provider_id": self.provider_id,
            "links_dropped": self.links_dropped,
        }


class _Api:
    """The few calls the button needs, with the token in the Authorization header and nowhere else."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            timeout=TIMEOUT,
            transport=config.transport(),
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def call(self, method: str, path: str, *, params: dict[str, str] | None = None, body: Any = None) -> Any:
        url = f"{self.base_url}/api/v3{path}"
        try:
            response = await self._client.request(method, url, params=params, json=body)
        except httpx.HTTPError as error:
            raise StepFailed(
                f"{method} {path}: authentik at {self.base_url} not reachable ({error.__class__.__name__})",
                "unreachable",
            ) from error
        except Exception as error:
            # ``httpx.InvalidURL`` and friends are not HTTPErrors; the address comes from the operator.
            raise StepFailed(
                f"{method} {path}: the address {self.base_url!r} cannot be used ({error.__class__.__name__})",
                "unusable",
            ) from error
        if not response.is_success:
            text = response.text.strip().replace("\n", " ")[:DETAIL_MAX]
            _log().debug("authentik %s %s answered %s: %r", method, path, response.status_code, text)
            kind = response.headers.get("content-type", "").split(";")[0].strip() or "no content type"
            raise StepFailed(
                f"{method} {path} answered {response.status_code} ({kind}); the log has the answer at debug level",
                "token" if response.status_code in (401, 403) else "answered",
                response.status_code,
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise StepFailed(
                f"{method} {path} answered {response.status_code} without JSON", "answered", response.status_code
            ) from error

    async def results(self, path: str, params: dict[str, str]) -> list[dict[str, Any]]:
        data = await self.call("GET", path, params=params)
        entries = data.get("results", []) if isinstance(data, dict) else []
        return [entry for entry in entries if isinstance(entry, dict)]

    async def find_one(self, path: str, params: dict[str, str], key: str, value: str) -> dict[str, Any] | None:
        """The one list entry whose ``key`` equals ``value``: the filter narrows, the exact comparison makes sure a
        looser filter or an ignored parameter does not hand back a stranger."""
        for entry in await self.results(path, params):
            if str(entry.get(key) or "") == value:
                return entry
        return None


def _pk(entry: Any, what: str) -> Any:
    pk = entry.get("pk") if isinstance(entry, dict) else None
    if pk in (None, ""):
        raise StepFailed(f"{what} has no pk in authentik's answer", "answered", 200)
    return pk


# ---------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------


async def _reached(api: _Api) -> str:
    data = await api.call("GET", "/admin/version/")
    version = str(data.get("version_current") or "") if isinstance(data, dict) else ""
    return f"authentik {version}" if version else "authentik reached, version unknown"


async def _signing_key(api: _Api) -> tuple[Any, str]:
    name = app_name()
    existing = await api.find_one("/crypto/certificatekeypairs/", {"name": name}, "name", name)
    if existing is not None:
        return _pk(existing, "the certificate"), f"using the existing certificate {name!r}"
    created = await api.call(
        "POST",
        "/crypto/certificatekeypairs/generate/",
        body={"common_name": name, "subject_alt_name": "", "validity_days": CERT_VALIDITY_DAYS, "alg": "rsa"},
    )
    return _pk(created, "the generated certificate"), f"generated the certificate {name!r} ({CERT_VALIDITY_DAYS} days)"


async def _mappings(api: _Api) -> tuple[list[Any], str]:
    ids = []
    for managed in MANAGED_MAPPINGS:
        found = await api.find_one("/propertymappings/provider/scope/", {"managed": managed}, "managed", managed)
        if found is None:
            raise StepFailed(f"authentik's own scope mapping {managed!r} was not found", "answered", 200)
        ids.append(_pk(found, "a scope mapping"))
    return ids, "using authentik's own mappings for openid, email and profile"


async def _flow(api: _Api, designation: str, preferred: str) -> Any:
    entries = await api.results("/flows/instances/", {"designation": designation})
    if not entries:
        raise StepFailed(f"no flow with designation {designation!r} in authentik", "answered", 200)
    for entry in entries:
        if entry.get("slug") == preferred:
            return _pk(entry, "a flow")
    return _pk(entries[0], "a flow")


def _ascii(text: str) -> str:
    return unicodedata.normalize("NFKD", text.translate(_SPELLED_OUT)).encode("ascii", "ignore").decode("ascii")


def instance_names(redirect_uri: str) -> tuple[str, str]:
    """Name and slug of this instance when another instance of the app holds the plain names already."""
    host = urlsplit(redirect_uri).netloc.lower()
    # The host part takes at most 40 characters, and the whole slug stays within authentik's 50 (Bauplan 03).
    room = min(HOST_MAX, SLUG_MAX - len(app_name()) - 1)
    suffix = re.sub(r"[^a-z0-9]+", "-", _ascii(host)).strip("-")[:room].strip("-") or "instance"
    return f"{app_name()} ({host})", f"{app_name()}-{suffix}"


async def _application_by_slug(api: _Api, slug: str) -> dict[str, Any] | None:
    return await api.find_one("/core/applications/", {"slug": slug, "superuser_full_list": "true"}, "slug", slug)


async def _free_slug(api: _Api, name: str, pk: str) -> str:
    """A slug for a new application of the own provider: from its name, then with the provider's number, then counted
    on, each at most 50 characters with the ending. Free: no application has it, or the one there has no provider or
    this one. An application of another provider is never taken."""
    base = re.sub(r"[^a-z0-9]+", "-", _ascii(name.lower())).strip("-") or app_name()
    suffixes = ["", f"-{pk}"] + [f"-{pk}-{number}" for number in range(2, SLUG_TRIES)]
    tries = [f"{base[: SLUG_MAX - len(suffix)].rstrip('-')}{suffix}" for suffix in suffixes]
    for candidate in tries:
        taken = await _application_by_slug(api, candidate)
        if taken is None or str(taken.get("provider") or "") in ("", pk):
            return candidate
    raise StepFailed(
        f"every slug from {tries[0]!r} to {tries[-1]!r} belongs to an application of another provider", "slug"
    )


async def _own_names(api: _Api, entry: Provider | None) -> tuple[str, str] | None:
    """Name and slug of what this instance signed in with so far, or None when authentik holds nothing of it."""
    if entry is None:
        return None
    found = _ISSUER_SLUG.search(entry.issuer + "/")
    slug = found.group(1) if found else ""
    named = await _application_by_slug(api, slug) if slug else None
    own = None
    if entry.client_id:
        own = await api.find_one("/providers/oauth2/", {"client_id": entry.client_id}, "client_id", entry.client_id)
    if own is not None:
        pk, name = str(own.get("pk") or ""), str(own.get("name") or app_name())
        # The provider's own answer names its application; the application list cannot be filtered by provider.
        assigned = str(own.get("assigned_application_slug") or "")
        if assigned:
            return name, assigned
        if slug and (named is None or not named.get("provider")):
            return name, slug
        return name, await _free_slug(api, name, pk)
    if named is not None and not named.get("provider"):
        name = str(named.get("name") or app_name())
        # A provider of that name belongs to another instance: taking it would bend that one.
        if await api.find_one("/providers/oauth2/", {"name": name}, "name", name) is None:
            return name, slug
    return None


async def _names(api: _Api, entry: Provider | None, redirect_uri: str) -> tuple[str, str]:
    names = await _own_names(api, entry)
    if names is not None:
        return names
    plain = app_name()
    existing = await api.find_one("/providers/oauth2/", {"name": plain}, "name", plain)
    if existing is None:
        return plain, plain
    urls = {str(item.get("url", "")) for item in existing.get("redirect_uris") or [] if isinstance(item, dict)}
    if not urls or redirect_uri in urls:
        return plain, plain
    return instance_names(redirect_uri)


async def _entry(store: Store, api: _Api) -> Provider | None:
    """The entry of the list the button looks after: the one it made (``managed = "authentik"``), else a hand-made
    entry at this authentik whose client id names a provider there (the operator typed in by hand what the button
    would have made)."""
    entries = store.list_providers()
    managed = [entry for entry in entries if entry.managed == MANAGED_AUTHENTIK]
    if managed:
        return managed[0]
    prefix = f"{api.base_url}/application/o/".lower()
    for entry in entries:
        if entry.managed != MANAGED_HAND or not (entry.issuer + "/").lower().startswith(prefix) or not entry.client_id:
            continue
        if await api.find_one("/providers/oauth2/", {"client_id": entry.client_id}, "client_id", entry.client_id):
            return entry
    return None


async def _provider(
    api: _Api, redirect_uri: str, signing_key: Any, mappings: list[Any], name: str
) -> tuple[Any, str, str, str]:
    authorization = await _flow(api, "authorization", PREFERRED_AUTHORIZATION_FLOW)
    invalidation = await _flow(api, "invalidation", PREFERRED_INVALIDATION_FLOW)
    body = {
        "name": name,
        "authorization_flow": authorization,
        "invalidation_flow": invalidation,
        "client_type": "confidential",
        "grant_types": list(GRANT_TYPES),
        "redirect_uris": [{"matching_mode": "strict", "url": redirect_uri}],
        "signing_key": signing_key,
        "sub_mode": "user_uuid",
        "property_mappings": mappings,
        "include_claims_in_id_token": True,
    }
    existing = await api.find_one("/providers/oauth2/", {"name": name}, "name", name)
    if existing is None:
        answer = await api.call("POST", "/providers/oauth2/", body=body)
        note = f"created the provider {name!r}"
    else:
        answer = await api.call("PATCH", f"/providers/oauth2/{_pk(existing, 'the provider')}/", body=body)
        note = f"updated the existing provider {name!r}"
    if not isinstance(answer, dict):
        raise StepFailed("the provider call answered without an object", "answered", 200)
    client_id = str(answer.get("client_id") or "")
    client_secret = str(answer.get("client_secret") or "")
    if not client_id or not client_secret:
        raise StepFailed("authentik's provider answer carries no client_id or client_secret", "answered", 200)
    return _pk(answer, "the provider"), client_id, client_secret, note


async def _application(api: _Api, provider_pk: Any, name: str, slug: str) -> tuple[Any, str, str]:
    """Create or update the application of the provider: (its pk, its slug, the detail). When the slug the names step
    chose belongs to an application of another provider, a replacement slug is taken (``_free_slug``): that
    application is never taken over."""
    existing = await _application_by_slug(api, slug)
    if existing is not None and str(existing.get("provider") or "") not in ("", str(provider_pk)):
        slug = await _free_slug(api, name, str(provider_pk))
        existing = await _application_by_slug(api, slug)
    body = {"name": name, "slug": slug, "provider": provider_pk}
    if existing is None:
        answer = await api.call("POST", "/core/applications/", body=body)
        return _pk(answer, "the application"), slug, f"created the application {slug!r}"
    answer = await api.call("PATCH", f"/core/applications/{slug}/", body=body)
    pk = answer.get("pk") if isinstance(answer, dict) and answer.get("pk") else _pk(existing, "the application")
    return pk, slug, f"updated the existing application {slug!r}"


async def _binding(api: _Api, application_pk: Any) -> str:
    """Only the token's own user may open the application: with a binding in place, authentik lets in only whoever
    passes one. The app refuses every other identity anyway; authentik then turns them away before."""
    data = await api.call("GET", "/core/users/me/")
    user = data.get("user") if isinstance(data, dict) else None
    if not isinstance(user, dict):
        raise StepFailed("authentik's answer names no user for this token", "answered", 200)
    user_pk, username = _pk(user, "the token's user"), str(user.get("username") or "")
    for entry in await api.results("/policies/bindings/", {"target": str(application_pk)}):
        if str(entry.get("user") or "") == str(user_pk):
            return f"the application already lets {username!r} in"
    await api.call(
        "POST",
        "/policies/bindings/",
        body={"target": application_pk, "user": user_pk, "order": 0, "enabled": True, "negate": False, "timeout": 30},
    )
    return f"the application lets only {username!r} in"


def issuer_for(base_url: str, slug: str) -> str:
    """The issuer as authentik writes it."""
    return f"{base_url.rstrip('/')}/application/o/{slug}/"


async def _fill(
    store: Store, entry: Provider | None, entry_slug: str, issuer: str, client_id: str, client_secret: str
) -> tuple[Provider, int, str]:
    """Write the entry, then confirm the issuer with one discovery. Stored first: the values are what authentik handed
    out, and a failed discovery usually means the app cannot reach authentik under this address, which the operator
    fixes at the network. A new entry is on, makes no new accounts and trusts authentik with the second factor; an
    existing one keeps the operator's choices and only gets issuer, client id and secret."""
    dropped = 0
    if entry is None:
        position = max((item.position for item in store.list_providers()), default=-1) + 1
        saved = store.insert_provider(
            ProviderValues(
                slug=entry_slug,
                label=ENTRY_LABEL,
                issuer=protocol.normalize_issuer(issuer),
                client_id=client_id,
                client_secret=client_secret,
                scopes=DEFAULT_SCOPES,
                enabled=True,
                auto_create=False,
                trusts_second_factor=True,
                managed=MANAGED_AUTHENTIK,
                position=position,
            )
        )
        note = f"entry {saved.slug!r} added"
    else:
        dropped = providers.change_issuer(store, entry, issuer)
        saved = store.update_provider(
            entry.id,
            ProviderValues(
                slug=entry.slug,
                label=entry.label,
                issuer=protocol.normalize_issuer(issuer),
                client_id=client_id,
                client_secret=client_secret,
                scopes=entry.scopes,
                enabled=entry.enabled,
                auto_create=entry.auto_create,
                trusts_second_factor=entry.trusts_second_factor,
                managed=MANAGED_AUTHENTIK,
                position=entry.position,
                redirect_path=entry.redirect_path,
            ),
        )
        note = f"entry {saved.slug!r} updated" + (f", {dropped} links dropped" if dropped else "")
    store.commit()
    protocol.clear_caches()
    try:
        await protocol.discovery(issuer, fresh=True)
    except OidcError as error:
        reason = "unreachable" if error.code == "oidc_provider_unreachable" else "answered"
        raise StepFailed(
            f"{note}, but discovery at {issuer} failed: {error.code}", reason, 200 if reason == "answered" else 0
        ) from error
    return saved, dropped, f"{note}; discovery at {issuer} confirmed"


async def setup(store: Store, base_url: str, token: str, request_base: str) -> SetupResult:
    """The whole run, step by step. Stops at the first failure; the result lists every step that ran."""
    base_url = base_url.strip().rstrip("/")
    result = SetupResult()
    if providers.coupled(store):
        # While coupled, sign-in comes through nexsuite (Bauplan 06): the button touches neither authentik nor the
        # list, and says so at the first step. The app locks the card meanwhile; this is the guard behind it.
        detail = "the app is coupled to nexsuite; the button changes nothing until it is uncoupled"
        result.steps.append(Step(STEP_KEYS[0], False, detail, "coupled", 0))
        _log().warning("authentik setup stopped at step %s: %s", STEP_KEYS[0], detail)
        return result
    try:
        if not token.isascii() or not token.isprintable() or any(char.isspace() for char in token):
            # No HTTP header carries it, so no authentik token looks like this (Bauplan 03: reason "malformed").
            raise StepFailed("the token holds characters an HTTP header cannot carry", "malformed", 0)
        api = _Api(base_url, token)
    except StepFailed as error:
        result.steps.append(Step(STEP_KEYS[0], False, error.detail, error.reason, error.status))
        _log().warning("authentik setup stopped at step %s: %s", STEP_KEYS[0], error.detail)
        return result
    except Exception as error:  # noqa: BLE001
        # Whatever else keeps the client from being built comes from the address the operator typed.
        detail = f"the address {base_url!r} cannot be used ({error.__class__.__name__})"
        result.steps.append(Step(STEP_KEYS[0], False, detail, "unusable", 0))
        _log().warning("authentik setup stopped at step %s: %s", STEP_KEYS[0], detail)
        return result
    signing_key: Any = None
    mappings: list[Any] = []
    provider_pk: Any = None
    application_pk: Any = None
    entry: Provider | None = None
    entry_slug = ENTRY_SLUG
    client_id = client_secret = ""
    name = slug = app_name()
    try:
        for key in step_keys():
            try:
                if key == "reached":
                    detail = await _reached(api)
                elif key == "signingKey":
                    signing_key, detail = await _signing_key(api)
                elif key == "mapping":
                    mappings, detail = await _mappings(api)
                elif key == "provider":
                    entry = await _entry(store, api)
                    entry_slug = entry.slug if entry is not None else providers.free_slug(store, ENTRY_SLUG)
                    redirect = flow.redirect_uri(entry_slug, request_base, entry.redirect_path if entry else "")
                    name, slug = await _names(api, entry, redirect)
                    result.issuer = issuer_for(base_url, slug)
                    provider_pk, client_id, client_secret, detail = await _provider(
                        api, redirect, signing_key, mappings, name
                    )
                    result.client_id = client_id
                elif key == "application":
                    application_pk, slug, detail = await _application(api, provider_pk, name, slug)
                    result.issuer = issuer_for(base_url, slug)
                elif key == "filled":
                    saved, result.links_dropped, detail = await _fill(
                        store, entry, entry_slug, result.issuer, client_id, client_secret
                    )
                    result.provider_id = saved.id
                else:
                    detail = await _binding(api, application_pk)
            except StepFailed as error:
                result.steps.append(Step(key, False, error.detail, error.reason, error.status))
                _log().warning("authentik setup stopped at step %s: %s", key, error.detail)
                break
            result.steps.append(Step(key, True, detail))
            _log().info("authentik setup step %s done: %s", key, detail)
    finally:
        await api.close()
    return result


# ---------------------------------------------------------------------------
# The blueprint
# ---------------------------------------------------------------------------


def blueprint_filename() -> str:
    return f"{app_name()}-authentik.yaml"


def blueprint(redirect_uri: str) -> str:
    """A blueprint (schema v1) that creates what the button creates, with fixed plain names, ``grant_types``,
    authentik's own self-signed certificate (a blueprint cannot generate one) and the callback of the entry. Client id
    and secret go into the provider form afterwards.

    ``!Find`` and ``!KeyOf`` are authentik's YAML tags, so the file is written as text. Every value that comes from
    outside is emitted as a JSON string, a valid double-quoted YAML scalar whatever it carries."""
    name = app_name()
    quoted = json.dumps
    mappings = "\n".join(
        f"        - !Find [authentik_providers_oauth2.scopemapping, [managed, {quoted(managed)}]]"
        for managed in MANAGED_MAPPINGS
    )
    grants = "\n".join(f"        - {grant}" for grant in GRANT_TYPES)
    return f"""# {name}: OpenID Connect provider and application for authentik.
#
# Apply it under Customization, Blueprints (create a blueprint from this file) or drop it into the blueprints/custom/
# directory of the authentik worker. Afterwards copy client id and client secret from the provider "{name}"
# (Applications, Providers) into {name} under Settings, Server, Sign-in, Sign-in providers, with the issuer
# <authentik address>/application/o/{name}/.
#
# The signing key is authentik's own self-signed certificate: a blueprint cannot generate one. Pick another
# certificate at the provider afterwards if you prefer. grant_types exists since authentik 2026.8, where a provider
# without it refuses every sign-in; older versions ignore the line.
#
# Give the entry in {name} the short name of the redirect address below ({{slug}} in .../oidc/{{slug}}/callback),
# so that the address the provider knows and the one {name} sends are the same.
#
# A second instance of {name} at the same authentik: the plain names "{name}" belong to the first one. Rename provider
# and application in this file first (for example "{name} (host)" and slug "{name}-host"), or applying it takes over
# the first instance's provider and sends its people to this address. The button in {name} does that by itself.
version: 1
metadata:
  name: {quoted(name)}
  labels:
    blueprints.goauthentik.io/description: {quoted("OpenID Connect provider and application for " + name)}
entries:
  - model: authentik_providers_oauth2.oauth2provider
    state: present
    id: {name}-provider
    identifiers:
      name: {quoted(name)}
    attrs:
      authorization_flow: !Find [authentik_flows.flow, [slug, {PREFERRED_AUTHORIZATION_FLOW}]]
      invalidation_flow: !Find [authentik_flows.flow, [slug, {PREFERRED_INVALIDATION_FLOW}]]
      client_type: confidential
      grant_types:
{grants}
      redirect_uris:
        - matching_mode: strict
          url: {quoted(redirect_uri)}
      signing_key: !Find [authentik_crypto.certificatekeypair, [name, {quoted(BLUEPRINT_CERTIFICATE)}]]
      sub_mode: user_uuid
      include_claims_in_id_token: true
      property_mappings:
{mappings}
  - model: authentik_core.application
    state: present
    identifiers:
      slug: {quoted(name)}
    attrs:
      name: {quoted(name)}
      provider: !KeyOf {name}-provider
"""


def blueprint_redirect(store: Store, request_base: str) -> str:
    """The callback the blueprint names: that of the button's entry, else of the entry the button would make."""
    managed = [entry for entry in store.list_providers() if entry.managed == MANAGED_AUTHENTIK]
    if managed:
        return flow.provider_redirect_uri(managed[0], request_base)
    return flow.redirect_uri(providers.free_slug(store, ENTRY_SLUG), request_base)
