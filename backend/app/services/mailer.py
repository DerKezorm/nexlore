"""Invitation mail through the operator's SMTP server.

Off until the operator enters a server: the link to copy is always enough. Nothing else is ever mailed. The mail
is English like everything nexlore sends out; it names who invites and into which space, and carries the link.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from sqlalchemy.orm import Session

from ..security import decrypt_secret
from . import settings_service

logger = logging.getLogger("nexlore.mail")

TIMEOUT = 15
SECURITY = ("starttls", "tls", "none")


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
    message["From"] = str(values["smtp_from"])
    message["Message-ID"] = make_msgid(domain=str(values["smtp_from"]).rpartition("@")[2] or None)
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
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        # The reason goes to the log by its kind only: an SMTP answer can quote the address or the credentials.
        logger.warning("Mail not sent host=%s reason=%s", host, type(exc).__name__)
        raise MailError("mail_failed", "The mail server did not take the mail.") from exc
    logger.info("Mail sent host=%s", host)


def send_invite(db: Session, to: str, link: str, *, by: str, space: str | None) -> None:
    message = EmailMessage()
    message["To"] = to
    where = f' to the space "{space}"' if space else ""
    message["Subject"] = f"{by} invites you to nexlore"
    message.set_content(
        f"{by} invites you{where} on nexlore, a place for notes.\n\n"
        f"Open this link to accept:\n{link}\n\n"
        "The link works once and runs out after a while. If you did not expect this mail, ignore it.\n"
    )
    _send(db, message)


def send_test(db: Session, to: str) -> None:
    message = EmailMessage()
    message["To"] = formataddr(("", to))
    message["Subject"] = "nexlore test mail"
    message.set_content("The mail server in nexlore works.\n")
    _send(db, message)
