"""Storage and backups over HTTP, operator only: the routes of the shared module ``sicherung``.

- ``/api/server/storage``: the module's own ways (the card "Speicher", the schedule with its time, the list, check,
  download, restore, delete, upload; the settings page uses these);
- ``/api/backups``: the ways nexlore had before the module, in their old shapes and with the old password header
  ``x-nexlore-password`` (the list as an array of flat entries, the check flat with ``usable``), so scripts and older
  pages keep working.

Download, restore, delete and upload ask for the operator's password again (``confirm_operator``: an account from a
provider confirms with a fresh sign-in there; wrong tries count like a sign-in).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ..db import SessionLocal
from ..deps import OperatorAccount, confirm_operator
from ..errors import error
from ..services import backups  # noqa: F401  (configures the module before its routes are used)
from ..vendor.nexsicherung import routes


def _confirm(request: Request, account: Any, password: str) -> None:
    with SessionLocal() as db:
        confirm_operator(request, db, account, password)


def _error(code: str, text: str, status: int) -> Exception:
    return error(code, text, status)


router = APIRouter()
# The description of the interface keeps the names nexlore's own backup routes had (E53): the schemas of their bodies
# in both routers, and the operationIds and summaries of the old routes.
router.include_router(routes.router(operator=OperatorAccount, confirm=_confirm, error=_error,
                                    prefix="/api/server/storage", schema_names=routes.FORMER_SCHEMAS))
router.include_router(routes.legacy_router(prefix="/api/backups", password_header="x-nexlore-password",
                                           operator=OperatorAccount, confirm=_confirm, error=_error,
                                           **routes.former_names("/api/backups")))
