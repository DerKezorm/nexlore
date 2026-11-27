"""The devices in the browser: the module ``geraete`` under ``/api/devices`` (since 1.17.0), and the ways of 1.16.0 as
shells over it.

**The module's routes** (``browser_router``, prefix ``/api/devices``): ``/app-pairing`` (QR code and code),
``/app-connect`` (the sign-in page of the app), ``/app-devices`` (list, rename, disconnect, disconnect all, the kinds of
notification per device) and, for the operator, ``/server/accounts/{id}/devices``. The cards of the module call them
(``frontend/src/vendor/nexgeraete``, ``base="/api/devices"``). Sessions only: a device's key hears ``403 browser_only``.

**The ways of 1.16.0** stay with their answers (``/api/app-pairing``, ``/api/app-pairing/{id}``, ``/api/app-devices``,
``/api/app-devices/{id}``), now on the module's functions: a page still open from before the update keeps working, and
the QR code they make holds the link of 1.16.0 (``nexlore://connect?address=…``). ``GET/PUT /api/app-pairing/allowed``
stays nexlore's own (the operator's switch, the same setting as Server › Verbindungen › Schnittstellen).
"""

from __future__ import annotations

import io
import logging
from datetime import datetime
from typing import Annotated
from urllib.parse import quote, urlsplit

import segno
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, DbSession, OperatorAccount, require_account, require_operator
from ..errors import error
from ..models import AppPairing
from ..services import devices, settings_service
from ..services.geraete_config import CONFIG, GeraeteStore, clock, send, store
from ..vendor import nexgeraete
from ..vendor.nexgeraete import DeviceRefused
from ..vendor.nexgeraete import api as geraete_api

logger = logging.getLogger("nexlore.app")

router = APIRouter(prefix="/api", tags=["app"])

#: The link of 1.16.0: the published app reads ``address``, ``pairing`` and ``secret``.
APP_LINK = "nexlore://connect"
#: Where the module's browser routes are mounted (the cards get it as ``base``).
DEVICES_PREFIX = "/api/devices"

PairingId = Annotated[str, Path(min_length=1, max_length=32)]
Data = Annotated[GeraeteStore, Depends(store)]


def _old(refused: DeviceRefused) -> HTTPException:
    """A refusal in the words of 1.16.0: an unknown pairing is ``app_pairing_unknown``, the rest as the published
    app's form names it."""
    if refused.code in ("not_found", "pairing_gone"):
        return error("app_pairing_unknown", "No such pairing.", 404)
    status, body, headers = nexgeraete.forms.refusal(nexgeraete.FORM_TASKS, refused)
    return HTTPException(status_code=status, detail=body["detail"], headers=headers)


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


def _public(db: DbSession) -> str:
    return settings_service.public_url(db)


def _address(db: DbSession, from_browser: str) -> str:
    """The public address from the settings wins: whoever opens nexlore at home by its IP address still wants the app
    to know the one that works on the way."""
    for candidate in (_public(db), from_browser.strip().rstrip("/")):
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
def pair(account: Account, db: DbSession, data: Data, body: PairingIn | None = None) -> PairingOut:
    # The address first: without it the code would lead nowhere.
    address = _address(db, body.address if body else "")
    try:
        started = nexgeraete.pairing.start(data, CONFIG, account.id, address=address, now=clock())
    except DeviceRefused as refused:
        data.rollback()
        raise _old(refused) from None
    link = (f"{APP_LINK}?address={quote(address, safe='')}&pairing={quote(started.pairing.id, safe='')}"
            f"&secret={quote(started.secret, safe='')}")
    logger.info("Pairing made for the iPhone app")
    return PairingOut(id=started.pairing.id, code=started.code, expires_at=started.pairing.expires_at,
                      address=address, link=link, qr_svg=_qr_svg(link))


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
def pairing_state(pairing_id: PairingId, account: Account, data: Data) -> PairingState:
    try:
        state, found = nexgeraete.pairing.state(data, CONFIG, account.id, pairing_id, clock())
    except DeviceRefused as refused:
        raise _old(refused) from None
    if state != "used":
        return PairingState(state=state, device="")
    row = data.db.get(AppPairing, pairing_id)
    return PairingState(state="connected", device=found.name if found is not None else (row.device_name if row else ""))


@router.delete("/app-pairing/{pairing_id}", status_code=204, summary="Withdraw a pairing")
def withdraw(pairing_id: PairingId, account: Account, data: Data) -> None:
    try:
        nexgeraete.pairing.withdraw(data, CONFIG, account.id, pairing_id)
    except DeviceRefused as refused:
        data.rollback()
        raise _old(refused) from None


@router.get("/app-devices", response_model=list[DeviceOut], summary="The own paired iPhones")
def own_devices(account: Account, data: Data) -> list[DeviceOut]:
    found = sorted(data.devices_of(account.id), key=lambda device: int(device.id))
    return [DeviceOut(id=int(device.id), name=device.name, created_at=device.created_at,  # type: ignore[arg-type]
                      last_seen_at=device.last_seen_at) for device in found]


@router.delete("/app-devices/{device_id}", status_code=204, summary="Disconnect a paired iPhone")
def disconnect(device_id: int, account: Account, data: Data) -> None:
    try:
        nexgeraete.devices.disconnect(data, CONFIG, account.id, device_id)
    except DeviceRefused:
        data.rollback()
        raise error("not_found", "Not found.", 404) from None


def _known_address(_request: Request) -> str:
    """The public address of the settings (empty: the browser's counts)."""
    with SessionLocal() as db:
        return settings_service.public_url(db)


#: The module's browser routes (see the docstring), mounted by ``main.py``.
module_router = geraete_api.browser_router(
    config=CONFIG,
    store=store,
    account=require_account,
    operator=require_operator,
    address=_known_address,
    send=send,
    clock=clock,
    prefix=DEVICES_PREFIX,
    tags=["app"],
)
