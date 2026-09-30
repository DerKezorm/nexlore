"""The operator's settings: address, sign-in, public pages, invitation mail, backups.

Secrets (the mail password) are written encrypted and never read back: the answer only says whether one is set.
The files settings live in ``routers/attachments.py``, the OIDC ones in ``routers/oidc.py``.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..deps import DbSession, OperatorAccount
from ..errors import error
from ..models import SIGN_IN_PASSWORD
from ..security import encrypt_secret
from ..services import accounts, guide, mailer, settings_service

logger = logging.getLogger("nexlore.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsOut(BaseModel):
    public_url: str
    password_login: bool
    two_factor_required: bool
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
    calendar_feed_allowed: bool
    link_titles_allowed: bool
    plugin_upload_allowed: bool
    ai_allowed: bool
    custom_css_allowed: bool


class SettingsIn(BaseModel):
    public_url: str | None = Field(default=None, max_length=255)
    password_login: bool | None = None
    two_factor_required: bool | None = None
    shares_allowed: bool | None = None
    backup_schedule: Literal["off", "daily", "weekly"] | None = None
    backup_keep: int | None = Field(default=None, ge=1, le=100)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "none"] | None = None
    smtp_user: str | None = Field(default=None, max_length=255)
    #: Empty removes the password; left out keeps it.
    smtp_password: str | None = Field(default=None, max_length=500)
    smtp_from: str | None = Field(default=None, max_length=255)
    mcp_allowed: bool | None = None
    mcp_max_level: Literal["read", "draft", "write"] | None = None
    calendar_feed_allowed: bool | None = None
    link_titles_allowed: bool | None = None
    plugin_upload_allowed: bool | None = None
    ai_allowed: bool | None = None
    custom_css_allowed: bool | None = None


class TestMailIn(BaseModel):
    to: str = Field(max_length=255)


def _view(db: DbSession) -> SettingsOut:
    values = settings_service.get_all(db)
    return SettingsOut(
        public_url=values["public_url"],
        password_login=values["password_login"],
        two_factor_required=bool(values["two_factor_required"]),
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
        calendar_feed_allowed=bool(values["calendar_feed_allowed"]),
        link_titles_allowed=bool(values["link_titles_allowed"]),
        plugin_upload_allowed=bool(values["plugin_upload_allowed"]),
        ai_allowed=bool(values["ai_allowed"]),
        custom_css_allowed=bool(values["custom_css_allowed"]),
    )


@router.get("", response_model=SettingsOut)
def read(_operator: OperatorAccount, db: DbSession) -> SettingsOut:
    return _view(db)


@router.put("", response_model=SettingsOut)
def save(payload: SettingsIn, operator: OperatorAccount, db: DbSession) -> SettingsOut:
    changes: dict[str, Any] = {}
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is None:
            continue
        if key == "public_url":
            try:
                value = settings_service.normalize_public_url(value)
            except ValueError as exc:
                raise error("invalid_url", "Give an address like https://notes.example.com.", 422) from exc
        elif key == "smtp_from":
            value = value.strip()
            if value and not accounts.EMAIL_PATTERN.match(value):
                raise error("invalid_email", "This is not a mail address.", 422)
        elif key == "two_factor_required" and value and operator.sign_in == SIGN_IN_PASSWORD and not (
            operator.totp_secret_enc
        ):
            # Else the operator would be the first one sent to the account page, with nothing else in reach.
            raise error("own_second_factor_first", "Set up your own second factor first.", 409)
        elif key == "password_login" and not value:
            current = settings_service.get_all(db)
            if not (current["oidc_issuer"] and current["oidc_client_id"]):
                # Without a provider nobody but the operator could sign in any more, and invitations would fail.
                raise error("provider_first", "Set up a sign-in provider first.", 409)
        elif key == "smtp_password":
            changes["smtp_password_enc"] = encrypt_secret(value)
            continue
        elif isinstance(value, str):
            value = value.strip()
        changes[key] = value
    settings_service.save(db, changes)
    logger.info("Settings changed keys=%s by=%s", ",".join(sorted(changes)), operator.name)
    return _view(db)


@router.post("/mail-test", status_code=204, summary="Send a test mail through the configured server")
def mail_test(payload: TestMailIn, _operator: OperatorAccount, db: DbSession) -> None:
    to = payload.to.strip()
    if not accounts.EMAIL_PATTERN.match(to):
        raise error("invalid_email", "This is not a mail address.", 422)
    try:
        mailer.send_test(db, to)
    except mailer.MailError as exc:
        raise error(exc.code, str(exc), 502) from exc


class GuideIn(BaseModel):
    #: "de" or "en"; empty: the operator's own language.
    language: str = Field(default="", max_length=16)


@router.post("/guide", status_code=201, summary="Make the space with the guide again, next to what is there")
def make_guide(payload: GuideIn, operator: OperatorAccount) -> dict[str, str]:
    name = guide.create(operator.id, payload.language or operator.language or "en")
    logger.info("Guide made again space=%s by=%s", name, operator.name)
    return {"space": name}
