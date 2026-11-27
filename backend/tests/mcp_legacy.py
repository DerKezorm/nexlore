"""How nexlore 1.16.0 gave a connector its tokens (``routers/oauth.py`` ``_issue`` before the shared module mcp 1.1.0),
for the tests of connectors made before the update: the access token ``nxl_`` for an hour, the refresh token ``nxr_``,
the one before kept in ``refresh_old_hash``."""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from app.models import McpKey, utcnow
from app.services import mcp


def issue(db: Any, key: McpKey) -> dict[str, Any]:
    access = mcp.TOKEN_PREFIX + secrets.token_urlsafe(32)
    refresh = "nxr_" + secrets.token_urlsafe(32)
    key.token_hash = mcp.digest(access)
    key.prefix = access[: len(mcp.TOKEN_PREFIX) + 4]
    key.refresh_old_hash = key.refresh_hash
    key.refresh_hash = mcp.digest(refresh)
    key.expires_at = utcnow() + timedelta(hours=1)
    db.commit()
    return {"access_token": access, "token_type": "Bearer", "expires_in": 3600, "refresh_token": refresh,
            "scope": "mcp"}
