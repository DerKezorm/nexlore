"""nexlore's paired devices through the module ``geraete`` (``app/vendor/nexgeraete``, since 1.17.0): the app's
``AppConfig`` and the ``Store`` over its own tables.

**The rows stay where 1.16.0 wrote them.** ``app_devices`` keeps every device (``key_hash`` = SHA-256 of the whole key,
prefix ``nxd_``); the module's columns (kind, model, system, app version, way, push) came beside them and stay ``NULL``
in rows of before. Pairings stay in ``app_pairings`` (``device_id`` beside ``device_name``), the one-time codes of the
sign-in page are new in ``app_codes``. Nothing is copied, no key hashed anew: every iPhone paired so far works on.

**The published iPhone app speaks the form ``tasks``** (secret in ``X-Pairing-Secret``, ``{key, account{id, name}}``,
``404 app_pairing_unknown``, ``401 not_signed_in``); a request with ``X-Nex-App`` hears the module's form ``nex``.

**One switch.** nexlore has only the operator's ``app_pairing_allowed`` (``schluessel`` calls it ``app``): closed, no
device gets in and no new one comes; there is no separate switch for new devices.

**Push.** nexlore sends no notifications of its own yet (``kinds=()``); only the module's ``security`` ("new device
connected") and, for operators, ``update`` reach apps that say they understand them. The published app understands
neither and gets nothing.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import OPERATOR, Account, AppCode, AppDevice, AppPairing
from ..security import account_out
from ..vendor import nexgeraete
from ..vendor.nexgeraete import (
    ConnectCode,
    Device,
    DeviceChange,
    Holder,
    NewDevice,
    NewPairing,
    Pairing,
    PushState,
)
from . import devices, settings_service, totp

logger = logging.getLogger("nexlore.app")

#: The relay of every nex app (``push.nexapps.dev``). nexlore has no setting of its own for it.
RELAY_URL = "https://push.nexapps.dev"


class Hooks:
    """What the module's routes post to the relay with and what time they see. In production the relay itself and the
    clock; the contract tests put their recorder here and move the clock on (``tests/nexgeraete_adapter.py``)."""

    send: Callable[[str, dict[str, Any]], int] | None = None
    offset: timedelta = timedelta(0)
    #: Who else hears of every new device before the mail (the contract tests).
    listeners: ClassVar[list[Callable[[Holder, Device], None]]] = []


def send(url: str, body: dict[str, Any]) -> int:
    return (Hooks.send or nexgeraete.push.post)(url, body)


def clock() -> datetime:
    return datetime.now(UTC) + Hooks.offset


class _Config(nexgeraete.AppConfig):
    """The limits the app's tests turn down (``devices.SIBLINGS_PER_HOUR``) are read when they are used."""

    @property  # type: ignore[override]
    def siblings_per_hour(self) -> int:
        return devices.SIBLINGS_PER_HOUR

    @siblings_per_hour.setter
    def siblings_per_hour(self, _value: int) -> None:
        """The dataclass sets the field once; the property answers instead."""


CONFIG = _Config(
    app="nexlore",
    scheme="nexlore",
    token_prefix=devices.KEY_PREFIX,
    form=nexgeraete.FORM_TASKS,
    code_length=8,
    pairing_minutes=devices.MINUTES,
    open_pairings=devices.OPEN_AT_MOST,
    name_max=devices.NAME_CHARS,
    relay_url=RELAY_URL,
    push_info="nexlore-push-v1",
    kinds=(),
    legacy_kinds=(),
    switches=(nexgeraete.SWITCH_APP,),
)


def _kinds(raw: Any) -> dict[str, bool]:
    return {str(key): bool(value) for key, value in raw.items()} if isinstance(raw, dict) else {}


def _device(row: AppDevice) -> Device:
    push = None
    if row.push_ticket and row.push_key:
        understands = tuple(row.push_understands) if isinstance(row.push_understands, list) else None
        push = PushState(row.push_ticket, row.push_key, understands)
    return Device(
        id=row.id,
        account_id=row.account_id,
        name=row.name,
        kind=row.kind or "ios",
        model=row.model,
        system=row.system,
        app_version=row.app_version,
        via=row.via,
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        push=push,
        kinds=_kinds(row.push_kinds),
    )


def describe(row: AppDevice) -> str:
    """The device in one line for the account module's lists: "Anna's iPhone (iPhone 16 Pro)"."""
    return nexgeraete.describe(_device(row))


