"""Accounts: the first is the operator, the others come by invitation or through OIDC.

An invitation is a link with an end date. It may name a space and a right in it: whoever follows it gets an account
(when they have none yet) and that right. Signed in already, following it only adds the right. Every account may
invite into the spaces it manages; the operator also invites into nexlore without a space.

After nextrmnl's accounts: the name is checked before the password, and an unknown name costs the same time as a
wrong password, so that neither answer nor timing tells which names exist.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import timedelta
from functools import lru_cache

from sqlalchemy import delete, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from ..models import (
    MANAGE,
    MEMBER,
    OPERATOR,
    ROLES,
    SIGN_IN_OIDC,
    SIGN_IN_PASSWORD,
    SPACE_ROLES,
    Account,
    Invite,
    Membership,
    utcnow,
)
from ..security import LOCK_MINUTES, MAX_FAILURES, hash_password, hash_token, verify_password

logger = logging.getLogger("nexlore.auth")

NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
#: Enough to catch a typo, not a validation of the address: the mail server has the last word.
EMAIL_PATTERN = re.compile(r"^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$")
#: How long an invitation may run, in days; the one who invites picks within this.
INVITE_DAYS = (1, 7, 30)


class AccountError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(Account)) or 0)


def by_name(db: Session, name: str) -> Account | None:
    return db.scalar(select(Account).where(Account.name == name.strip().lower()))


def check_name(db: Session, name: str) -> str:
    cleaned = name.strip().lower()
    if not NAME_PATTERN.match(cleaned):
        raise AccountError("invalid_name", "Use 2 to 64 letters, digits, dots, dashes or underscores.", 422)
    if by_name(db, cleaned) is not None:
        raise AccountError("name_taken", "This name is already taken.", 409)
    return cleaned


def create_with_password(db: Session, name: str, password: str, role: str = MEMBER, *, commit: bool = True) -> Account:
    if role not in ROLES:
        raise ValueError("unknown role")
    account = Account(
        name=check_name(db, name), role=role, sign_in=SIGN_IN_PASSWORD, password_hash=hash_password(password)
    )
    db.add(account)
    if commit:
        db.commit()
    else:
        db.flush()
    logger.info("Account created name=%s role=%s sign_in=password", account.name, role)
    return account


def create_operator(db: Session, name: str, password: str) -> Account:
    if count(db) > 0:
        raise AccountError("already_set_up", "nexlore is already set up.", 409)
    return create_with_password(db, name, password, OPERATOR)


def create_oidc(db: Session, name: str, subject: str, email: str) -> Account:
    base = re.sub(r"[^a-z0-9._-]", "-", name.strip().lower()).strip("-._") or "user"
    candidate = base[:60]
    suffix = 1
    while by_name(db, candidate) is not None or not NAME_PATTERN.match(candidate):
        suffix += 1
        candidate = f"{base[:57]}-{suffix}"
    account = Account(name=candidate, role=MEMBER, sign_in=SIGN_IN_OIDC, oidc_subject=subject, email=email)
    db.add(account)
    db.commit()
    logger.info("Account created name=%s role=%s sign_in=oidc", account.name, MEMBER)
    return account


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """A hash to verify against for an unknown name: the answer takes as long as for a wrong password."""
    return hash_password(secrets.token_urlsafe(24))


def is_locked(account: Account) -> bool:
    return account.locked_until is not None and account.locked_until > utcnow()


def note_failure(db: Session, account: Account) -> None:
    """A wrong password: counted per account, locked after too many, whoever the sender is."""
    account.failed_logins += 1
    if account.failed_logins >= MAX_FAILURES:
        account.locked_until = utcnow() + timedelta(minutes=LOCK_MINUTES)
        account.failed_logins = 0
        logger.warning("Account locked after %s failures name=%s minutes=%s", MAX_FAILURES, account.name, LOCK_MINUTES)
    else:
        logger.warning(
            "Check failed name=%s (%s of %s before lockout)", account.name, account.failed_logins, MAX_FAILURES
        )
    db.commit()


def note_success(db: Session, account: Account) -> None:
    account.failed_logins = 0
    account.locked_until = None
    account.last_seen_at = utcnow()
    db.commit()


def authenticate(db: Session, name: str, password: str) -> Account:
    """Checks name and password; counts failures and locks the account after too many."""
    account = by_name(db, name)
    if account is None or account.sign_in != SIGN_IN_PASSWORD:
        verify_password(password, _dummy_hash())
        logger.warning("Sign-in failed for an unknown account")
        raise AccountError("wrong_credentials", "Name or password is wrong.", 401)
    if is_locked(account):
        logger.warning("Sign-in refused, account locked name=%s", account.name)
        raise AccountError("account_locked", "Too many failed sign-ins. Try again later.", 429)
    if not verify_password(password, account.password_hash):
        note_failure(db, account)
        raise AccountError("wrong_credentials", "Name or password is wrong.", 401)
    note_success(db, account)
    return account


def check_password(account: Account, password: str) -> bool:
    return account.sign_in == SIGN_IN_PASSWORD and verify_password(password, account.password_hash)


def change_password(db: Session, account: Account, current: str, new: str) -> None:
    if not verify_password(current, account.password_hash):
        raise AccountError("wrong_password", "The current password is wrong.", 401)
    account.password_hash = hash_password(new)
    db.commit()
    logger.info("Password changed name=%s", account.name)


def set_password(db: Session, account: Account, new: str) -> None:
    """The operator gives an account a new password (it forgot its own); it signs in with a password from now on."""
    account.password_hash = hash_password(new)
    account.sign_in = SIGN_IN_PASSWORD
    account.failed_logins = 0
    account.locked_until = None
    db.commit()
    logger.info("Password set by the operator name=%s", account.name)


# --- Invitations ---------------------------------------------------------------------------------------------------


def create_invite(
    db: Session, by: Account, *, space_id: int | None, space_role: str, days: int, email: str = ""
) -> tuple[Invite, str]:
    if days not in INVITE_DAYS:
        raise AccountError("invalid_days", "Choose 1, 7 or 30 days.", 422)
    if space_id is None and space_role:
        raise AccountError("invalid_role", "A right needs a space.", 422)
    if space_id is not None and space_role not in SPACE_ROLES:
        raise AccountError("invalid_role", "Unknown right.", 422)
    token = secrets.token_urlsafe(24)
    invite = Invite(
        token_hash=hash_token(token), space_id=space_id, space_role=space_role, email=email.strip()[:255],
        created_by=by.id, expires_at=utcnow() + timedelta(days=days),
    )
    db.add(invite)
    db.commit()
    logger.info("Invite created by=%s space_id=%s role=%s", by.name, space_id, space_role or "-")
    return invite, token


def expired(invite: Invite) -> bool:
    return invite.expires_at <= utcnow()


def find_invite(db: Session, token: str) -> Invite | None:
    """A usable invitation: not run out, and into a space only while the one who made it still manages the space
    (a manager who lost the right must not keep bringing people in with an old link)."""
    from . import rights

    invite = db.scalar(select(Invite).where(Invite.token_hash == hash_token(token)))
    if invite is None or invite.expires_at <= utcnow():
        return None
    if invite.space_id is not None:
        creator = db.get(Account, invite.created_by) if invite.created_by else None
        if creator is None or not rights.at_least(rights.role_in(db, creator, invite.space_id), MANAGE):
            return None
    return invite


def consume(db: Session, invite: Invite) -> bool:
    """Takes the invitation away, in the open transaction; False when another request took it first. Of two requests
    at the same moment the database lets exactly one delete the row, so a link is used once whatever the timing."""
    try:
        return int(db.execute(delete(Invite).where(Invite.id == invite.id)).rowcount or 0) == 1
    except OperationalError:
        db.rollback()
        return False


def grant(db: Session, account: Account, space_id: int, role: str) -> None:
    """Gives an account a right in a space; a right it has already is only ever raised, never lowered, this way."""
    membership = db.get(Membership, (space_id, account.id))
    if membership is None:
        db.add(Membership(space_id=space_id, account_id=account.id, role=role))
    elif SPACE_ROLES.index(role) > SPACE_ROLES.index(membership.role):
        membership.role = role


def redeem(db: Session, invite: Invite, account: Account, *, consumed: bool = False) -> None:
    """The invitation is used: it goes first (``consume``), then its right goes to the account. Into a space without
    members (the operator's, from the disk) the one who invited comes along as manager: with a first member the
    space would otherwise stop being theirs at the very moment they share it."""
    if not consumed and not consume(db, invite):
        db.rollback()
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    if invite.space_id is not None and invite.space_role:
        members = db.scalar(select(func.count()).select_from(Membership).where(Membership.space_id == invite.space_id))
        inviter = db.get(Account, invite.created_by) if invite.created_by else None
        if not members and inviter is not None and inviter.id != account.id:
            grant(db, inviter, invite.space_id, MANAGE)
        grant(db, account, invite.space_id, invite.space_role)
    db.commit()
    logger.info("Invite used name=%s space_id=%s", account.name, invite.space_id)


def accept_invite(db: Session, token: str, name: str, password: str) -> Account:
    invite = find_invite(db, token)
    if invite is None:
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    check_name(db, name)
    # The invitation goes before the account comes, in one transaction: two requests with the same link at the same
    # moment make one account, not two.
    if not consume(db, invite):
        db.rollback()
        raise AccountError("invite_invalid", "This invitation is not valid any more.", 404)
    try:
        account = create_with_password(db, name, password, commit=False)
    except AccountError:
        db.rollback()
        raise
    if invite.email and not account.email:
        account.email = invite.email
    redeem(db, invite, account, consumed=True)
    return account


def invites_of(db: Session, *, space_id: int | None, all_spaces: bool = False) -> list[Invite]:
    query = select(Invite).where(Invite.expires_at > utcnow())
    if not all_spaces:
        query = query.where(Invite.space_id.is_(None) if space_id is None else Invite.space_id == space_id)
    return list(db.scalars(query.order_by(Invite.created_at)))
