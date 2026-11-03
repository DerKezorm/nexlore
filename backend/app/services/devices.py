"""The iPhone app: pairing a device and knowing it again (``/api/app/1``, ``routers/app1.py``).

**A device has the rights of a browser session** of its account, read, write or manage per space, unlike an API
token. So a pairing lives ten minutes and pairs one device, and every failed pickup counts at the sign-in brake.

**Three ways in, one result.** The QR code carries the pairing's id and secret (256 bits nobody guesses). The short
code ``ABCD-EFGH`` is for typing and has 40 bits: enough only together with the brake and the ten minutes. The sign-in
page ``/app-connect`` makes a pairing like the profile does and hands its link to the app at once. Unknown, wrong,
expired and used answer the same everywhere.

**The key.** ``nxd_`` and 43 random characters, handed out once. Only its SHA-256 is stored. It opens ``/api/app/1``
and nothing else. A device does not run out; it shows when it was last seen, and goes when its owner disconnects it,
signs out everywhere, or a password is set anew.

**The operator's latch is open from the start** (``app_pairing_allowed``), unlike API tokens: the app can do nothing
the browser cannot. Closing it shuts ``/api/app/1`` at once; the devices stay paired.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from ..models import Account, AppDevice, AppPairing, utcnow
from . import settings_service, totp

logger = logging.getLogger("nexlore.app")

KEY_PREFIX = "nxd_"
SWITCH = "app_pairing_allowed"
MINUTES = 10
OPEN_AT_MOST = 5
NAME_CHARS = 80
#: Without 0, O, 1 and I, which are mixed up when typed.
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
#: Requests one device may make per minute.
PER_MINUTE = 600
#: ``last_seen_at`` is written at most this often.
SEEN_EVERY = timedelta(minutes=1)


class PairingError(Exception):
    def __init__(self, code: str, text: str, status: int, **values: object) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status
        self.values = values


def unknown() -> PairingError:
    return PairingError("app_pairing_unknown", "No such pairing.", 404)


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, SWITCH))


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def clean_code(code: str) -> str:
    """Dashes, spaces and small letters are normal when typing."""
    return "".join(char for char in code.upper() if char.isalnum())


def device_name(raw: str) -> str:
    return "".join(char for char in raw if char.isprintable()).strip()[:NAME_CHARS] or "iPhone"


@dataclass
class Prepared:
    id: str
    secret: str
    #: ``ABCD-EFGH``.
    code: str
    expires_at: datetime


def prepare(db: Session, account: Account) -> Prepared:
    """A new pairing of the account. Secret and code exist in plain text only here."""
    if not allowed(db):
        raise PairingError("app_disabled", "The operator has switched the app off.", 403)
    now = utcnow()
    db.execute(delete(AppPairing).where(AppPairing.expires_at < now - timedelta(days=1)))
    waiting = db.scalar(select(func.count()).select_from(AppPairing).where(
        AppPairing.account_id == account.id, AppPairing.used_at.is_(None), AppPairing.expires_at > now,
    )) or 0
    if waiting >= OPEN_AT_MOST:
        raise PairingError("app_too_many_pairings", "At most 5 pairings may wait at once.", 409, max=OPEN_AT_MOST)
    secret = secrets.token_urlsafe(32)
    code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
    row = AppPairing(id=secrets.token_urlsafe(12), account_id=account.id, secret_hash=digest(secret),
                     code_hash=digest(code), created_at=now, expires_at=now + timedelta(minutes=MINUTES))
    db.add(row)
    db.commit()
    return Prepared(row.id, secret, f"{code[:4]}-{code[4:]}", row.expires_at)


def _own(db: Session, pairing_id: str, account: Account) -> AppPairing:
    row = db.get(AppPairing, pairing_id)
    if row is None or row.account_id != account.id:
        raise unknown()
    return row


def state(db: Session, pairing_id: str, account: Account) -> tuple[str, str]:
    """``waiting``, ``connected`` or ``expired``, and the device's name once connected."""
    row = _own(db, pairing_id, account)
    if row.used_at is not None:
        return "connected", row.device_name
    return ("expired" if row.expires_at <= utcnow() else "waiting"), ""


