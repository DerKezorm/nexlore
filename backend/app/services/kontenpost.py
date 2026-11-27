"""Every system mail of nexlore goes through the shared post module (post 1.1.0); nexlore's own mailer is gone. This
file builds what post needs from nexlore's data:

- the mails of the shared account module (``nexkonten.Mail``): the link from the public address and the token, into
  the outbox (``queue``) or at once (``deliver_now``, "Forgot your password?");
- the invitation (``send_invite``) and the operator's test mail (``send_test``), at once: the person sees the server's
  answer;
- the language of a mail: the account's language, else its browser's at the last sign-in, else the first operator's,
  else English (``language_for``).

A letter put into the outbox goes out right after the commit (the module's ``outbox_runner``); the minute loop in
``main`` only tries again what did not go out.
"""

from __future__ import annotations

import logging
import re
import unicodedata

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account
from ..vendor import nexgeraete, nexkonten, nexpost
from ..vendor.nexpost import MailError
from . import settings_service
from .post_store import PostStore

logger = logging.getLogger("nexlore.mail")

__all__ = [
    "MailError", "can_mail", "configured", "deliver_now", "language_for", "link_for", "mail_language",
    "note_browser_language", "queue", "queue_device", "send_invite", "send_test",
]

#: Where each link leads in the interface.
PAGES = {
    nexkonten.MAIL_RESET: "/reset/",
    nexkonten.MAIL_CONFIRM_EMAIL: "/email/",
}
#: The page Security, the button "See signed-in devices" of the mail about a new sign-in (post 1.0.0).
SECURITY_PAGE = "/settings/security"
#: The languages nexlore writes mail in (the shared post module has the texts); any other gets English.
MAIL_LANGUAGES = ("de", "en", "fr")
#: The first language of an ``Accept-Language`` header: ``de`` from ``de-DE,de;q=0.9,en;q=0.8``.
_FIRST_LANGUAGE = re.compile(r"\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*\s*(?:[;,]|$)")


def configured(db: Session) -> bool:
    """A mail server is set up (a host and a sender)."""
    values = settings_service.get_all(db)
    return bool(values["smtp_host"] and values["smtp_from"])


def can_mail(db: Session) -> bool:
    """A mail server and the public address (a link in a mail never points anywhere a request made up)."""
    return configured(db) and bool(settings_service.public_url(db))


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


def link_for(db: Session, mail: nexkonten.Mail) -> str:
    if mail.kind == nexkonten.MAIL_NEW_SIGN_IN:
        base = settings_service.public_url(db)
        return f"{base}{SECURITY_PAGE}" if base else ""
    page = PAGES.get(mail.kind)
    if not page or not mail.token:
        return ""
    return f"{settings_service.public_url(db)}{page}{mail.token}"


def _account_of(db: Session, mail: nexkonten.Mail) -> Account | None:
    return db.get(Account, int(mail.account_id)) if str(mail.account_id).isdigit() else None


def deliver_now(db: Session, mail: nexkonten.Mail) -> None:
    """At once through the mail server, never through the outbox ("Forgot your password?", konten 0.3.10): raises
    ``MailError`` when the mail did not go out, and the module then takes the link back, so that no link stays behind
    that nobody got."""
    if not configured(db):
        raise MailError("mail_off", "No mail server is set up.")
    letter = nexpost.letters.from_account_mail(mail, language=language_for(db, _account_of(db, mail)),
                                               link=link_for(db, mail))
    nexpost.outbox.deliver_now(PostStore(db), letter)


def queue(db: Session, mail: nexkonten.Mail | None, *, by: str = "", where: str = "", days: int = 0) -> bool:
    """Into the outbox (committed here, out right after); False when nothing went in (no mail, no server, an address
    the post module refuses)."""
    if mail is None or not configured(db):
        return False
    try:
        letter = nexpost.letters.from_account_mail(mail, language=language_for(db, _account_of(db, mail)),
                                                   link=link_for(db, mail), by=by, where=where, days=days)
    except (MailError, ValueError) as exc:
        logger.warning("Mail not queued kind=%s reason=%s", mail.kind, type(exc).__name__)
        return False
    nexpost.outbox.queue(PostStore(db), letter)
    db.commit()
    return True


def queue_device(db: Session, mail: nexkonten.Mail | None, device: nexgeraete.Device) -> bool:
    """The mail "A new sign-in" for a newly paired device, into the outbox like ``queue`` (geraete G29, G50): the
    module's ``notices.letter`` names the device ("“Kim's iPhone” (iPhone 16 Pro)") where a browser's sign-in names
    the browser; ``from_account_mail`` reads a User-Agent and would leave the device out."""
    if mail is None or not configured(db):
        return False
    try:
        letter = nexgeraete.notices.letter(nexpost.letters, mail, device,
                                           language=language_for(db, _account_of(db, mail)), link=link_for(db, mail))
    except (MailError, ValueError) as exc:
        logger.warning("Mail not queued kind=%s reason=%s", mail.kind, type(exc).__name__)
        return False
    nexpost.outbox.queue(PostStore(db), letter)
    db.commit()
    return True


def _one_line(text: str) -> str:
    """A name in a mail stays one line: a line break in it would break the subject (a server error before)."""
    return " ".join("".join(" " if unicodedata.category(char) in {"Cc", "Zl", "Zp"} else char for char in text).split())


def send_invite(db: Session, to: str, link: str, *, by: str, space: str | None, language: str = "en",
                days: int = 0, member: bool = False) -> None:
    """The invitation, at once: the shared post module's letter (logo, text and HTML) in the receiver's language,
    naming the space it leads into; ``member``: the address belongs to an account already, which joins with it (post
    1.0.0). ``MailError`` when it did not go out (``invalid_email`` for an address post refuses)."""
    values: dict[str, object] = {"by": _one_line(by),
                                 "valid": nexpost.letters.validity(language, days=days) if days else ""}
    if space:
        values["space"] = _one_line(space)
        if member:
            values["member"] = "yes"
    try:
        letter = nexpost.letters.compose("invite", to, language=language, values=values, link=link)
    except MailError as exc:
        raise MailError("invalid_email", "This is not a mail address.") from exc
    nexpost.outbox.deliver_now(PostStore(db), letter)


def send_test(db: Session, to: str, language: str = "en") -> None:
    """The operator's test mail of the post module (the same in every app, nexlore's logo), at once."""
    nexpost.outbox.test_mail(PostStore(db), to, language=language)
