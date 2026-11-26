"""Notifications (block Z2): what an account wants to hear about, sent to its webhook and, when the operator set up a
mail server, by mail.

Six occasions, each switched per account: ``mention`` (somebody names you with @ in a comment, or answers in a thread
you take part in), ``invite`` (an invitation into a space), ``approval`` (an AI program waits for your yes, block Y),
``tasks`` (once a day at a time of your choosing: what is due today or overdue) and ``operator`` (for operators: a
backup failed, a newer version is out, the disk runs full); and ``tokens`` (an API token runs out within a week,
once per token).

**The webhook is always open**: an address of the account's choosing, http or https, kept encrypted
and never shown again in full. It gets a small JSON body (``app``, ``event``, ``title``, ``message``, ``url``,
``priority``), which a webhook inbox such as nexsift takes as it is. Mail goes only where the operator entered a mail
server and the account has an address.

Sending never holds up what caused it and never breaks it: it runs in a worker thread, every failure is logged by its
kind only (never the address, never the text). What a notification says is a title and a line, the names of notes and
people, never a note's text.

**Mail goes through the shared post module** (post 1.1.0, ``app_letters``): the letter in the account's language (German
or English, ``TEXTS``) with nexlore's logo, into the outbox, which tries a mail again that did not go out; the test of
the account goes out at once and says how it went. **The webhook keeps its English words**, as before: a program
behind it may read them.
"""

from __future__ import annotations

import logging
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import OPERATOR, Account, utcnow
from ..security import account_out, decrypt_secret, encrypt_secret
from ..vendor.nexupdates.words import WORDS as _UPDATE_WORDS
from . import kontenpost, settings_service

logger = logging.getLogger("nexlore.notify")

EVENTS = ("mention", "invite", "approval", "tasks", "operator", "tokens")
DEFAULTS: dict[str, Any] = {
    "email": False, "mention": True, "invite": True, "approval": True, "tasks": False, "tasks_time": "07:00",
    "operator": True, "tokens": True,
}
#: The key's purpose for the encryption of webhook addresses: one secret, another context than SMTP or AI keys.
CONTEXT = "notify-webhook"
TIMEOUT = httpx.Timeout(5.0, connect=3.0)
#: Below this much free space where the data lives, operators hear about it (once a day).
LOW_DISK_BYTES = 1024**3
LOW_DISK_SHARE = 0.05

#: Set by the tests: deliver at once instead of in the worker.
INLINE = False
_worker = ThreadPoolExecutor(max_workers=4, thread_name_prefix="notify")
#: What one account may receive in an hour, and how many may wait at all. A reader naming somebody a hundred times
#: in comments queued a hundred posts; a slow webhook then held up everybody's, the operator's alarms too.
PER_HOUR = 60
MAX_WAITING = 500
_counts: dict[int, list[float]] = {}
_counts_lock = threading.Lock()
_waiting = 0
#: Control characters and line breaks of any kind: a mail subject must be one line, or the mail is never sent.
_UNSAFE_LINE = re.compile("[\x00-\x1f\x7f\x85\u2028\u2029]")

#: What each notification says, in English (the webhook and mail in English) and German (mail): its title and its
#: line, with the values of ``Words``. The English words are those of 1.16.0.
TEXTS: dict[str, dict[str, tuple[str, str]]] = {
    "test": {
        "en": ("nexlore test", "Notifications from nexlore reach you here."),
        "de": ("Test von nexlore", "Benachrichtigungen von nexlore erreichen dich hier."),
    },
    "mention": {
        "en": ("{who} names you in a comment on {note}", ""),
        "de": ("{who} nennt dich in einem Kommentar zu {note}", ""),
    },
    "answer": {
        "en": ("{who} answered in a thread on {note}", ""),
        "de": ("{who} hat in einem Gespräch zu {note} geantwortet", ""),
    },
    "invite": {
        "en": ("{who} invites you into {space}", "Answer under New in nexlore."),
        "de": ("{who} lädt dich in {space} ein", "Antworte unter „Neu“ in nexlore."),
    },
    "approval": {
        "en": ("{key} waits for your approval", "Tool: {tool}"),
        "de": ("{key} wartet auf deine Zustimmung", "Werkzeug: {tool}"),
    },
    "tasks": {
        "en": ("{today} due today, {overdue} overdue", "{titles}"),
        "de": ("{today} heute fällig, {overdue} überfällig", "{titles}"),
    },
    "backup_failed": {
        "en": ("A backup of nexlore failed", "The scheduled backup did not finish; the log says why."),
        "de": ("Eine Sicherung von nexlore ist gescheitert",
               "Die geplante Sicherung ist nicht fertig geworden; das Log sagt, warum."),
    },
    "restore_failed": {
        "en": ("A restore of nexlore failed",
               "The backup could not be restored at the start; nexlore runs with the data from before."),
        "de": ("Eine Wiederherstellung von nexlore ist gescheitert",
               "Die Sicherung ließ sich beim Start nicht wiederherstellen; nexlore läuft mit den Daten von vorher."),
    },
    "disk_low": {
        "en": ("The disk of nexlore runs full", "Less than 1 GB or 5 % is free where nexlore keeps its data."),
        "de": ("Die Platte von nexlore läuft voll", "Wo nexlore seine Daten hält, ist weniger als 1 GB oder 5 % frei."),
    },
    #: The bell's words come from the shared module updates (U12): nexlore {version} in the operator's language.
    "new_version": {
        language: (said["title"].replace("{app}", "nexlore"), said["text"].replace("{app}", "nexlore"))
        for language, said in _UPDATE_WORDS.items()
        if language in ("en", "de")
    },
    "token_expiring": {
        "en": ("The API key {name} runs out on {day}",
               "Make a new one under My account › Connections › API keys, and put it where the old one is used."),
        "de": ("Der API-Schlüssel {name} läuft am {day} ab",
               ("Leg unter Mein Konto › Verbindungen › API-Schlüssel einen neuen an und setz ihn dort ein, wo der "
                "alte benutzt wird.")),
    },
}
#: The last line of every notification mail, and the word on its button.
FOOTER = {"en": "You get this because you switched it on in nexlore.",
          "de": "Du bekommst das, weil du es in nexlore eingeschaltet hast."}
