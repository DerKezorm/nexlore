"""The iPhone app: what stays nexlore's own beside the module ``geraete`` (``app/vendor/nexgeraete``, since 1.17.0).

The module pairs and knows the devices (QR code, code to type, the sign-in page ``/app-connect``, another own device
over iCloud), lists, renames and disconnects them and sends their notifications; the store over nexlore's tables is
``services/geraete_config.py``. Left here: the limits nexlore set in 1.16.0 (the module takes them), the operator's
switch, the device's rate on ``/api/app/1`` and the ``Caller`` the app's own device routes work with.

**A device has the rights of a browser session** of its account, read, write or manage per space, unlike an API
token. **The key**: ``nxd_`` and 43 random characters, handed out once; only its SHA-256 is stored. It opens
``/api/app/1`` and nothing else. A device goes when its owner disconnects it, signs out everywhere, sets a new password
or after 365 days unused; while its account is blocked or deleted with its 30 days it rests (G26) and works again
when the account is back.

**The operator's switch is on from the start** (``app_pairing_allowed``), unlike API tokens: the app can do nothing
the browser cannot. Off, it shuts ``/api/app/1`` at once and lets no new device in; the devices stay paired.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy.orm import Session

from ..models import Account
from . import settings_service

KEY_PREFIX = "nxd_"
SWITCH = "app_pairing_allowed"
MINUTES = 10
OPEN_AT_MOST = 5
NAME_CHARS = 80
#: Requests one device may make per minute.
PER_MINUTE = 600
#: Devices one account may bring in through a device it has, per hour (the module counts them in the database).
SIBLINGS_PER_HOUR = 5
#: Used and run-out pairings and codes are kept this long, then cleared.
KEEP_USED = timedelta(days=1)


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, SWITCH))


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def make_device(db: Session, account: Account, name: str) -> tuple[str, object]:
    """A device paired the way the module pairs one (for the tests of the account module and the old pages):
    its key and its row."""
    from ..models import AppDevice
    from ..vendor import nexgeraete
    from .geraete_config import CONFIG, GeraeteStore

    store = GeraeteStore(db)
    holder = store.holder(account.id)
    if holder is None:
        raise ValueError("no such account")
    device, key = nexgeraete.devices.add(store, CONFIG, holder, name=name, kind="ios", via=nexgeraete.VIA_QR)
    store.commit()
    return key, db.get(AppDevice, device.id)


@dataclass
class Caller:
    """Who calls ``/api/app/1``: the account, detached, and its device."""

    account: Account
    device_id: int
    device_name: str

    @property
    def client(self) -> str:
        """The device as a session: versions of its saves fold together, and it holds no lock of a browser tab."""
        return f"app-{self.device_id}"


_calls_lock = threading.Lock()
_calls: dict[object, deque[float]] = defaultdict(deque)


def brake(device_id: object, now: float | None = None) -> bool:
    """True while the device stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        seen = _calls[device_id]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _calls_lock:
        _calls.clear()
