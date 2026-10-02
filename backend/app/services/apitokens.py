"""API tokens: programs such as n8n or nexdeck use nexlore over ``/api/v1`` (``routers/v1.py``).

**Closed until the operator opens it** (``api_tokens_allowed``). Then every account makes tokens of its own, under
My account, Connections. A token acts as its account and never sees more: every route goes through the same rights as
the interface, a space the account may not read answers like one that does not exist.

Two levels:

* **read**: spaces, folders, notes, search, links, tasks, the numbers for a dashboard. Changes nothing.
* **write**: also makes notes, writes and appends to them, the daily note, the inbox, ticks tasks off. Each change a
  version with the source ``api``, a conflict copy when the note changed since the program read it or somebody is
  editing it. **Never** deleting, moving, renaming, members or public pages: no route for that exists under ``/api/v1``.

A token may be limited to some spaces (``ApiToken.spaces``) and may run out (``expires_at``); a week before, its
account hears about it once (``notify``, occasion ``tokens``). The operator sees every token and may block one for
good (``blocked_at``); a blocked token answers like none.

**The token.** ``nxa_`` and 43 random characters, shown once. Only its SHA-256 is stored, and its first characters to
tell tokens apart. It travels in ``Authorization: Bearer``, never in an address, and never reaches the log.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, ApiToken, utcnow
from . import rights, settings_service, totp

logger = logging.getLogger("nexlore.api")

LEVELS = ("read", "write")
TOKEN_PREFIX = "nxa_"
#: How many tokens an account may hold.
MAX_TOKENS = 20
#: The choices for running out, in days; None: never (the default, design answer).
LIFETIMES = (30, 90, 365)
#: Requests one token may make per minute.
PER_MINUTE = 600
#: ``last_used_at`` is written at most this often.
USED_EVERY = timedelta(minutes=1)
#: How long before the end the account hears about it.
WARN_BEFORE = timedelta(days=7)


class TokenError(Exception):
    def __init__(self, code: str, text: str, status: int = 400) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, "api_tokens_allowed"))


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make(
    db: Session, account: Account, name: str, level: str, spaces: list[int] | None = None, days: int | None = None
) -> tuple[ApiToken, str]:
    """A new token; the token itself is returned once and never stored. ``spaces``: the token sees only these, of the
    spaces the account may read; None: all it may read, now and later. ``days``: runs out then; None: never."""
    if level not in LEVELS:
        raise TokenError("invalid_input", "No such level.", 422)
    if days is not None and days not in LIFETIMES:
        raise TokenError("invalid_input", "A token runs out after 30, 90 or 365 days, or never.", 422)
    if spaces is not None:
        # A space the account may not read is refused like one that does not exist.
        if not spaces or not set(spaces) <= rights.readable_ids(db, account):
            raise TokenError("invalid_input", "Choose spaces you may read.", 422)
        spaces = sorted(set(spaces))
    count = len(db.scalars(select(ApiToken.id).where(ApiToken.account_id == account.id)).all())
    if count >= MAX_TOKENS:
        raise TokenError("too_many_tokens", "An account holds at most 20 tokens.", 409)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = utcnow()
    row = ApiToken(account_id=account.id, name=name.strip()[:100] or "API", level=level, token_hash=digest(token),
                   prefix=token[: len(TOKEN_PREFIX) + 4], spaces=spaces, created_at=now,
                   expires_at=None if days is None else now + timedelta(days=days))
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("API token made token_id=%s level=%s spaces=%s days=%s", row.id, level,
                "all" if spaces is None else len(spaces), days or "never")
    return row, token


@dataclass
class Caller:
    """Who calls ``/api/v1``: the account, detached, and its token. A token limited to some spaces has them on the
    account (``Account.key_spaces``), so every right checked for it sees only those."""

    account: Account
    token_id: int
    level: str

    @property
    def writes(self) -> bool:
        return self.level == "write"


def authenticate(db: Session, token: str | None) -> Caller | None:
    """The account behind a token, or None: no such token, run out, blocked, or the account locked or waiting for
    its second factor. Tokens being switched off is the caller's to check (``allowed``)."""
    if not token or not token.startswith(TOKEN_PREFIX) or len(token) > 200:
        return None
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == digest(token)))
    now = utcnow()
    if row is None or row.blocked_at is not None or (row.expires_at is not None and row.expires_at <= now):
        return None
    account = db.get(Account, row.account_id)
    if account is None or (account.locked_until is not None and account.locked_until > now):
        return None
    if totp.setup_required(db, account):
        # The operator requires a second factor this account has not set up: its tokens wait like its sessions.
        return None
    if row.last_used_at is None or now - row.last_used_at >= USED_EVERY:
        row.last_used_at = now
        db.commit()
    level = row.level if row.level in LEVELS else "read"
    spaces = row.spaces
    token_id = row.id
    db.expunge(account)
    account.via_key = True
    if spaces is not None:
        account.key_spaces = frozenset(int(space_id) for space_id in spaces)
    return Caller(account=account, token_id=token_id, level=level)


def due_for_warning(db: Session) -> list[ApiToken]:
    """Tokens that run out within a week and whose account has not heard yet."""
    now = utcnow()
    return list(db.scalars(select(ApiToken).where(
        ApiToken.expires_at.is_not(None), ApiToken.expires_at > now, ApiToken.expires_at <= now + WARN_BEFORE,
        ApiToken.warned_at.is_(None), ApiToken.blocked_at.is_(None),
    )))


_calls_lock = threading.Lock()
_calls: dict[int, deque[float]] = defaultdict(deque)


def brake(token_id: int, now: float | None = None) -> bool:
    """True while the token stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        seen = _calls[token_id]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _calls_lock:
        _calls.clear()
