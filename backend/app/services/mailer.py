"""Mail through the operator's SMTP server: invitations, notifications, the mails about an account.

Off until the operator enters a server: the link of an invitation to copy is always enough. The letters of the shared
post module (``vendor/nexpost``: invitation, test mail, the mails of the account module) go out in the language of
whoever receives them: the account's language, else its browser's at the last sign-in, else the first operator's, else
English. The mails about an account wait in the outbox (``services/kontenpost``, ``services/post_store``); an
invitation, the test mail and "Forgot your password?" go out at once, through ``_send`` like every mail nexlore sends
(notifications too, ``services/notify``).
"""

from __future__ import annotations

import logging
import re
import smtplib
import ssl
import unicodedata
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account
from ..security import decrypt_secret
from . import settings_service

logger = logging.getLogger("nexlore.mail")

TIMEOUT = 15
SECURITY = ("starttls", "tls", "none")
#: The languages nexlore writes mail in (the shared post module has the texts); any other gets English.
MAIL_LANGUAGES = ("de", "en", "fr")
#: The first language of an ``Accept-Language`` header: ``de`` from ``de-DE,de;q=0.9,en;q=0.8``.
_FIRST_LANGUAGE = re.compile(r"\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*\s*(?:[;,]|$)")


class MailError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def configured(db: Session) -> bool:
    values = settings_service.get_all(db)
    return bool(values["smtp_host"] and values["smtp_from"])


def _send(db: Session, message: EmailMessage) -> None:
    values = settings_service.get_all(db)
    if not (values["smtp_host"] and values["smtp_from"]):
        raise MailError("mail_off", "No mail server is set up.")
    host = str(values["smtp_host"])
    port = int(values["smtp_port"])
    security = str(values["smtp_security"])
    if "From" not in message:
        name = " ".join(str(values.get("smtp_sender_name") or "").split())
        message["From"] = formataddr((name, str(values["smtp_from"]))) if name else str(values["smtp_from"])
    if "Message-ID" not in message:
        message["Message-ID"] = make_msgid(domain=str(values["smtp_from"]).rpartition("@")[2] or None)
    # Required by RFC 5322. smtplib does not add it, and without it iCloud, Outlook and Gmail drop the mail silently.
    if "Date" not in message:
        message["Date"] = formatdate(localtime=True)
    context = ssl.create_default_context()
    try:
        if security == "tls":
            server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT, context=context)
        else:
            server = smtplib.SMTP(host, port, timeout=TIMEOUT)
        with server:
            if security == "starttls":
                server.starttls(context=context)
            user = str(values["smtp_user"])
            if user:
                server.login(user, decrypt_secret(str(values["smtp_password_enc"])))
            server.send_message(message)
    except (smtplib.SMTPException, OSError, ssl.SSLError, UnicodeError) as exc:
        # The reason goes to the log by its kind only: an SMTP answer can quote the address or the credentials.
        logger.warning("Mail not sent host=%s reason=%s", host, type(exc).__name__)
        raise MailError("mail_failed", "The mail server did not take the mail.") from exc
    logger.info("Mail sent host=%s", host)


def browser_language(header: str) -> str:
    """The first language of an ``Accept-Language`` header, in lower case; "" for none."""
    found = _FIRST_LANGUAGE.match(header or "")
    return found.group(1).lower() if found else ""


def note_browser_language(account: Account, header: str) -> None:
    """At a sign-in: the browser's language, for mails while the account has none of its own (the caller commits)."""
    language = browser_language(header)
    if language and language != (account.browser_language or ""):
        account.browser_language = language[:16]


def mail_language(*choices: str | None) -> str:
    """The first of ``choices`` nexlore has mail texts for (``de-AT`` counts as ``de``); English otherwise."""
    for choice in choices:
        code = (choice or "").split("-")[0].split("_")[0].strip().lower()
        if code in MAIL_LANGUAGES:
            return code
    return "en"


def language_for(db: Session, account: Account | None) -> str:
    """The receiver's account language, else its browser's at the last sign-in, else the first operator's."""
    first = db.scalar(select(Account).where(Account.role == OPERATOR).order_by(Account.id).limit(1))
    return mail_language(
        account.language if account is not None else "",
        account.browser_language if account is not None else "",
        first.language if first is not None else "",
        first.browser_language if first is not None else "",
    )


def _one_line(text: str) -> str:
    """A name in a mail stays one line: a line break in it would break the subject (a server error before)."""
    return " ".join("".join(" " if unicodedata.category(char) in {"Cc", "Zl", "Zp"} else char for char in text).split())


def deliver_letter(db: Session, letter: object) -> None:
    """A letter of the post module at once (``MailError`` when it did not go out), through ``_send``; the result
    goes to the operator's mail card."""
    from ..vendor import nexpost
    from .post_store import PostStore

    store = PostStore(db)
    settings = store.mail_settings()
    if not settings.configured:
        raise MailError("mail_off", "No mail server is set up.")
    try:
        message = nexpost.send.message(settings, letter)  # type: ignore[arg-type]
        _send(db, message)
    except (MailError, nexpost.MailError) as exc:
        nexpost.outbox._note(store, ok=False, error=getattr(exc, "code", "mail_failed"))
        db.commit()
        raise MailError("mail_off" if getattr(exc, "code", "") == "mail_off" else "mail_failed",
                        "The mail server did not take the mail.") from exc
    nexpost.outbox._note(store, ok=True)
    db.commit()


def send_invite(db: Session, to: str, link: str, *, by: str, space: str | None, language: str = "en",
                days: int = 0) -> None:
    """The invitation, at once: the shared post module's letter (logo, text and HTML) in the receiver's language,
    naming the space it leads into."""
    from ..vendor import nexpost

    values: dict[str, object] = {"by": _one_line(by),
                                 "valid": nexpost.letters.validity(language, days=days) if days else ""}
    if space:
        values["space"] = _one_line(space)
    try:
        letter = nexpost.letters.compose("invite", to, language=language, values=values, link=link)
    except nexpost.MailError as exc:
        raise MailError("invalid_email", "This is not a mail address.") from exc
    deliver_letter(db, letter)


def send_test(db: Session, to: str, language: str = "en") -> None:
    from ..vendor import nexpost

    try:
        letter = nexpost.letters.compose("test", to, language=language, values={})
    except nexpost.MailError as exc:
        raise MailError("invalid_email", "This is not a mail address.") from exc
    deliver_letter(db, letter)
