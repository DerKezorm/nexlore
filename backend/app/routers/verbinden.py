"""Connecting nexlore with the other nex apps (module verbinden 0.1.3, plan "Entwurf Apps verbinden"): the module's
fixed places, ``/.well-known/nex-app``, ``/api/connect/…`` (the account's card, the consent, the return, the
operator's switch and addresses, and the token, revoke and retire routes between the apps), over nexlore's tables
(``services/verbinden_store.py``). nexlore is only the host: nexnotes puts notes into it (``notes.add``, opened at
``/api/v1``, ``routers/v1.caller``).
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from ..db import SessionLocal
from ..deps import DbSession, require_account, require_operator
from ..errors import detail
from ..services import settings_service
from ..services.verbinden_store import CONFIG, VerbindenStore
from ..vendor.nexverbinden import Refused
from ..vendor.nexverbinden import api as verbinden_api


def store(db: DbSession) -> VerbindenStore:
    return VerbindenStore(db)


def _address(request: Request) -> str:
    """Where the other apps and the browser reach nexlore: the public address, else the one of this request."""
    with SessionLocal() as db:
        return settings_service.public_url(db) or str(request.base_url).rstrip("/")


def _error(refusal: Refused) -> Exception:
    values = {name: value for name, value in refusal.as_dict().items() if name not in ("code", "message")}
    return HTTPException(status_code=refusal.status, detail=detail(refusal.code, refusal.message, **values))


router = verbinden_api.router(config=CONFIG, store=store, account=require_account, operator=require_operator,
                              address=_address, error=_error, tags=["connect"])
