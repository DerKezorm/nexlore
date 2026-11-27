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
from datetime import UTC, datetime

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from .config import get_settings
from .models import SESSION_VIA_PASSWORD, SESSION_VIA_PROVIDER, Account, AppDevice, AuthSession, McpKey, utcnow

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


def start_session(db: Session, account: Account, ip: str, user_agent: str, via: str = SESSION_VIA_PASSWORD, *,
                  remember: bool = True) -> str:
    """Creates a browser session (the shared account module, ``sessions.start``) and returns the token for the
    cookie. ``via``: how it began (``SESSION_VIA_*``; a provider that checks the second factor itself is
    ``SESSION_VIA_PROVIDER``). ``remember``: "Stay signed in", 30 days from the last use; without it at most 12 hours
    and a cookie that ends with the browser (``session_cookie_age``)."""
    from .services.konten_store import KontenStore
    from .vendor.nexkonten import sessions

    started = sessions.start(
        KontenStore(db),
        account.id,
        cookie_name=SESSION_COOKIE,
        secure=False,
        remember=remember,
        provider_checked=via == SESSION_VIA_PROVIDER,
        label=user_agent[:255],
        address=ip[:64],
    )
    account.last_seen_at = utcnow()
    db.commit()
    return started.token


def session_cookie_age(remember: bool) -> int | None:
    """How long the browser keeps the session cookie: "Stay signed in" outlives the session (the server decides),
    otherwise the cookie ends with the browser."""
    from .vendor.nexkonten import sessions

    return sessions.REMEMBER_COOKIE_DAYS * 86400 if remember else None


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def account_out(account: Account | None) -> bool:
    """Blocked or deleted by the operator (or gone): no session, no token, no key counts for it."""
    return account is None or account.blocked_at is not None or account.deleted_at is not None


def session_account(db: Session, token: str | None) -> Account | None:
    """The account of a browser session (``sessions.current``: run out is out, "Stay signed in" slides), or None.
    A blocked account is out at once."""
    if not token:
        return None
    from .services.konten_store import KontenStore
    from .vendor.nexkonten import model2, sessions

    row = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    if row is not None and _aware(row.expires_at) <= utcnow():
        # A session that ran out goes at its next showing (and in the hourly sweep).
        db.delete(row)
        db.commit()
        return None
    session = sessions.current(KontenStore(db), token)
    if session is None or session.kind != model2.KIND_BROWSER:
        if db.dirty:
            db.commit()
        return None
    account = db.get(Account, int(session.account_id))
    if account is None or account_out(account):
        return None
    if db.dirty or db.new:
        # ``current`` wrote the last use (at most every five minutes); the account's last use goes with it.
        account.last_seen_at = utcnow()
        db.commit()
    return account


def session_via(db: Session, token: str | None) -> str:
    """How the session of this cookie began; the password for an unknown one (the stricter rule)."""
    if not token:
        return SESSION_VIA_PASSWORD
    found = db.scalar(select(AuthSession.via).where(AuthSession.token_hash == hash_token(token)))
    return found or SESSION_VIA_PASSWORD


def session_uid(db: Session, token: str | None) -> str:
    """The id of the session of this cookie in the list "Signed-in devices", "" for none."""
    if not token:
        return ""
    row = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    return (row.uid or f"s{row.id}") if row is not None else ""


def end_session(db: Session, token: str | None) -> None:
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        db.commit()


def end_all_sessions(db: Session, account_id: int, except_token: str | None = None, *, devices: bool = True) -> None:
    """Every browser session of the account but ``except_token``, and every connector that signed in over OAuth: a
    new password or "sign out everywhere" is what one does when the account was taken, and a connector's refresh
    token would have kept the taker in. Paired iPhones go too: they act with a session's rights. Keys made by hand in
    the interface stay; they are revoked there. The browsers known before are forgotten too (their marks); the one
    that stays gets a new one from the caller. ``devices=False`` (blocking, deleting with 30 days, G26): the paired
    devices rest instead and work again when the account is back."""
    statement = delete(AuthSession).where(AuthSession.account_id == account_id)
    if except_token:
        statement = statement.where(AuthSession.token_hash != hash_token(except_token))
    db.execute(statement)
    db.execute(delete(McpKey).where(McpKey.account_id == account_id, McpKey.kind == "oauth"))
    if devices:
        db.execute(delete(AppDevice).where(AppDevice.account_id == account_id))
    db.execute(update(Account).where(Account.id == account_id).values(device_key=secrets.token_urlsafe(24)))
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
        """For the tests: this brake and the one of the shared account module (sign-in, forgotten password, setup
        code, every door)."""
        from .vendor.nexkonten.brake import BRAKE

        with self._lock:
            self._fails.clear()
        BRAKE.forget()


brake = Brake()


# --- Secrets the server reads on its own (OIDC client secret, mail password) ---------------------------------------

_AAD = b"nexlore-server-secret-v1"
_NONCE = 12


def _server_key() -> bytes:
    secret = get_settings().resolved_secret_key().encode("utf-8")
    return hashlib.sha256(b"nexlore-secrets:" + secret).digest()


def server_key() -> bytes:
    """The key derived from the server's secret, for marks only the server can make (a keyed hash)."""
    return _server_key()


DEVICE_COOKIE = "nexlore_device"
DEVICE_DAYS = 365


def device_token(account_id: int) -> str:
    """The cookie of a known browser as 1.16.0 made it (one account, signed with the server's key); read for one
    version by ``routers/auth.browser_mark`` so that owners stay known. New marks come from the shared module."""
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