def _pairing(row: AppPairing | None) -> Pairing | None:
    if row is None:
        return None
    return Pairing(id=row.id, account_id=row.account_id, secret_hash=row.secret_hash, code_hash=row.code_hash,
                   created_at=row.created_at, expires_at=row.expires_at, used_at=row.used_at, device_id=row.device_id)


class GeraeteStore:
    """The module's ``Store`` over ``app_devices``, ``app_pairings``, ``app_codes`` and the settings. One session,
    one transaction per request."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- Devices ------------------------------------------------------------------------------------------------

    def _row(self, device_id: Any) -> AppDevice | None:
        return self.db.get(AppDevice, int(device_id)) if str(device_id).isdigit() else None

    def devices_of(self, account_id: Any) -> list[Device]:
        rows = self.db.scalars(select(AppDevice).where(AppDevice.account_id == int(account_id))
                               .order_by(AppDevice.created_at.desc(), AppDevice.id.desc()))
        return [_device(row) for row in rows]

    def device(self, device_id: Any) -> Device | None:
        row = self._row(device_id)
        return _device(row) if row is not None else None

    def device_by_hash(self, token_hash: str) -> Device | None:
        row = self.db.scalar(select(AppDevice).where(AppDevice.key_hash == token_hash))
        return _device(row) if row is not None else None

    def add_device(self, new: NewDevice) -> Device:
        row = AppDevice(account_id=int(new.account_id), name=new.name[: devices.NAME_CHARS], key_hash=new.token_hash,
                        created_at=new.created_at, kind=new.kind, model=new.model, system=new.system,
                        app_version=new.app_version, via=new.via,
                        via_device_id=int(new.via_device) if new.via_device is not None else None)
        self.db.add(row)
        self.db.flush()
        return _device(row)

    def change_device(self, device_id: Any, change: DeviceChange) -> Device:
        row = self._row(device_id)
        if row is None:
            raise nexgeraete.DeviceRefused("not_found")
        for name in ("name", "model", "system", "app_version"):
            value = getattr(change, name)
            if value is not None:
                setattr(row, name, value)
        self.db.flush()
        return _device(row)

    def remove_device(self, device_id: Any) -> None:
        """Its bases and the answers of its operations go with it (``ON DELETE CASCADE``)."""
        self.db.execute(delete(AppDevice).where(AppDevice.id == int(device_id)))
        self.db.flush()

    def touch(self, device_id: Any, when: datetime) -> None:
        self.db.execute(update(AppDevice).where(AppDevice.id == int(device_id)).values(last_seen_at=when))

    def idle_devices(self, before: datetime) -> list[Device]:
        rows = self.db.scalars(select(AppDevice).where(
            ((AppDevice.last_seen_at.is_not(None)) & (AppDevice.last_seen_at < before))
            | ((AppDevice.last_seen_at.is_(None)) & (AppDevice.created_at < before))
        ))
        return [_device(row) for row in rows]

    def set_push(self, device_id: Any, state: PushState | None) -> None:
        row = self._row(device_id)
        if row is None:
            return
        row.push_ticket = state.ticket if state else None
        row.push_key = state.key if state else None
        row.push_understands = list(state.understands) if state and state.understands is not None else None
        self.db.flush()

    def set_kinds(self, device_id: Any, kinds: dict[str, bool]) -> None:
        row = self._row(device_id)
        if row is not None:
            row.push_kinds = dict(kinds)
            self.db.flush()

    # --- Accounts -----------------------------------------------------------------------------------------------

    def holder(self, account_id: Any) -> Holder | None:
        """``None`` only when the account is gone for good; blocked or deleted with its 30 days it is ``out``."""
        if not str(account_id).isdigit():
            return None
        row = self.db.get(Account, int(account_id))
        if row is None:
            return None
        language = row.language or row.browser_language or "en"
        return Holder(
            id=row.id,
            name=row.display_name or row.name,
            login=row.name,
            email=row.email or "",
            avatar="",
            operator=row.role == OPERATOR,
            out=account_out(row),
            language=language[:2].lower(),
            factor_owed=totp.setup_required(self.db, row),
        )

    def operators(self) -> list[Any]:
        return list(self.db.scalars(select(Account.id).where(
            Account.role == OPERATOR, Account.blocked_at.is_(None), Account.deleted_at.is_(None))))

    # --- Pairings and one-time codes ----------------------------------------------------------------------------

    def add_pairing(self, new: NewPairing) -> Pairing:
        row = AppPairing(id=new.id, account_id=int(new.account_id), secret_hash=new.secret_hash,
                         code_hash=new.code_hash, created_at=new.created_at, expires_at=new.expires_at)
        self.db.add(row)
        self.db.flush()
        return _pairing(row)  # type: ignore[return-value]

    def pairing(self, pairing_id: str) -> Pairing | None:
        return _pairing(self.db.get(AppPairing, pairing_id[:32]))

    def pairing_by_code(self, code_hash: str) -> Pairing | None:
        return _pairing(self.db.scalars(select(AppPairing).where(AppPairing.code_hash == code_hash)
                                        .order_by(AppPairing.created_at.desc())).first())

    def open_pairings(self, account_id: Any, now: datetime) -> list[Pairing]:
        rows = self.db.scalars(select(AppPairing).where(
            AppPairing.account_id == int(account_id), AppPairing.used_at.is_(None), AppPairing.expires_at > now))
        return [found for row in rows if (found := _pairing(row)) is not None]

    def use_pairing(self, pairing_id: str, device_id: Any, when: datetime) -> bool:
        """One conditional UPDATE: of two pickups at the same moment exactly one hits. ``device_name`` as 1.16.0
        wrote it, for the page of before."""
        name = ""
        if device_id is not None:
            row = self._row(device_id)
            name = row.name if row is not None else ""
        hit = self.db.execute(
            update(AppPairing)
            .where(AppPairing.id == pairing_id, AppPairing.used_at.is_(None), AppPairing.expires_at > when)
            .values(used_at=when, device_id=int(device_id) if device_id is not None else None, device_name=name)
        ).rowcount
        return bool(hit)

    def remove_pairing(self, pairing_id: str) -> None:
        self.db.execute(delete(AppPairing).where(AppPairing.id == pairing_id))

    def add_connect_code(self, new: ConnectCode) -> None:
        # Old pairings and codes go once a day has passed; nobody can use them any more.
        self.db.execute(delete(AppCode).where(AppCode.expires_at < new.created_at - devices.KEEP_USED))
        self.db.execute(delete(AppPairing).where(AppPairing.expires_at < new.created_at - devices.KEEP_USED))
        self.db.add(AppCode(code_hash=new.code_hash, account_id=int(new.account_id), state=new.state,
                            challenge=new.challenge, created_at=new.created_at, expires_at=new.expires_at))
        self.db.flush()

    def take_connect_code(self, code_hash: str, when: datetime) -> ConnectCode | None:
        hit = self.db.execute(
            update(AppCode)
            .where(AppCode.code_hash == code_hash, AppCode.used_at.is_(None), AppCode.expires_at > when)
            .values(used_at=when)
        ).rowcount
        if not hit:
            return None
        row = self.db.get(AppCode, code_hash)
        if row is None:
            return None
        return ConnectCode(code_hash=row.code_hash, account_id=row.account_id, state=row.state,
                           challenge=row.challenge, created_at=row.created_at, expires_at=row.expires_at)

    # --- Switches and the transaction ---------------------------------------------------------------------------

    def switch(self, name: str) -> bool:
        """``app`` and ``pairing`` are both nexlore's ``app_pairing_allowed`` (on from the start)."""
        return bool(settings_service.get(self.db, devices.SWITCH))

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


def store() -> Iterator[GeraeteStore]:
    """The dependency of the module's routes: one session per request."""
    with SessionLocal() as db:
        yield GeraeteStore(db)


def sweep() -> int:
    """The daily run (G27): devices unused for 365 days are disconnected."""
    with SessionLocal() as db:
        gone = nexgeraete.devices.sweep(GeraeteStore(db), CONFIG, clock())
    if gone:
        logger.info("Devices unused for a year disconnected count=%s", gone)
    return gone


def update_wanted() -> bool:
    """``updates.devices_want`` (G56, U24): whether a device of an operator understands and wants "a new version is
    out". Such a device counts as a bell: only then, and only with the update check allowed, does the background look
    at most once a day."""
    with SessionLocal() as db:
        return nexgeraete.notices.update_wanted(GeraeteStore(db), CONFIG)


def newer(version: str, current: str, url: str) -> None:
    """``updates.on_devices``: operators whose app understands it hear "nexlore <version> is out" on their devices,
    once per version (G56). The published app understands it not and hears nothing."""
    with SessionLocal() as db:
        nexgeraete.notices.newer(GeraeteStore(db), CONFIG, version, current, url, send=send)
