"""The operator's settings: address, sign-in, public pages, invitation mail, backups.

Secrets (the mail password) are written encrypted and never read back: the answer only says whether one is set.
The files settings live in ``routers/attachments.py``, the sign-in providers in ``routers/oidc.py``.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..deps import DbSession, OperatorAccount
from ..errors import error
from ..security import encrypt_secret
from ..services import accounts, ai, guide, kontenpost, lore, settings_service
from ..services.oidc_store import SqlStore
from ..vendor.nexoidc import authentik, flow
from . import server_signin

logger = logging.getLogger("nexlore.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])

#: The sign-in switches under their names here and in the shared account module (``signin.change``): the old way
#: keeps them and keeps to the module's rules (a provider first, an own second factor first, the password to switch
#: the second factor for everybody off).
SWITCHES = {"password_login": "password_login", "two_factor_required": "factor_required",
            "passkeys_allowed": "passkeys_allowed"}


class SettingsOut(BaseModel):
    public_url: str
    password_login: bool
    two_factor_required: bool
    passkeys_allowed: bool
    shares_allowed: bool
    backup_schedule: str
    backup_keep: int
    smtp_host: str
    smtp_port: int
    smtp_security: str
    smtp_user: str
    smtp_password_set: bool
    smtp_from: str
    mcp_allowed: bool
    mcp_max_level: str
    mcp_oauth_allowed: bool
    api_tokens_allowed: bool
    app_pairing_allowed: bool
    calendar_feed_allowed: bool
    link_titles_allowed: bool
    plugin_upload_allowed: bool
    ai_allowed: bool
    ai_private_hosts: str
    ai_mode: str
    ai_per_minute: int
    lore_allowed: bool
    lore_keep_days: int
    custom_css_allowed: bool


class SettingsIn(BaseModel):
    public_url: str | None = Field(default=None, max_length=255)
    #: The operator said yes to the question that came back with 409 ``public_url_change`` (module 1.0.10).
    confirm_address: bool | None = None
    #: The operator's own password: asked when the second factor for everybody goes off (konten 1.1.0).
    current_password: str = Field(default="", max_length=200)
    password_login: bool | None = None
    two_factor_required: bool | None = None
    passkeys_allowed: bool | None = None
    shares_allowed: bool | None = None
    backup_schedule: Literal["off", "daily", "weekly", "monthly"] | None = None
    backup_keep: int | None = Field(default=None, ge=1, le=365)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "none"] | None = None
    smtp_user: str | None = Field(default=None, max_length=255)
    #: Empty removes the password; left out keeps it.
    smtp_password: str | None = Field(default=None, max_length=500)
    smtp_from: str | None = Field(default=None, max_length=255)
    mcp_allowed: bool | None = None
    mcp_max_level: Literal["read", "draft", "write"] | None = None
    mcp_oauth_allowed: bool | None = None
    api_tokens_allowed: bool | None = None
    app_pairing_allowed: bool | None = None
    calendar_feed_allowed: bool | None = None
    link_titles_allowed: bool | None = None
    plugin_upload_allowed: bool | None = None
    ai_allowed: bool | None = None
    ai_private_hosts: str | None = Field(default=None, max_length=2000)
    ai_mode: Literal["own", "shared"] | None = None
    lore_allowed: bool | None = None
    ai_per_minute: int | None = Field(default=None, ge=1, le=600)
    #: 0 keeps conversations until the account removes them.
    lore_keep_days: int | None = Field(default=None, ge=0, le=3650)
    custom_css_allowed: bool | None = None


class TestMailIn(BaseModel):
    to: str = Field(max_length=255)


def _view(db: DbSession) -> SettingsOut:
    values = settings_service.get_all(db)
    return SettingsOut(
        public_url=values["public_url"],
        password_login=values["password_login"],
        two_factor_required=bool(values["two_factor_required"]),
        passkeys_allowed=bool(values["passkeys_allowed"]),
        shares_allowed=values["shares_allowed"],
        backup_schedule=values["backup_schedule"],
        backup_keep=values["backup_keep"],
        smtp_host=values["smtp_host"],
        smtp_port=values["smtp_port"],
        smtp_security=values["smtp_security"],
        smtp_user=values["smtp_user"],
        smtp_password_set=bool(values["smtp_password_enc"]),
        smtp_from=values["smtp_from"],
        mcp_allowed=bool(values["mcp_allowed"]),
        mcp_max_level=str(values["mcp_max_level"]),
        mcp_oauth_allowed=bool(values["mcp_oauth_allowed"]),
        api_tokens_allowed=bool(values["api_tokens_allowed"]),
        app_pairing_allowed=bool(values["app_pairing_allowed"]),
        calendar_feed_allowed=bool(values["calendar_feed_allowed"]),
        link_titles_allowed=bool(values["link_titles_allowed"]),
        plugin_upload_allowed=bool(values["plugin_upload_allowed"]),
        ai_allowed=bool(values["ai_allowed"]),
        ai_private_hosts=str(values["ai_private_hosts"] or ""),
        ai_mode=ai.mode(db),
        lore_allowed=bool(values["lore_allowed"]),
        ai_per_minute=ai.per_minute(db),
        lore_keep_days=lore.keep_days(db),
        custom_css_allowed=bool(values["custom_css_allowed"]),
    )


@router.get("", response_model=SettingsOut)
def read(_operator: OperatorAccount, db: DbSession) -> SettingsOut:
    return _view(db)


@router.put("", response_model=SettingsOut)
def save(payload: SettingsIn, operator: OperatorAccount, db: DbSession, request: Request) -> SettingsOut:
    changes: dict[str, Any] = {}
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is None or key in ("confirm_address", "current_password"):
            continue
        if key == "public_url":
            try:
                value = settings_service.normalize_public_url(value)
                if value:
                    # Nothing the sign-in module would refuse as a public address.
                    value = flow.clean_public_url(value)
            except ValueError as exc:
                raise error("invalid_url", "Give an address like https://notes.example.com.", 422) from exc
            if value != settings_service.public_url(db):
                # The address leaves what authentik (or a provider entered by hand) knows behind: ask first (1.0.10).
                question = authentik.public_url_guard(
                    SqlStore(db), value, str(request.base_url), confirm=bool(payload.confirm_address)
                )
                if question is not None:
                    raise error("public_url_change", "The address changes what the providers know.", 409, **question)
        elif key == "smtp_from":
            value = value.strip()
            if value and not accounts.EMAIL_PATTERN.match(value):
                raise error("invalid_email", "This is not a mail address.", 422)
        elif key in SWITCHES:
            # The sign-in switches go through the shared account module's rules (Server › Sign-in).
            continue
        elif key == "ai_private_hosts":
            try:
                value = "\n".join(ai.parse_hosts(value))
            except ai.AiError as exc:
                raise error("ai_hosts_invalid", "One host per line, like 192.168.1.20 or ollama.lan:11434.",
                            422) from exc
        elif key == "smtp_password":
            changes["smtp_password_enc"] = encrypt_secret(value)
            continue
        elif isinstance(value, str):
            value = value.strip()
        changes[key] = value
    switches = {SWITCHES[key]: value for key, value in payload.model_dump(exclude_unset=True).items()
                if key in SWITCHES and value is not None}
    if switches:
        server_signin.change(db, request, operator, current_password=payload.current_password, **switches)
    settings_service.save(db, changes)
    logger.info("Settings changed keys=%s by=%s", ",".join(sorted([*changes, *switches])), operator.name)
    return _view(db)


@router.post("/mail-test", status_code=204, summary="Send a test mail through the configured server")
def mail_test(payload: TestMailIn, operator: OperatorAccount, db: DbSession) -> None:
    to = payload.to.strip()
    if not accounts.EMAIL_PATTERN.match(to):
        raise error("invalid_email", "This is not a mail address.", 422)
    try:
        kontenpost.send_test(db, to, operator.language or "en")
    except kontenpost.MailError as exc:
        # The reason goes to the log by its kind only: an SMTP answer can quote the address or the credentials.
        logger.warning("Test mail not sent reason=%s", exc.code)
        # The codes of 1.16.0: no server, or the server did not take it.
        code = "mail_off" if exc.code == "mail_off" else "mail_failed"
        raise error(code, str(exc), 502) from exc


class GuideIn(BaseModel):
    #: "de" or "en"; empty: the operator's own language.
    language: str = Field(default="", max_length=16)


@router.post("/guide", status_code=201, summary="Make the space with the guide again, next to what is there")
def make_guide(payload: GuideIn, operator: OperatorAccount) -> dict[str, str]:
    name = guide.create(operator.id, payload.language or operator.language or "en")
    logger.info("Guide made again space=%s by=%s", name, operator.name)
    return {"space": name}