ACTION = {"en": "Open in nexlore", "de": "In nexlore öffnen"}


@dataclass(frozen=True)
class Words:
    """What a notification says: one of ``TEXTS`` and its values (names of notes, people, spaces; never a note's
    text)."""

    kind: str
    values: dict[str, str] = field(default_factory=dict)

    def render(self, language: str = "en") -> tuple[str, str]:
        texts = TEXTS[self.kind]
        title, message = texts.get(language) or texts["en"]
        return title.format(**self.values), message.format(**self.values)


def words(kind: str, **values: object) -> Words:
    if kind not in TEXTS:
        raise ValueError(kind)
    return Words(kind, {name: str(value) for name, value in values.items()})


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
    """The status of the answer, and nothing of its body: it is not read at all (300 MB were read into memory
    before). No proxy or credentials from the environment."""
    with (
        httpx.Client(timeout=TIMEOUT, follow_redirects=False, trust_env=False) as client,
        client.stream("POST", url, json=body) as response,
    ):
        return response.status_code


def _letter(db: Session, account: Account, said: Words, url: str) -> Any:
    """The notification as a letter of the post module, in the account's language, to its address."""
    from ..vendor import nexpost

    language = kontenpost.language_for(db, account)
    language = language if language in TEXTS[said.kind] else "en"
    title, message = said.render(language)
    # A line break in a note's title made the subject invalid and the mail was never sent.
    subject = " ".join(_UNSAFE_LINE.sub(" ", title).split())[:200]
    return nexpost.app_letters.write(
        account.email, kind=f"notify.{said.kind}", subject=subject, language=language,
        paragraphs=[line for line in message.split("\n") if line.strip()] or [subject],
        link=url, action=ACTION[language] if url else "", footer=FOOTER[language],
    )


def reaches(account: Account | None) -> bool:
    """Whether a notification would go out to the account now: it is not out (blocked or deleted, konten E38) and has
    a way (a webhook, or mail with an address and the operator's mail server)."""
    if account is None or account_out(account):
        return False
    if webhook_of(account):
        return True
    with SessionLocal() as db:
        return bool(choices(account)["email"] and account.email and kontenpost.configured(db))


def deliver(account_id: int, event: str, said: Words, path: str = "", priority: int = 3, *,
            at_once: bool = False) -> dict[str, str]:
    """Send one notification now, through every way the account has. Returns how each went (for the test button).
    The mail goes into the outbox of the post module, or at once with ``at_once`` (the test: its answer counts)."""
    from ..vendor import nexpost
    from .post_store import PostStore

    outcome: dict[str, str] = {}
    title, message = said.render("en")
    with SessionLocal() as db:
        account = db.get(Account, account_id)
        if account is None or account_out(account):
            # Out since it was handed on (blocked or deleted, konten E38): nothing goes to it.
            return outcome
        mine = choices(account)
        hook = webhook_of(account)
        email = account.email if mine["email"] and account.email and kontenpost.configured(db) else ""
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
                letter = _letter(db, account, said, url)
                if at_once:
                    nexpost.outbox.deliver_now(PostStore(db), letter)
                else:
                    nexpost.outbox.queue(PostStore(db), letter)
                    db.commit()
                outcome["email"] = "ok"
            except Exception as exc:  # noqa: BLE001
                outcome["email"] = "failed"
                logger.warning("Notification not sent way=mail event=%s reason=%s", event, type(exc).__name__)
    return outcome


