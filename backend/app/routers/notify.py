"""The own notifications (block Z2): which occasions, the webhook, mail; and a test that goes out at once."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..errors import error
from ..models import OPERATOR
from ..models import Account as AccountRow
from ..services import mailer, notify

router = APIRouter(prefix="/api/me/notify", tags=["notify"])


def _view(db: Any, account: AccountRow) -> dict[str, Any]:
    hook = notify.webhook_of(account)
    return {
        "choices": notify.choices(account),
        # The address itself goes out never again: it may carry a token. Only where it points.
        "webhook": {"set": bool(hook), "host": urlsplit(hook).hostname or "" if hook else ""},
        "email": {"possible": mailer.configured(db) and bool(account.email), "server": mailer.configured(db),
                  "address": account.email or ""},
        "operator": account.role == OPERATOR,
    }


@router.get("", summary="The own notifications")
def read(account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    return _view(db, row)


class NotifyIn(BaseModel):
    choices: dict[str, Any] | None = Field(default=None, max_length=20)
    #: A new address; empty removes it; left out keeps it.
    webhook: str | None = Field(default=None, max_length=2048)


@router.put("", summary="Choose occasions and ways")
def save(body: NotifyIn, account: Account, db: DbSession) -> dict[str, Any]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    try:
        if body.choices is not None:
            current = notify.choices(row)
            current.update(notify.check_choices(body.choices))
            row.notify = current
        if body.webhook is not None:
            notify.set_webhook(row, body.webhook)
            if row.notify is None:
                row.notify = notify.choices(row)
    except notify.NotifyError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
    db.commit()
    return _view(db, row)


@router.post("/test", summary="Send a test through every way the account has, now")
def test(account: Account, db: DbSession) -> dict[str, str]:
    row = db.get(AccountRow, account.id)
    assert row is not None
    mine = notify.choices(row)
    if not row.notify_webhook_enc and not (mine["email"] and row.email and mailer.configured(db)):
        raise error("notify_no_way", "Give a webhook address or switch mail on first.", 409)
    return notify.deliver(row.id, "test", "nexlore test", "Notifications from nexlore reach you here.", "/account")
