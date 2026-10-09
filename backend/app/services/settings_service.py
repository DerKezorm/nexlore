"""Operator settings in the database, with defaults."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Setting

DEFAULTS: dict[str, Any] = {
    "log_mode": "normal",
    "log_mode_until": None,
    #: off | daily | weekly. Daily in the night unless the operator decides otherwise (review before 1.0.0, P1.24).
    "backup_schedule": "daily",
    "backup_keep": 7,
    #: Where uploaded files go, next to the note they belong to. Only a name, never a path.
    "attachment_folder": "Attachments",
    #: Largest single upload, in MB.
    "upload_max_mb": 1024,
    #: Space per account for what it uploaded, in MB; 0 is no limit.
    "quota_mb": 0,
    #: Remove the place and the device from photos and videos on upload.
    "strip_location": True,
    #: The address people use to reach nexlore: invitation and share links, the OIDC redirect. Empty means
    #: ``NEXLORE_PUBLIC_URL``, and without that the request's own.
    "public_url": "",
    #: Members may sign in with a password. The operator always may: the emergency exit when OIDC fails.
    "password_login": True,
    #: Every account that signs in with a password needs a second factor; until it has one, it reaches only its
    #: account page. Accounts from OIDC bring their provider's.
    "two_factor_required": False,
    #: The single OIDC provider before the provider list (``oidc_providers``): read once by the migration
    #: (``services/oidc_store.migrate_settings``) and left for one version as the way back, then gone.
    "oidc_issuer": "",
    "oidc_client_id": "",
    "oidc_client_secret_enc": "",
    "oidc_provider_name": "",
    "oidc_auto_create": False,
    #: The settings above were looked at once and, where there was a provider, became the entry ``oidc``.
    "oidc_list_migrated": False,
    #: Public reading pages: a way out, closed until the operator opens it.
    "shares_allowed": False,
    #: AI from outside (M7): off until the operator opens it, and the highest level a key may have.
    "mcp_allowed": False,
    "mcp_max_level": "read",
    #: Tools no account may use, whatever its keys say (block Y, design answer Y2); at first what cannot be undone.
    "mcp_blocked_tools": ["delete_space", "empty_trash"],
    #: Connectors may sign in for MCP (OAuth, block Y); only while MCP itself is open.
    "mcp_oauth_allowed": True,
    #: Tokens for programs such as n8n or nexdeck (``/api/v1``): a way in from outside, closed until the operator
    #: opens it (design answer).
    "api_tokens_allowed": False,
    #: Notifications (block Z2): the day the disk was last looked at, and the newest version operators were told of.
    "notify_disk_day": "",
    "notify_version": "",
    #: The calendar subscription of each account: the tasks go to wherever the address is given, so closed until
    #: the operator opens it.
    "calendar_feed_allowed": False,
    #: Titles of links pasted into notes, asked from the pages themselves (services/linktitle): closed until opened.
    "link_titles_allowed": False,
    #: Plugin files of one's own, not from the catalog (M7): off until the operator opens it.
    "plugin_upload_allowed": False,
    #: AI in notes, with each account's own service: note text leaves the house, so closed until the operator opens it.
    "ai_allowed": False,
    #: Hosts in the own network (or this machine) members may use as AI service, one per line: "192.168.1.20",
    #: "ollama.lan:11434". Everything else in the own network is refused; public addresses are always allowed.
    "ai_private_hosts": "",
    #: Who brings the AI service (Frag Lore, design answer 05.10.2026): "own", each account its own; "shared", the
    #: operator's one service for every account, whose own accesses rest meanwhile.
    "ai_mode": "own",
    "ai_shared_url": "",
    "ai_shared_model": "",
    "ai_shared_key_enc": "",
    #: Frag Lore (questions about the notes): a switch of its own above AI in notes, off from the start.
    "lore_allowed": False,
    #: Requests per account and minute, for the editor and for Lore together.
    "ai_per_minute": 20,
    #: The model of the operator's service that turns notes into vectors, to find them by their meaning (only with
    #: one service for all); empty: by their words only.
    "ai_embed_model": "",
    #: Days a conversation with Lore stays after its last question; 0 keeps it until the account removes it.
    "lore_keep_days": 90,
    # Own CSS of the accounts (snippets): closed from the start, CSS can change how every page of the account looks.
    "custom_css_allowed": False,
    #: Ask GitHub once a day whether a newer nexlore is out (services/updates). Only the question goes out, so on.
    "update_check": True,
    #: Invitation mail: without a host nothing is sent, the link to copy is enough.
    "smtp_host": "",
    "smtp_port": 587,
    #: starttls | tls | none
    "smtp_security": "starttls",
    "smtp_user": "",
    "smtp_password_enc": "",
    "smtp_from": "",
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value


def get_all(db: Session) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in db.scalars(select(Setting)):
        values[row.key] = row.value
    return values


def save(db: Session, changes: dict[str, Any]) -> None:
    for key, value in changes.items():
        if key not in DEFAULTS:
            raise KeyError(key)
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    db.commit()


def normalize_public_url(value: str) -> str:
    """``scheme://host[:port]`` and nothing else, or empty. ``ValueError`` for anything people could not type into
    a browser: no other schemes, no credentials, no path, no query."""
    text = value.strip()
    if not text:
        return ""
    parts = urlsplit(text)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("scheme or host")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("path, query or credentials")
    try:
        parts.port  # noqa: B018 - raises ValueError when the port is not a number
    except ValueError as exc:
        raise ValueError("port") from exc
    return f"{parts.scheme.lower()}://{parts.netloc}"


def public_url(db: Session) -> str:
    """The public address without a trailing slash: the setting, otherwise the environment, otherwise empty."""
    stored = str(get(db, "public_url") or "").strip().rstrip("/")
    return stored or get_settings().public_url.strip().rstrip("/")
