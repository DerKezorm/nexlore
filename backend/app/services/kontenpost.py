"""The mails of the shared account module, through the shared post module: the account module says what to send
(``nexkonten.Mail``), this builds the link from the public address and the token and puts the letter into the outbox
(``services/post_store.py``). The language is the account's, else its browser's at the last sign-in, else the first
operator's, else English (``mailer.language_for``).

A letter put into the outbox goes out at once in a thread of its own (``nudge``): the person waits for a confirmation
link, as 1.16.0 sent it at once; the minute loop in ``main`` only tries again what did not go out.
"""

from __future__ import annotations

import logging
import threading

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Account
from ..vendor import nexkonten, nexpost
from . import mailer, settings_service
from .post_store import PostStore

logger = logging.getLogger("nexlore.mail")

#: Where each link leads in the interface.
PAGES = {
    nexkonten.MAIL_RESET: "/reset/",
    nexkonten.MAIL_CONFIRM_EMAIL: "/email/",
}
#: The page Security, the button "See signed-in devices" of the mail about a new sign-in (post 1.0.0).
SECURITY_PAGE = "/settings/security"


def link_for(db: Session, mail: nexkonten.Mail) -> str:
    if mail.kind == nexkonten.MAIL_NEW_SIGN_IN:
        base = settings_service.public_url(db)
        return f"{base}{SECURITY_PAGE}" if base else ""
    page = PAGES.get(mail.kind)
    if not page or not mail.token:
        return ""
    return f"{settings_service.public_url(db)}{page}{mail.token}"


def can_mail(db: Session) -> bool:
    """A mail server and the public address (a link in a mail never points anywhere a request made up)."""
    return mailer.configured(db) and bool(settings_service.public_url(db))


def deliver_now(db: Session, mail: nexkonten.Mail) -> None:
    """At once through the mail server, never through the outbox ("Forgot your password?", konten 0.3.10): raises
    when the mail did not go out (``mailer.MailError``, ``nexpost.MailError``), and the module then takes the link
    back, so that no link stays behind that nobody got."""
    if not mailer.configured(db):
        raise mailer.MailError("mail_off", "No mail server is set up.")
    account = db.get(Account, int(mail.account_id)) if str(mail.account_id).isdigit() else None
    letter = nexpost.letters.from_account_mail(mail, language=mailer.language_for(db, account), link=link_for(db, mail))
    mailer.deliver_letter(db, letter)


def queue(db: Session, mail: nexkonten.Mail | None, *, by: str = "", where: str = "", days: int = 0) -> bool:
    """Into the outbox (committed here); False when nothing went in (no mail, no server, an address the post module
    refuses)."""
    if mail is None or not mailer.configured(db):
        return False
    account = db.get(Account, int(mail.account_id)) if str(mail.account_id).isdigit() else None
    language = mailer.language_for(db, account)
    try:
        letter = nexpost.letters.from_account_mail(mail, language=language, link=link_for(db, mail), by=by,
                                                   where=where, days=days)
    except (nexpost.MailError, ValueError) as exc:
        logger.warning("Mail not queued kind=%s reason=%s", mail.kind, type(exc).__name__)
        return False
    nexpost.outbox.queue(PostStore(db), letter)
    db.commit()
    nudge()
    return True


def nudge() -> None:
    """The outbox goes out now, in a thread (SMTP blocks), instead of at the next round of the minute loop. Only where
    the background work runs at all (not in the tests, which read the outbox)."""
    if get_settings().disable_background:
        return
    from .post_store import run_due

    def work() -> None:
        try:
            run_due()
        except Exception:
            logger.exception("Outbox round failed")

    threading.Thread(target=work, name="nexlore-outbox", daemon=True).start()
