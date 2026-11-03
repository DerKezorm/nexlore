"""Pairing the iPhone app in the browser: the QR code and short code, the paired devices, the operator's latch.

Only with a session, and under no promise (the promise is ``/api/app/1``, ``routers/app1.py``). The rules are in
``services/devices.py``.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Annotated
from urllib.parse import quote, urlsplit

import segno
from fastapi import APIRouter, Path
from pydantic import BaseModel, Field

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..services import devices, settings_service
from ..services.devices import PairingError

logger = logging.getLogger("nexlore.app")

router = APIRouter(prefix="/api", tags=["app"])

#: The scheme the app listens to: the iPhone's camera opens the QR code's link right in nexlore.
APP_LINK = "nexlore://connect"

PairingId = Annotated[str, Path(min_length=1, max_length=32)]


def _fail(exc: PairingError) -> Exception:
    return error(exc.code, exc.text, exc.status, **exc.values)


class PairingIn(BaseModel):
    #: Where the browser sees nexlore now. Counts only when the operator has set no public address; that one wins.
    address: str = Field(default="", max_length=600)


class PairingOut(BaseModel):
    id: str
    #: ``ABCD-EFGH``. Only in this answer: the page shows it and forgets it.
    code: str
    expires_at: datetime
    #: The address the app keeps; typed in beside the short code.
    address: str
    link: str
    qr_svg: str


class PairingState(BaseModel):
    #: ``waiting``, ``connected`` or ``expired``.
    state: str
    device: str = ""


class Latch(BaseModel):
    allowed: bool


class DeviceOut(BaseModel):
    id: int
    name: str
    created_at: datetime
    last_seen_at: datetime | None = None


def _address(db: DbSession, from_browser: str) -> str:
    """The public address from the settings wins: whoever opens nexlore at home by its IP address still wants the app
    to know the one that works on the way."""
    for candidate in (settings_service.public_url(db), from_browser.strip().rstrip("/")):
        parts = urlsplit(candidate)
        if parts.scheme in ("http", "https") and parts.netloc:
            return candidate
    raise error("app_address_missing", "nexlore does not know its address. The operator sets it.", 422)


def _qr_svg(link: str) -> str:
    """Dark on white with a quiet zone, readable on a dark page too. ``omitsize``: with fixed sizes segno writes no
    ``viewBox``, and an image set to 200 px cuts the code off instead of scaling it."""
    out = io.BytesIO()
    segno.make(link, error="m").save(out, kind="svg", scale=4, dark="#111827", light="#ffffff", border=4,
                                     xmldecl=False, svgns=True, omitsize=True)
    return out.getvalue().decode("utf-8")


@router.post("/app-pairing", response_model=PairingOut, status_code=201, summary="A pairing for the iPhone app")
def pair(account: Account, db: DbSession, body: PairingIn | None = None) -> PairingOut:
    # The address first: without it the code would lead nowhere.
    address = _address(db, body.address if body else "")
    try:
        made = devices.prepare(db, account)
    except PairingError as exc:
        raise _fail(exc) from exc
    link = (f"{APP_LINK}?address={quote(address, safe='')}&pairing={quote(made.id, safe='')}"
            f"&secret={quote(made.secret, safe='')}")
    logger.info("Pairing made for the iPhone app")
    return PairingOut(id=made.id, code=made.code, expires_at=made.expires_at, address=address, link=link,
                      qr_svg=_qr_svg(link))


@router.get("/app-pairing/allowed", response_model=Latch, summary="Whether the iPhone app may be paired")
def latch(_account: Account, db: DbSession) -> Latch:
    return Latch(allowed=devices.allowed(db))


@router.put("/app-pairing/allowed", response_model=Latch, summary="Operator: open or close the iPhone app")
def set_latch(body: Latch, operator: OperatorAccount, db: DbSession) -> Latch:
    """Closing shuts ``/api/app/1`` at once; the devices stay paired, as API tokens stay when those are closed."""
    settings_service.save(db, {devices.SWITCH: body.allowed})
    logger.info("The iPhone app %s by=%s", "allowed" if body.allowed else "closed", operator.name)
    return Latch(allowed=devices.allowed(db))


@router.get("/app-pairing/{pairing_id}", response_model=PairingState, summary="Whether the app picked the key up")
def pairing_state(pairing_id: PairingId, account: Account, db: DbSession) -> PairingState:
    try:
        state, device = devices.state(db, pairing_id, account)
    except PairingError as exc:
        raise _fail(exc) from exc
    return PairingState(state=state, device=device)


@router.delete("/app-pairing/{pairing_id}", status_code=204, summary="Withdraw a pairing")
def withdraw(pairing_id: PairingId, account: Account, db: DbSession) -> None:
    try:
        devices.withdraw(db, pairing_id, account)
    except PairingError as exc:
        raise _fail(exc) from exc


@router.get("/app-devices", response_model=list[DeviceOut], summary="The own paired iPhones")
def own_devices(account: Account, db: DbSession) -> list[DeviceOut]:
    return [DeviceOut(id=row.id, name=row.name, created_at=row.created_at, last_seen_at=row.last_seen_at)
            for row in devices.of_account(db, account.id)]


@router.delete("/app-devices/{device_id}", status_code=204, summary="Disconnect a paired iPhone")
def disconnect(device_id: int, account: Account, db: DbSession) -> None:
    if not devices.disconnect(db, account.id, device_id):
        raise error("not_found", "Not found.", 404)
