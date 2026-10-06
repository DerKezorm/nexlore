"""A mail address for each account (issue #13): entered in the profile, set by the operator, or from the provider.

The address that counts (``Account.email``) is mailed and bridges a first sign-in through the provider to the account
(``routers/oidc._resolve``: a verified address there links an account with the same address). So an address an account
enters for itself counts only once its link was opened: otherwise anybody could write somebody else's address into
their own account and catch that person's first sign-in through the provider. Until then it waits in
``email_pending``; an address confirmed before stays in force meanwhile.

The operator's address counts at once (the operator can set passwords anyway); the account is told under "New". An
account that signs in through the provider only follows the provider at every sign-in and cannot change it here. An
account with a password that is linked keeps its own address; a different one at the provider is offered in the
profile, never taken unasked. No two accounts hold the same address: the bridge must point to one.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
import threading
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import SIGN_IN_OIDC, Account, SpaceNotice
from . import mailer, settings_service

logger = logging.getLogger("nexlore.email")

OWN = "own"
OPERATOR = "operator"
INVITE = "invite"
PROVIDER = "provider"
#: How long the link in the mail works.
LINK_HOURS = 24
#: Mails one account may cause in an hour (a confirmation goes to any address typed in: no relay for spam).
SENDS_PER_HOUR = 5
MAX_LENGTH = 254
TOKEN_PREFIX = "nxe_"
#: What the operator did to an account's address, for its notices under "New".
NOTICE_SET = "operator_email"
NOTICE_REMOVED = "operator_email_removed"

_SHAPE = re.compile(r"^[^@\s<>()\[\]\\,;:\"]+@[^@\s<>()\[\]\\,;:\"]+\.[^@\s<>()\[\]\\,;:\".]+$")
_sends: dict[int, deque[float]] = {}
_sends_lock = threading.Lock()


class AddressError(Exception):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def clean(address: str) -> str:
    """The address as typed, without the blanks around it; refused when it cannot be one."""
    address = address.strip()
    if (
        not address
        or len(address) > MAX_LENGTH
        or any(ord(char) < 32 or ord(char) == 127 for char in address)
        or not _SHAPE.match(address)
    ):
        raise AddressError("email_invalid", "This is not a mail address.", 422)
    return address


def same(one: str, other: str) -> bool:
    return bool(one) and one.casefold() == other.casefold()


def source_of(account: Account) -> str:
    """Where the address came from; addresses from before the source was kept came from the provider (linked or
    provider only) or from an invitation, the only two ways there were."""
    if not account.email:
        return ""
    if account.email_source:
        return account.email_source
    return PROVIDER if account.oidc_subject or account.sign_in == SIGN_IN_OIDC else INVITE


def taken(db: Session, address: str, but: int) -> bool:
    """Another account holds this address (any case)."""
    return db.scalar(
        select(Account.id).where(func.lower(Account.email) == address.lower(), Account.id != but).limit(1)
    ) is not None


def cannot_mail(db: Session) -> str:
    """Why no confirmation can go out, as an error code, or empty when it can."""
    if not mailer.configured(db):
        return "mail_off"
    if not settings_service.public_url(db):
        # A link in a mail never points to an address the request made up (the same rule as for invitations).
        return "public_url_missing"
    return ""


def pending_of(account: Account, now: datetime | None = None) -> str:
    until = account.email_pending_until
    if not account.email_pending or until is None:
        return ""
    if until.tzinfo is None:
        until = until.replace(tzinfo=UTC)
    return account.email_pending if until > (now or datetime.now(UTC)) else ""


def offer_of(account: Account) -> str:
    """The provider's address, offered in the profile: only for a linked account with a password whose own address
    differs, and not when the account said no to exactly this one."""
    offered = account.provider_email
    if (
        not offered
        or not account.oidc_subject
        or account.sign_in == SIGN_IN_OIDC
        or same(offered, account.email)
        or same(offered, account.provider_email_off)
    ):
        return ""
    return offered


def view(account: Account) -> dict[str, str]:
    return {
        "email": account.email,
        "email_source": source_of(account),
        "email_pending": pending_of(account),
        "provider_email": offer_of(account),
    }


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _brake(account_id: int) -> None:
    now = time.monotonic()
    with _sends_lock:
        sent = _sends.setdefault(account_id, deque())
        while sent and now - sent[0] > 3600:
            sent.popleft()
        if len(sent) >= SENDS_PER_HOUR:
            raise AddressError("email_too_many", "Too many mails in an hour; try again later.", 429)
        sent.append(now)


def forget_sends() -> None:
    """For tests: the brake starts empty."""
    with _sends_lock:
        _sends.clear()


def _clear_pending(account: Account) -> None:
    account.email_pending = ""
    account.email_pending_hash = ""
    account.email_pending_until = None


def request(db: Session, account: Account, address: str) -> bool:
    """The address entered in the profile: a link goes to it, and it counts once that is opened. Returns False when
    it is the address the account has already (nothing waits then, nothing is sent)."""
    if account.sign_in == SIGN_IN_OIDC:
        raise AddressError("email_from_provider", "The address comes from the sign-in provider; change it there.", 409)
    address = clean(address)
    if same(address, account.email):
        _clear_pending(account)
        db.commit()
        return False
    reason = cannot_mail(db)
    if reason:
        raise AddressError(reason, "nexlore cannot send mail yet.", 409)
    _brake(account.id)
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    account.email_pending = address
    account.email_pending_hash = _hash(token)
    account.email_pending_until = datetime.now(UTC) + timedelta(hours=LINK_HOURS)
    db.commit()
    link = f"{settings_service.public_url(db)}/confirm-email/{token}"
    try:
        mailer.send_confirm(db, address, link, name=account.display_name or account.name)
    except mailer.MailError as exc:
        # Not sent, nothing waits: the profile shows the address that counts, not one nobody can confirm.
        _clear_pending(account)
        db.commit()
        raise AddressError(exc.code, "The mail server did not take the mail.", 502) from exc
    logger.info("Address confirmation sent name=%s address=%s", account.name, _masked(address))
    return True


def resend(db: Session, account: Account) -> None:
    waiting = pending_of(account)
    if not waiting:
        raise AddressError("email_nothing_waits", "No address waits for its confirmation.", 404)
    request(db, account, waiting)


def cancel(db: Session, account: Account) -> None:
    _clear_pending(account)
    db.commit()


def confirm(db: Session, token: str) -> Account:
    """The link from the mail was opened: the waiting address counts from now on. Works without being signed in
    (the link is the proof); used once, or late, it does nothing."""
    if not token.startswith(TOKEN_PREFIX) or len(token) > 100:
        raise AddressError("email_link_invalid", "This link does not work any more.", 404)
    account = db.scalar(select(Account).where(Account.email_pending_hash == _hash(token)))
    if account is None or not pending_of(account):
        raise AddressError("email_link_invalid", "This link does not work any more.", 404)
    address = account.email_pending
    _clear_pending(account)
    if taken(db, address, account.id):
        db.commit()
        logger.warning("Address confirmation refused, another account has it name=%s address=%s",
                       account.name, _masked(address))
        raise AddressError("email_taken", "Another account has this address already.", 409)
    account.email = address
    account.email_source = OWN
    db.commit()
    logger.info("Address confirmed name=%s address=%s", account.name, _masked(address))
    return account


def remove(db: Session, account: Account) -> None:
    if account.sign_in == SIGN_IN_OIDC:
        raise AddressError("email_from_provider", "The address comes from the sign-in provider; change it there.", 409)
    account.email = ""
    account.email_source = ""
    _clear_pending(account)
    db.commit()
    logger.info("Address removed name=%s", account.name)


def take_offer(db: Session, account: Account) -> None:
    """The provider's address instead of the own one (the provider confirmed it, so no mail)."""
    offered = offer_of(account)
    if not offered:
        raise AddressError("email_no_offer", "The provider reports no other address.", 404)
    if taken(db, offered, account.id):
        raise AddressError("email_taken", "Another account has this address already.", 409)
    account.email = offered
    account.email_source = PROVIDER
    _clear_pending(account)
    db.commit()
    logger.info("Address taken from the provider name=%s", account.name)


