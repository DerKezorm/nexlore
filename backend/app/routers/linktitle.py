"""The title of a web page for an address pasted into a note (``services/linktitle``): only while the operator
allows it, at most ``PER_MINUTE`` asks per account."""

from __future__ import annotations

import threading
import time
from typing import Annotated, Any

from fastapi import APIRouter, Query

from ..db import SessionLocal
from ..deps import Account
from ..errors import error
from ..services import linktitle, settings_service

router = APIRouter(prefix="/api", tags=["link titles"])

PER_MINUTE = 30
_lock = threading.Lock()
_asked: dict[int, list[float]] = {}


def _allowed(account_id: int) -> bool:
    now = time.monotonic()
    with _lock:
        recent = [at for at in _asked.get(account_id, []) if now - at < 60]
        if len(recent) >= PER_MINUTE:
            _asked[account_id] = recent
            return False
        recent.append(now)
        _asked[account_id] = recent
        return True


def forget() -> None:
    """For the tests: nobody asked yet."""
    with _lock:
        _asked.clear()


@router.get("/link-title", summary="The title of a web page, for a link pasted into a note")
def title(url: Annotated[str, Query(min_length=1, max_length=linktitle.MAX_URL)], account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        if not settings_service.get(db, "link_titles_allowed"):
            raise error("link_titles_off", "Titles of pasted links are not switched on.", 404)
    if not _allowed(account.id):
        raise error("slow_down", "Too many links at once. Try again in a minute.", 429)
    try:
        return {"title": linktitle.fetch(url)}
    except linktitle.TitleError as exc:
        raise error(f"link_{exc.code}", "No title for this address.", 422) from exc
