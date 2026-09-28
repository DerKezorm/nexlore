"""AI from outside, over MCP: keys per account, three levels, drafts.

**Off by default.** The operator opens it (``mcp_allowed``) and sets the highest level a key may have
(``mcp_max_level``). Then every account makes keys of its own. A key acts as its account and never sees more: every
tool goes through the same rights as the interface, a space the account may not read answers like one that does not
exist, and every way of writing needs the right to write.

Three levels, each including the one before:

* **read**: search, read notes, links, tasks. Changes nothing.
* **draft**: also proposals. A draft is kept in nexlore, next to the note (or the folder, for a new note), and only
  its account sees it; taking it over saves it like the editor does, against the state the AI read (a conflict copy
  when the note changed in the meantime).
* **write**: changes notes directly, each change a version with the source ``mcp``, unchanged lines kept byte for
  byte (``textblocks``), a conflict copy when the note changed since the AI read it or somebody is editing it.

**The key.** ``nxl_`` and 43 random characters, shown once. Only its SHA-256 is stored, and its first characters to
tell keys apart. It travels in ``Authorization: Bearer``, never in an address, and never reaches the log.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import threading
import time
import zlib
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Account, Draft, McpKey, utcnow
from . import rights, settings_service, totp

logger = logging.getLogger("nexlore.mcp")

LEVELS = ("read", "draft", "write")
TOKEN_PREFIX = "nxl_"
#: How many keys an account may hold; revoked ones do not count.
MAX_KEYS = 20
#: How many open drafts an account may have: an AI in a loop must not fill the database.
MAX_DRAFTS = 200
MAX_DRAFT_BYTES = 5 * 1024 * 1024
#: Requests one key may make per minute.
PER_MINUTE = 240
#: ``last_used_at`` is written at most this often: a busy agent must not write the database with every call.
USED_EVERY = timedelta(minutes=1)


class McpError(Exception):
    def __init__(self, code: str, text: str, status: int = 400) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


def at_least(level: str, need: str) -> bool:
    return LEVELS.index(level) >= LEVELS.index(need)


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, "mcp_allowed"))


def max_level(db: Session) -> str:
    value = settings_service.get(db, "mcp_max_level")
    return value if value in LEVELS else "read"


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make_key(
    db: Session, account: Account, name: str, level: str, spaces: list[int] | None = None
) -> tuple[McpKey, str]:
    """A new key; the token is returned once and never stored. ``spaces``: the key sees only these, of the spaces
    the account may read; None: all it may read, now and later."""
    if level not in LEVELS:
        raise McpError("invalid_input", "No such level.", 422)
    if spaces is not None:
        # A space the account may not read is refused like one that does not exist.
        if not spaces or not set(spaces) <= rights.readable_ids(db, account):
            raise McpError("invalid_input", "Choose spaces you may read.", 422)
        spaces = sorted(set(spaces))
    if not at_least(max_level(db), level):
        raise McpError("level_not_allowed", "The operator does not allow keys of this level.", 403)
    count = len(db.scalars(select(McpKey.id).where(McpKey.account_id == account.id)).all())
    if count >= MAX_KEYS:
        raise McpError("too_many_keys", "An account holds at most 20 keys.", 409)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = McpKey(account_id=account.id, name=name.strip()[:100] or "MCP", level=level, token_hash=digest(token),
                 prefix=token[: len(TOKEN_PREFIX) + 4], spaces=spaces, created_at=utcnow())
    db.add(row)
    db.commit()
    db.refresh(row)
    logger.info("MCP key made key_id=%s level=%s spaces=%s", row.id, level, "all" if spaces is None else len(spaces))
    return row, token


@dataclass
class Caller:
    """Who calls over MCP: the account, detached, and its key. A key limited to some spaces has them on the account
    (``Account.key_spaces``), so every right checked for it sees only those."""

    account: Account
    key_id: int
    key_name: str
    level: str


def authenticate(db: Session, token: str | None) -> Caller | None:
    """The account and key behind a token, or None: no such key, MCP off, or the account locked. The level is the
    key's, but never above what the operator allows now (lowered later, it applies to keys made before)."""
    if not token or not token.startswith(TOKEN_PREFIX) or len(token) > 200:
        return None
    key = db.scalar(select(McpKey).where(McpKey.token_hash == digest(token)))
    if key is None:
        return None
    account = db.get(Account, key.account_id)
    if account is None or (account.locked_until is not None and account.locked_until > utcnow()):
        return None
    if totp.setup_required(db, account):
        # The operator requires a second factor this account has not set up: its keys wait like its sessions.
        return None
    now = utcnow()
    if key.last_used_at is None or now - key.last_used_at >= USED_EVERY:
        key.last_used_at = now
        db.commit()
    ceiling = max_level(db)
    level = key.level if at_least(ceiling, key.level) else ceiling
    db.expunge(account)
    if key.spaces is not None:
        account.key_spaces = frozenset(int(space_id) for space_id in key.spaces)
    return Caller(account=account, key_id=key.id, key_name=key.name, level=level)


_calls_lock = threading.Lock()
_calls: dict[int, deque[float]] = defaultdict(deque)


def brake(key_id: int, now: float | None = None) -> bool:
    """True while the key stays under ``PER_MINUTE`` requests in the last minute; counts this one."""
    now = time.monotonic() if now is None else now
    with _calls_lock:
        seen = _calls[key_id]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= PER_MINUTE:
            return False
        seen.append(now)
        return True


def forget() -> None:
    with _calls_lock:
        _calls.clear()


# --- Drafts ----------------------------------------------------------------------------------------------------------


def add_draft(
    db: Session, caller: Caller, *, space_id: int, path: str, file_id: int | None, base_hash: str, content: bytes,
    reason: str,
) -> Draft:
    """A proposal of the AI: a new text for the note ``file_id`` (read as ``base_hash``), or a new note at ``path``.
    A second draft of the same key for the same note replaces the first."""
    if len(content) > MAX_DRAFT_BYTES:
        raise McpError("too_large", "A draft holds at most 5 MB.", 413)
    if file_id is not None:
        db.execute(delete(Draft).where(Draft.account_id == caller.account.id, Draft.key_id == caller.key_id,
                                       Draft.file_id == file_id))
    open_drafts = len(db.scalars(select(Draft.id).where(Draft.account_id == caller.account.id)).all())
    if open_drafts >= MAX_DRAFTS:
        db.rollback()
        raise McpError("too_many_drafts", "There are 200 open drafts already. Take some over or throw them away.",
                       409)
    draft = Draft(
        account_id=caller.account.id, key_id=caller.key_id, key_name=caller.key_name, space_id=space_id, path=path,
        file_id=file_id, base_hash=base_hash, content=zlib.compress(content, 6), reason=reason.strip()[:500],
        created_at=utcnow(),
    )
    db.add(draft)
    db.commit()
    db.refresh(draft)
    logger.info("MCP draft made draft_id=%s key_id=%s new=%s", draft.id, caller.key_id, file_id is None)
    return draft


def draft_text(draft: Draft) -> bytes:
    return zlib.decompress(draft.content)
