"""Passwords, browser sessions, the brake against guessing, and the secrets the server keeps for itself.

Built after nextrmnl's: Argon2id for passwords, sessions as random tokens of which the database knows only the
hash, a brake per sender in memory and a lock per account in the database (ten failures, a quarter of an hour).
"""

from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import Account, AuthSession, utcnow

SESSION_COOKIE = "nexlore_session"
MIN_PASSWORD = 12
#: After this many failures in a row an account waits a quarter of an hour. Not configurable on purpose.
MAX_FAILURES = 10
LOCK_MINUTES = 15


def _hasher() -> PasswordHasher:
    settings = get_settings()
    return PasswordHasher(
        time_cost=settings.argon2_time, memory_cost=settings.argon2_memory_kib, parallelism=settings.argon2_parallelism
    )


#: Argon2 takes 64 MB per check. Sign-in needs no account, so without a limit a crowd of guesses at once could ask for
#: gigabytes (about 40 threads at a time); a small NAS would run out of memory.
HASHING_AT_ONCE = 4
#: Seconds a check waits for a free slot before the request answers busy.
HASH_WAIT = 15
_hashing = threading.BoundedSemaphore(HASHING_AT_ONCE)


class HashingBusy(Exception):
    """Every slot for checking passwords stayed taken: the request answers 503, the browser tries again."""


def _hash_slot() -> None:
    if not _hashing.acquire(timeout=HASH_WAIT):
        raise HashingBusy


def hash_password(password: str) -> str:
    _hash_slot()
    try:
        return _hasher().hash(password)
    finally:
        _hashing.release()


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    _hash_slot()
    try:
        return _hasher().verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    finally:
        _hashing.release()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def start_session(db: Session, account: Account, ip: str, user_agent: str) -> str:
    """Creates a browser session and returns the token for the cookie."""
    token = new_token()
    db.add(
        AuthSession(
            token_hash=hash_token(token),
            account_id=account.id,
            expires_at=utcnow() + timedelta(days=get_settings().session_days),
            ip=ip[:64],
            user_agent=user_agent[:255],
        )
    )
    account.last_seen_at = utcnow()
    db.commit()
    return token


def session_account(db: Session, token: str | None) -> Account | None:
    if not token:
        return None
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    if session is None:
        return None
    now = utcnow()
    if session.expires_at <= now:
        db.delete(session)
        db.commit()
        return None
    account = db.get(Account, session.account_id)
    if account is None:
        return None
    # Only every few minutes: the interface asks often.
    if (now - session.last_seen_at).total_seconds() > 300:
        session.last_seen_at = now
        account.last_seen_at = now
        db.commit()
    return account


def end_session(db: Session, token: str | None) -> None:
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        db.commit()


def end_all_sessions(db: Session, account_id: int, except_token: str | None = None) -> None:
    statement = delete(AuthSession).where(AuthSession.account_id == account_id)
    if except_token:
        statement = statement.where(AuthSession.token_hash != hash_token(except_token))
    db.execute(statement)
    db.commit()


def purge_sessions(db: Session) -> int:
    result = db.execute(delete(AuthSession).where(AuthSession.expires_at <= utcnow()))
    db.commit()
    return int(getattr(result, "rowcount", 0) or 0)


class Brake:
    """Waiting time after wrong passwords, per sender. In memory only; the per-account lock is in the database.

    A count is forgotten an hour after its last failure, and the table is thinned out when it grows: every new address
    (cheap with IPv6) would otherwise stay in memory for as long as the server runs.
    """

    FREE = 5
    MAX_WAIT = LOCK_MINUTES * 60
    FORGET_AFTER = 3600
    MAX_KEYS = 50_000

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._fails: dict[str, tuple[int, float]] = {}

    def _current(self, key: str, now: float) -> tuple[int, float]:
        count, last = self._fails.get(key, (0, 0.0))
        return (0, 0.0) if count and now - last > self.FORGET_AFTER else (count, last)

    def wait_seconds(self, key: str, free: int | None = None) -> int:
        """Seconds to wait; ``free`` wrong tries pass without (``FREE`` when not given)."""
        free = self.FREE if free is None else free
        now = time.monotonic()
        with self._lock:
            count, last = self._current(key, now)
        if count < free:
            return 0
        wait = min(self.MAX_WAIT, 2 ** min(count - free, 20) * 5)
        remaining = last + wait - now
        return max(0, int(remaining + 0.999))

    def failed(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            count, _ = self._current(key, now)
            self._fails[key] = (count + 1, now)
            if len(self._fails) > self.MAX_KEYS:
                self._fails = {k: v for k, v in self._fails.items() if now - v[1] <= self.FORGET_AFTER}
                while len(self._fails) > self.MAX_KEYS * 0.9:
                    self._fails.pop(next(iter(self._fails)))

    def succeeded(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)

    def forget(self) -> None:
        """For the tests."""
        with self._lock:
            self._fails.clear()


brake = Brake()


# --- Secrets the server reads on its own (OIDC client secret, mail password) ---------------------------------------

_AAD = b"nexlore-server-secret-v1"
_NONCE = 12


def _server_key() -> bytes:
    secret = get_settings().resolved_secret_key().encode("utf-8")
    return hashlib.sha256(b"nexlore-secrets:" + secret).digest()


DEVICE_COOKIE = "nexlore_device"
DEVICE_DAYS = 365


def device_token(account_id: int) -> str:
    """A browser that signed in once as this account: it may still sign in while the account is locked against the
    rest of the world. Signed with the server's key; nothing about it is stored."""
    nonce = secrets.token_urlsafe(12)
    mark = hashlib.sha256(_server_key() + f"device:{account_id}:{nonce}".encode()).hexdigest()[:32]
    return f"{account_id}.{nonce}.{mark}"


def device_of(token: str | None) -> int | None:
    """The account a device cookie was given to, or None when it is missing or not signed by this server."""
    if not token or token.count(".") != 2:
        return None
    account, nonce, mark = token.split(".")
    if not account.isdigit():
        return None
    expected = hashlib.sha256(_server_key() + f"device:{account}:{nonce}".encode()).hexdigest()[:32]
    return int(account) if secrets.compare_digest(mark, expected) else None


def _aad(context: str) -> bytes:
    # A context of its own per kind of secret: an AI key sealed for one account cannot be passed off as another's,
    # nor as a request of the AI list. Without one, the old secrets (OIDC, mail) read as before.
    return _AAD + b":" + context.encode("utf-8") if context else _AAD


def encrypt_secret(text: str, context: str = "") -> str:
    """AES-256-GCM with a key from ``secret.key``, stored as hex."""
    if not text:
        return ""
    nonce = os.urandom(_NONCE)
    return (nonce + AESGCM(_server_key()).encrypt(nonce, text.encode("utf-8"), _aad(context))).hex()


def decrypt_secret(stored: str, context: str = "") -> str:
    if not stored:
        return ""
    try:
        sealed = bytes.fromhex(stored)
        return AESGCM(_server_key()).decrypt(sealed[:_NONCE], sealed[_NONCE:], _aad(context)).decode("utf-8")
    except (InvalidTag, ValueError):
        # A different secret.key than the one that encrypted it: the value is lost, not the app.
        return ""
