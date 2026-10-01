"""Notifications (block Z2): what an account wants to hear about, sent to its webhook and, when the operator set up a
mail server, by mail.

Five occasions, each switched per account: ``mention`` (somebody names you with @ in a comment, or answers in a thread
you take part in), ``invite`` (an invitation into a space), ``approval`` (an AI program waits for your yes, block Y),
``tasks`` (once a day at a time of your choosing: what is due today or overdue) and ``operator`` (for operators: a
backup failed, a newer version is out, the disk runs full).

**The webhook is always open** (design answer Z2): an address of the account's choosing, http or https, kept encrypted
and never shown again in full. It gets a small JSON body (``app``, ``event``, ``title``, ``message``, ``url``,
``priority``), which a webhook inbox such as nexsift takes as it is. Mail goes only where the operator entered a mail
server and the account has an address.

Sending never holds up what caused it and never breaks it: it runs in a worker thread, every failure is logged by its
kind only (never the address, never the text), and nothing is tried again. What a notification says is a title and a
line, the names of notes and people, never a note's text.
"""

from __future__ import annotations

import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from email.message import EmailMessage
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import OPERATOR, Account
from ..security import decrypt_secret, encrypt_secret
from . import mailer, settings_service

logger = logging.getLogger("nexlore.notify")

EVENTS = ("mention", "invite", "approval", "tasks", "operator")
DEFAULTS: dict[str, Any] = {
    "email": False, "mention": True, "invite": True, "approval": True, "tasks": False, "tasks_time": "07:00",
    "operator": True,
}
#: The key's purpose for the encryption of webhook addresses: one secret, another context than SMTP or AI keys.
CONTEXT = "notify-webhook"
TIMEOUT = httpx.Timeout(5.0, connect=3.0)
#: Below this much free space where the data lives, operators hear about it (once a day).
LOW_DISK_BYTES = 1024**3
LOW_DISK_SHARE = 0.05

#: Set by the tests: deliver at once instead of in the worker.
INLINE = False
_worker = ThreadPoolExecutor(max_workers=2, thread_name_prefix="notify")


class NotifyError(Exception):
    def __init__(self, code: str, text: str, status: int = 422) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


def choices(account: Account) -> dict[str, Any]:
    """What the account chose, over the defaults."""
    own = account.notify if isinstance(account.notify, dict) else {}
    return {key: own.get(key, value) for key, value in DEFAULTS.items()}


def check_choices(values: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in values.items():
        if key not in DEFAULTS:
            raise NotifyError("invalid_input", f"Unknown setting {key!r}.")
        if key == "tasks_time":
            if not isinstance(value, str) or len(value) != 5 or value[2] != ":" or not (
                value[:2].isdigit() and value[3:].isdigit() and int(value[:2]) < 24 and int(value[3:]) < 60
            ):
                raise NotifyError("invalid_input", "A time like 07:30.")
        elif not isinstance(value, bool):
            raise NotifyError("invalid_input", f"{key!r} is on or off.")
        clean[key] = value
    return clean


def check_webhook(url: str) -> str:
    url = url.strip()
    parts = urlsplit(url)
    if (
        len(url) > 2048 or parts.scheme not in ("http", "https") or not parts.hostname
        or any(ord(char) <= 32 for char in url)
    ):
        raise NotifyError("webhook_invalid", "Give an address like https://example.com/hook.")
    return url


def webhook_of(account: Account) -> str:
    return decrypt_secret(account.notify_webhook_enc or "", CONTEXT) if account.notify_webhook_enc else ""


def set_webhook(account: Account, url: str) -> None:
    account.notify_webhook_enc = encrypt_secret(check_webhook(url), CONTEXT) if url.strip() else ""


def _link(path: str) -> str:
    with SessionLocal() as db:
        base = settings_service.public_url(db)
    return f"{base}{path}" if base else ""


def _post(url: str, body: dict[str, Any]) -> int:
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False) as client:
        return client.post(url, json=body).status_code


def _mail(db: Session, to: str, title: str, message: str, url: str) -> None:
    mail = EmailMessage()
    mail["To"] = to
    mail["Subject"] = title
    ending = "\nYou get this because you switched it on in nexlore.\n"
    mail.set_content(message + (f"\n\n{url}\n" if url else "\n") + ending)
    mailer._send(db, mail)


def deliver(account_id: int, event: str, title: str, message: str, path: str = "", priority: int = 3) -> dict[str, str]:
    """Send one notification now, through every way the account has. Returns how each went (for the test button)."""
    outcome: dict[str, str] = {}
    with SessionLocal() as db:
        account = db.get(Account, account_id)
        if account is None:
            return outcome
        mine = choices(account)
        hook = webhook_of(account)
        email = account.email if mine["email"] and account.email and mailer.configured(db) else ""
        url = _link(path) if path else ""
        if hook:
            body = {"app": "nexlore", "event": event, "title": title, "message": message, "url": url,
                    "priority": priority}
            try:
                status = _post(hook, body)
                outcome["webhook"] = "ok" if 200 <= status < 300 else f"status {status}"
                logger.info("Notification sent way=webhook event=%s status=%s", event, status)
            except Exception as exc:  # noqa: BLE001
                outcome["webhook"] = "unreachable"
                logger.warning("Notification not sent way=webhook event=%s reason=%s", event, type(exc).__name__)
        if email:
            try:
                _mail(db, email, title, message, url)
                outcome["email"] = "ok"
            except Exception as exc:  # noqa: BLE001
                outcome["email"] = "failed"
                logger.warning("Notification not sent way=mail event=%s reason=%s", event, type(exc).__name__)
    return outcome