def send(account_id: int, event: str, said: Words, path: str = "", priority: int = 3) -> None:
    """A notification for one account, if it wants this occasion; sent in the background."""
    if event not in EVENTS:
        raise ValueError(event)
    with SessionLocal() as db:
        account = db.get(Account, account_id)
        # Blocked or deleted: out of every way in, nothing reaches it either.
        if account_out(account) or not choices(account)[event]:
            return
        if event == "operator" and account.role != OPERATOR:
            return
        if not account.notify_webhook_enc and not (choices(account)["email"] and account.email):
            return
    if not _room_for(account_id):
        return
    if INLINE:
        deliver(account_id, event, said, path, priority)
        return
    global _waiting
    with _counts_lock:
        if _waiting >= MAX_WAITING:
            logger.warning("Notification dropped: %s are waiting already", MAX_WAITING)
            return
        _waiting += 1
    _worker.submit(_safely, account_id, event, said, path, priority)


def _room_for(account_id: int) -> bool:
    """Whether the account may get one more this hour; the first dropped one is logged."""
    now = time.monotonic()
    with _counts_lock:
        recent = [moment for moment in _counts.get(account_id, []) if now - moment < 3600]
        if len(recent) >= PER_HOUR:
            if len(recent) == PER_HOUR:
                logger.warning("Notifications for account_id=%s held back: %s in the last hour", account_id, PER_HOUR)
                recent.append(now)
            _counts[account_id] = recent
            return False
        recent.append(now)
        _counts[account_id] = recent
        return True


def forget() -> None:
    """For the tests: the hourly counts start again."""
    global _waiting
    with _counts_lock:
        _counts.clear()
        _waiting = 0


def _safely(*args: Any) -> None:
    global _waiting
    try:
        deliver(*args)
    except Exception:
        logger.exception("Notification failed")
    finally:
        with _counts_lock:
            _waiting = max(0, _waiting - 1)


def operators(said: Words, path: str = "", priority: int = 4) -> None:
    with SessionLocal() as db:
        ids = list(db.scalars(select(Account.id).where(Account.role == OPERATOR)))
    for account_id in ids:
        send(account_id, "operator", said, path, priority)


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
            # The notes they stand in, never the tasks' own words: what leaves nexlore is titles and names.
            titles = list(dict.fromkeys(item["title"] for item in overdue["items"] + today_items["items"]))[:10]
            send(row.id, "tasks", words("tasks", today=count_today, overdue=count_overdue,
                                        titles="\n".join(f"- {title}" for title in titles)), "/tasks", 3)
            sent += 1
    return sent


def disk_low() -> bool:
    """Whether the disk where the data lives runs full: under 1 GB or 5 % free."""
    usage = shutil.disk_usage(get_settings().data_dir)
    return usage.free < LOW_DISK_BYTES or usage.free < usage.total * LOW_DISK_SHARE


def daily_operator_checks(now: datetime | None = None) -> None:
    """Once a day: the disk. A newer version is the shared module's to tell (``updates.run_forever`` in ``main``,
    through ``operators`` here, once per version)."""
    now = now or datetime.now().astimezone()
    today = now.date().isoformat()
    with SessionLocal() as db:
        disk_day = settings_service.get(db, "notify_disk_day")
    if disk_day != today:
        with SessionLocal() as db:
            settings_service.save(db, {"notify_disk_day": today})
        try:
            low = disk_low()
        except OSError:
            low = False
        if low:
            operators(words("disk_low"), "/settings/storage", 5)


def tokens_expiring() -> int:
    """Every API token that runs out within a week and whose account has not heard yet: told once."""
    from . import apitokens

    sent = 0
    with _daily_lock:
        with SessionLocal() as db:
            rows = apitokens.due_for_warning(db)
            due = [(row.account_id, row.name, row.expires_at) for row in rows]
            for row in rows:
                row.warned_at = utcnow()
            db.commit()
        for account_id, name, expires_at in due:
            day = expires_at.astimezone().date().isoformat()
            send(account_id, "tokens", words("token_expiring", name=name, day=day), "/settings/connections", 3)
            sent += 1
    return sent


async def run_forever(stop: Any) -> None:
    """Every minute: the tasks of the morning; the operator's checks; API tokens about to run out."""
    import asyncio

    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
            return
        except TimeoutError:
            pass
        for job in (tasks_due, daily_operator_checks, tokens_expiring):
            try:
                await asyncio.to_thread(job)
            except Exception:
                logger.exception("Notification job failed")
