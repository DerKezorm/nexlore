"""Server › Mail (plan "Einstellungen", post 1.1.0): the routes of the shared post module under
``/api/server/mail`` (the mail server, the test mail in the page's language, what waits). The old ways stay
(``GET/PUT /api/settings`` with ``smtp_*``, ``POST /api/settings/mail-test``) over the same settings."""

from __future__ import annotations

from collections.abc import Iterator

from ..db import SessionLocal
from ..deps import require_operator
from ..errors import error
from ..services.post_store import PostStore
from ..vendor.nexpost import api


def _store() -> Iterator[PostStore]:
    with SessionLocal() as db:
        yield PostStore(db)


router = api.router(operator=require_operator, store=_store, error=error, tags=["mail"])
