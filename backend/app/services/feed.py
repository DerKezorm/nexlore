"""
The calendar subscription: the open tasks with a due date as an iCalendar feed, for a calendar app to subscribe to.

**Closed until the operator opens it** (``calendar_feed_allowed``): the tasks leave the house to wherever the
address is given. Each account makes its own address; the key in it (``nxc_`` and 43 random characters) is shown
once, only its SHA-256 is kept, and a new one replaces the old. A calendar app cannot send a header, so the key
travels in the address; the log never shows it (``logs.redact``).

The feed holds what the account may read now: tasks due from 60 days back to a year ahead, each an all-day event.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import date, timedelta
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, utcnow
from . import everyday, rights, settings_service, totp

TOKEN_PREFIX = "nxc_"
BACK_DAYS = 60
AHEAD_DAYS = 366
MAX_EVENTS = 2000


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, "calendar_feed_allowed"))


def make(db: Session, account: Account) -> str:
    """A new key for the account, replacing the one before; returned once."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    account.calendar_feed_hash = digest(token)
    db.commit()
    return token


def stop(db: Session, account: Account) -> None:
    account.calendar_feed_hash = None
    db.commit()


def owner(db: Session, token: str) -> Account | None:
    """The account behind a key, or None: no such key, the feed closed, the account locked or waiting for its
    second factor."""
    if not token.startswith(TOKEN_PREFIX) or len(token) > 100 or not allowed(db):
        return None
    account = db.scalar(select(Account).where(Account.calendar_feed_hash == digest(token)))
    if account is None or (account.locked_until is not None and account.locked_until > utcnow()):
        return None
    if totp.setup_required(db, account):
        return None
    return account


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r", "").replace("\n", "\\n")


def _fold(line: str) -> str:
    """Lines of at most 75 octets, the rest on lines starting with a space (RFC 5545, 3.1)."""
    data = line.encode("utf-8")
    if len(data) <= 75:
        return line
    parts: list[str] = []
    current = b""
    for char in line:
        encoded = char.encode("utf-8")
        if len(current) + len(encoded) > (75 if not parts else 74):
            parts.append(current.decode("utf-8"))
            current = b""
        current += encoded
    parts.append(current.decode("utf-8"))
    return "\r\n ".join(parts)


def calendar(db: Session, account: Account, *, today: date, base_url: str, name: str) -> str:
    """The feed of the account as iCalendar text."""
    readable = rights.readable_ids(db, account)
    start, end = today - timedelta(days=BACK_DAYS), today + timedelta(days=AHEAD_DAYS)
    found = everyday.list_tasks(
        readable, status="open", today=today.isoformat(), between=(start.isoformat(), end.isoformat()),
        limit=MAX_EVENTS,
    )
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//nexlore//tasks//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape(name)}", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    ]
    for task in found["items"]:
        due = task.get("due") or task.get("scheduled")
        if not due:
            continue
        day = date.fromisoformat(due)
        uid = hashlib.sha256(f"{task['path']}\n{task['raw']}".encode()).hexdigest()[:32]
        lines += [
            "BEGIN:VEVENT",
            f"UID:{uid}@nexlore",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{day.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{(day + timedelta(days=1)).strftime('%Y%m%d')}",
            f"SUMMARY:{_escape(task['text'] or task['raw'])}",
            f"DESCRIPTION:{_escape(task['title'])}",
        ]
        if base_url:
            lines.append(f"URL:{base_url.rstrip('/')}/note/{quote(task['path'])}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
