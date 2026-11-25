"""A mail address for each account (issue #13), since the shared account module (``vendor/nexkonten``) through its
profile functions: entered in the profile (with the password; with a mail server it waits for its link), from an
invitation, or from the provider.

What stays here is nexlore's own: where an address came from (``email_source``: ``own``, ``operator``, ``invite``,
``provider``; the operator no longer sets one, addresses of 1.16.0 keep their source), the shape check, and what an
unlinked account loses. The address never finds an account at a sign-in through a provider: only the identity there
does (``oidc_links``). No two accounts hold the same address.
"""

from __future__ import annotations

import logging
import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session, object_session

from ..models import SIGN_IN_OIDC, Account, OidcLink
from . import mailer, settings_service

logger = logging.getLogger("nexlore.email")

OWN = "own"
OPERATOR = "operator"
INVITE = "invite"
PROVIDER = "provider"
MAX_LENGTH = 254

_SHAPE = re.compile(r"^[^@\s<>()\[\]\\,;:\"]+@[^@\s<>()\[\]\\,;:\"]+\.[^@\s<>()\[\]\\,;:\".]+$")


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


def linked(account: Account, db: Session | None = None) -> bool:
    """The account is linked to at least one sign-in provider."""
    db = db or object_session(account)
    if db is None or account.id is None:
        return False
    return db.scalar(select(OidcLink.id).where(OidcLink.account_id == account.id).limit(1)) is not None


def source_of(account: Account) -> str:
    """Where the address came from; addresses from before the source was kept came from the provider (linked or
    provider only) or from an invitation, the only two ways there were."""
    if not account.email:
        return ""
    if account.email_source:
        return account.email_source
    return PROVIDER if account.sign_in == SIGN_IN_OIDC or linked(account) or account.oidc_subject else INVITE


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


def unlinked(account: Account) -> None:
    """The last link to a provider is gone: so is an address that came from there. An own address stays."""
    if source_of(account) == PROVIDER:
        account.email = ""
        account.email_source = ""
        account.email_confirmed = True
        account.email_proven = False
    account.provider_email = ""
    account.provider_email_from = ""
    account.provider_email_off = ""


def _masked(address: str) -> str:
    local, _, domain = address.partition("@")
    return f"{local[:2]}***@{domain}" if domain else f"{local[:2]}***"