def withdraw(db: Session, pairing_id: str, account: Account) -> None:
    row = _own(db, pairing_id, account)
    if row.used_at is None:
        db.delete(row)
        db.commit()


def _redeem(db: Session, row: AppPairing, name: str) -> tuple[str, Account, AppDevice]:
    """A conditional UPDATE, not a look first: two pickups of one code at the same moment would otherwise both pass
    and make two devices. SQLite has one writer; of two UPDATEs exactly one hits."""
    name = device_name(name)
    now = utcnow()
    hit = db.execute(
        update(AppPairing)
        .where(AppPairing.id == row.id, AppPairing.used_at.is_(None), AppPairing.expires_at > now)
        .values(used_at=now, device_name=name)
    ).rowcount
    db.commit()
    account = db.get(Account, row.account_id)
    if not hit or account is None:
        raise unknown()
    key, device = make_device(db, account, name)
    return key, account, device


def by_secret(db: Session, pairing_id: str, secret: str | None, name: str) -> tuple[str, Account, AppDevice]:
    """The key for the id and secret of the QR code. Compared even without a row, so that an unknown id does not
    answer faster than a wrong secret."""
    row = db.get(AppPairing, pairing_id[:32])
    expected = row.secret_hash if row is not None else digest("")
    right = hmac.compare_digest(expected, digest(secret or ""))
    if row is None or not right or not secret:
        raise unknown()
    return _redeem(db, row, name)


def by_code(db: Session, code: str, name: str) -> tuple[str, Account, AppDevice]:
    clean = clean_code(code)
    if len(clean) != CODE_LENGTH:
        raise unknown()
    row = db.scalars(select(AppPairing).where(
        AppPairing.code_hash == digest(clean), AppPairing.used_at.is_(None), AppPairing.expires_at > utcnow(),
    )).first()
    if row is None:
        raise unknown()
    return _redeem(db, row, name)


# --- Devices --------------------------------------------------------------------------------------------------------


def make_device(db: Session, account: Account, name: str) -> tuple[str, AppDevice]:
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    row = AppDevice(account_id=account.id, name=device_name(name), key_hash=digest(key), created_at=utcnow())
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("Device paired device_id=%s", row.id)
    return key, row


def of_account(db: Session, account_id: int) -> list[AppDevice]:
    return list(db.scalars(select(AppDevice).where(AppDevice.account_id == account_id).order_by(AppDevice.id)))


def disconnect(db: Session, account_id: int, device_id: int) -> bool:
    gone = db.execute(delete(AppDevice).where(AppDevice.id == device_id, AppDevice.account_id == account_id)).rowcount
    db.commit()
    if gone:
        logger.info("Device disconnected device_id=%s", device_id)
    return bool(gone)


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


def authenticate(db: Session, key: str | None) -> Caller | None:
    """The device behind a key, or None: no such device (disconnected), or its account gone or waiting for the second
    factor the operator requires."""
    if not key or not key.startswith(KEY_PREFIX) or len(key) > 200:
        return None
    row = db.scalar(select(AppDevice).where(AppDevice.key_hash == digest(key)))
    if row is None:
        return None
    account = db.get(Account, row.account_id)
    if account is None or totp.setup_required(db, account):
        return None
    now = utcnow()
    if row.last_seen_at is None or now - row.last_seen_at >= SEEN_EVERY:
        row.last_seen_at = now
        db.commit()
    found = Caller(account=account, device_id=row.id, device_name=row.name)
    db.expunge(account)
    return found


_calls_lock = threading.Lock()
_calls: dict[int, deque[float]] = defaultdict(deque)


def brake(device_id: int, now: float | None = None) -> bool:
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
