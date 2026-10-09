"""What the module needs to know about the app it runs in.

The module imports nothing from an app. The app hands over what is its own business once at start-up, before the
first request, with ``configure(AppConfig(...))``: its name, its server secret, where its API lives, its public
address, whether it has only one account. Everything else (database, accounts, invitations, sessions) comes in
through the ``Store`` protocol (``model.py``) at the moment it is needed.

Tests replace the network with ``use_transport(httpx.MockTransport(...))``; nothing in the module then touches it.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

import httpx

#: An app name as it appears in cookie names, key prefixes, authentik names and slugs.
_APP_NAME = re.compile(r"[a-z][a-z0-9-]{1,30}")
#: Where an API lives: ``/api`` for most apps, ``/api/v1`` for apps whose whole API sits there (Bauplan 06).
_API_PREFIX = re.compile(r"(/[a-z0-9]+)+")


def _no_public_url() -> str:
    return ""


@dataclass(frozen=True)
class AppConfig:
    """The app's side of the contract. Only ``app_name`` and ``server_secret`` are required.

    ``server_secret`` returns the app's own server secret (the one its sessions are signed with). The module never
    uses it directly: the attempt cookie gets a key derived from it with the prefix ``<app>-oidc-attempt:``, so an
    attempt never passes as a session and a session never as an attempt.

    ``public_url`` returns the address people use to reach the app, without a slash at the end, or "" when none is
    set: the app's setting first, then the environment variable ``<APP>_PUBLIC_URL``. Without one the module falls back
    to the address of the request, which is wrong behind a proxy; the authentik card warns about that.
    """

    app_name: str
    server_secret: Callable[[], str | bytes]
    api_prefix: str = "/api"
    public_url: Callable[[], str] = _no_public_url
    #: nexcrate and nexsift: one account only. No invitations, no new accounts through a provider, and the authentik
    #: button adds the step ``binding`` (Bauplan 06).
    single_account: bool = False
    #: The logger the module writes to. Default ``<app>.oidc``.
    logger_name: str = ""
    #: Where the browser lands. A refused sign-in goes to ``login_page?error=<code>``, a refused linking to
    #: ``account_page?error=<code>``, a successful sign-in to ``home``.
    login_page: str = "/login"
    account_page: str = "/account"
    home: str = "/"

    def __post_init__(self) -> None:
        if not _APP_NAME.fullmatch(self.app_name):
            raise ValueError(f"app_name {self.app_name!r} must be lower-case letters, digits and dashes")
        if not _API_PREFIX.fullmatch(self.api_prefix):
            raise ValueError(f"api_prefix {self.api_prefix!r} must look like /api or /api/v1")
        for page in (self.login_page, self.account_page, self.home):
            if not page.startswith("/") or page.startswith("//"):
                raise ValueError(f"page {page!r} must be a path of this app")

    @property
    def log_name(self) -> str:
        return self.logger_name or f"{self.app_name}.oidc"

    @property
    def cookie_name(self) -> str:
        return f"{self.app_name.replace('-', '_')}_oidc"

    @property
    def cookie_path(self) -> str:
        return f"{self.api_prefix}/oidc"


_config: AppConfig | None = None
_transport: httpx.BaseTransport | None = None


def configure(config: AppConfig) -> None:
    """Called once by the app at start-up. Calling it again replaces the configuration (tests do that)."""
    global _config
    _config = config


def current() -> AppConfig:
    if _config is None:
        raise RuntimeError("nexoidc is not configured: the app calls nexoidc.configure(AppConfig(...)) at start-up")
    return _config


def use_transport(transport: httpx.BaseTransport | None) -> None:
    """For tests: every call to a provider and to authentik goes through this transport. None: the network."""
    global _transport
    _transport = transport


def transport() -> httpx.BaseTransport | None:
    return _transport