def send(account_id: int, event: str, title: str, message: str, path: str = "", priority: int = 3) -> None:
    """A notification for one account, if it wants this occasion; sent in the background."""
    if event not in EVENTS:
        raise ValueError(event)
    with SessionLocal() as db:
        account = db.get(Account, account_id)
        if account is None or not choices(account)[event]:
            return
        if event == "operator" and account.role != OPERATOR:
            return
        if not account.notify_webhook_enc and not (choices(account)["email"] and account.email):
            return
    if INLINE:
        deliver(account_id, event, title, message, path, priority)
    else:
        _worker.submit(_safely, account_id, event, title, message, path, priority)


def _safely(*args: Any) -> None:
    try:
        deliver(*args)
    except Exception:
        logger.exception("Notification failed")


def operators(title: str, message: str, path: str = "", priority: int = 4) -> None:
    with SessionLocal() as db:
        ids = list(db.scalars(select(Account.id).where(Account.role == OPERATOR)))
    for account_id in ids:
        send(account_id, "operator", title, message, path, priority)


# --- The daily ones ---------------------------------------------------------------------------------------------------

_daily_lock = threading.Lock()


def tasks_due(now: datetime | None = None) -> int:
    """Every account whose time has come today and that has not heard yet: what is due today and overdue."""
    from ..routers import everyday as everyday_routes

    now = now or datetime.now().astimezone()
    today = now.date().isoformat()
    sent = 0
    with _daily_lock:
        with SessionLocal() as db:
            accounts = list(db.scalars(select(Account).where(Account.notify.is_not(None))))
        for account in accounts:
            mine = choices(account)
            if not mine["tasks"] or account.notify_tasks_day == today or now.strftime("%H:%M") < mine["tasks_time"]:
                continue
            with SessionLocal() as db:
                row = db.get(Account, account.id)
                if row is None:
                    continue
                row.notify_tasks_day = today
                db.commit()
                db.expunge(row)
            try:
                today_items = everyday_routes.task_list(row, today, "open", "today", None, None, None, None, None,
                                                        None, 0, 10)
                overdue = everyday_routes.task_list(row, today, "open", "overdue", None, None, None, None, None,
                                                    None, 0, 10)
            except Exception:
                logger.exception("Tasks for a notification could not be read")
                continue
            count_today, count_overdue = today_items["total"], overdue["total"]
            if not count_today and not count_overdue:
                continue
            lines = [f"- {item['text']}" for item in (overdue["items"] + today_items["items"])[:10]]
            send(row.id, "tasks", f"{count_today} due today, {count_overdue} overdue",
                 "\n".join(lines), "/tasks", 3)
            sent += 1
    return sent


def disk_low() -> bool:
    """Whether the disk where the data lives runs full: under 1 GB or 5 % free."""
    usage = shutil.disk_usage(get_settings().data_dir)
    return usage.free < LOW_DISK_BYTES or usage.free < usage.total * LOW_DISK_SHARE


def daily_operator_checks(now: datetime | None = None) -> None:
    """Once a day: the disk; whenever a newer version is first seen: that."""
    from . import updates

    now = now or datetime.now().astimezone()
    today = now.date().isoformat()
    with SessionLocal() as db:
        on = bool(settings_service.get(db, "update_check"))
        disk_day = settings_service.get(db, "notify_disk_day")
        told_version = settings_service.get(db, "notify_version")
    if disk_day != today:
        with SessionLocal() as db:
            settings_service.save(db, {"notify_disk_day": today})
        try:
            low = disk_low()
        except OSError:
            low = False
        if low:
            operators("The disk of nexlore runs full", "Less than 1 GB or 5 % is free where nexlore keeps its data.",
                      "/settings?tab=server", 5)
    if on:
        known = updates.state(on=True)
        if known.newer and known.latest and known.latest != told_version:
            with SessionLocal() as db:
                settings_service.save(db, {"notify_version": known.latest})
            operators(f"nexlore {known.latest.lstrip('v')} is out", "A newer version of nexlore is out.", "/about", 2)


async def run_forever(stop: Any) -> None:
    """Every minute: the tasks of the morning; the operator's checks."""
    import asyncio

    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
            return
        except TimeoutError:
            pass
        for job in (tasks_due, daily_operator_checks):
            try:
                await asyncio.to_thread(job)
            except Exception:
                logger.exception("Notification job failed")
