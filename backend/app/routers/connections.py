"""The routes of the shared key module (schluessel 1.0.0) under ``/api/connections``: the account's API keys and AI
tools (My account › Connections), the operator's overview with locking and unlocking, the switches of "Schnittstellen"
(Server › General). Only with a browser session (``require_account`` reads the session cookie): a key never manages
keys. The old ways (``/api/api-tokens``, ``/api/mcp/keys``, ``/api/admin/api-tokens``) stay as they were."""

from __future__ import annotations

from fastapi import Request

from ..db import SessionLocal
from ..deps import require_account, require_operator
from ..services import settings_service
from ..services.schluessel_store import CONFIG, store
from ..vendor.nexschluessel import api


def _address(request: Request) -> str:
    """The public address programs use: the operator's setting, else the one this page was opened under."""
    with SessionLocal() as db:
        found = settings_service.public_url(db)
    return found or str(request.base_url).rstrip("/")


router = api.router(config=CONFIG, store=store, account=require_account, operator=require_operator, address=_address)