def decline_offer(db: Session, account: Account) -> None:
    account.provider_email_off = account.provider_email
    db.commit()


def set_by_operator(db: Session, target: Account, address: str, operator: Account) -> None:
    """The operator's address counts at once; empty removes it. The account learns it under "New"."""
    if target.sign_in == SIGN_IN_OIDC:
        raise AddressError("email_from_provider", "The address comes from the sign-in provider; change it there.", 409)
    address = clean(address) if address.strip() else ""
    if address and taken(db, address, target.id):
        raise AddressError("email_taken", "Another account has this address already.", 409)
    if address == target.email:
        return
    target.email = address
    target.email_source = OPERATOR if address else ""
    _clear_pending(target)
    if target.id != operator.id:
        db.add(SpaceNotice(account_id=target.id, space_id=None, space_name="",
                           kind=NOTICE_SET if address else NOTICE_REMOVED, actor=operator.name,
                           actor_id=operator.id, subject=address))
    db.commit()
    logger.warning("Address %s by the operator name=%s by=%s", "set" if address else "removed", target.name,
                   operator.name)


def from_provider(db: Session, account: Account, address: str, verified: bool) -> None:
    """What the provider says at a sign-in or a link (the caller commits). Only a verified address counts: an
    account through the provider only follows it; a linked account with a password takes it only when it has none,
    otherwise it is offered in the profile."""
    if not (address and verified):
        return
    try:
        address = clean(address)
    except AddressError:
        return
    account.provider_email = address
    if same(address, account.email):
        return
    if account.sign_in != SIGN_IN_OIDC and account.email:
        return
    if taken(db, address, account.id):
        logger.warning("Provider address not taken, another account has it name=%s address=%s",
                       account.name, _masked(address))
        return
    account.email = address
    account.email_source = PROVIDER


def unlinked(account: Account) -> None:
    """The link to the provider is gone: so is an address that came from there (left in place it would bridge the
    next sign-in there back into the account as if nothing had been undone). An own address stays: its owner
    confirmed it, and linking again by it would be their own doing."""
    if source_of(account) == PROVIDER:
        account.email = ""
        account.email_source = ""
    account.provider_email = ""
    account.provider_email_off = ""


def _masked(address: str) -> str:
    local, _, domain = address.partition("@")
    return f"{local[:2]}***@{domain}" if domain else f"{local[:2]}***"
