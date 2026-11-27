"""nexlore's side of the shared account module ``vendor/nexkonten``: the ``Store`` over its tables.

The module runs setup, invitations, signing in with a password, the profile, a forgotten password, the second
factor, passkeys and sessions the same in every nex app; it never sees a database and asks through a ``Store``, which
is this one, over ``accounts``, ``invites``, ``auth_sessions``, ``app_devices``, ``api_tokens``, ``mcp_keys`` and the
tables of ``models_accounts``. One instance works inside one SQLAlchemy session (one request); the module commits when
an outcome is settled and rolls back when it refuses after a write.

⚠️ **The columns keep their names.** ``accounts.name`` is the module's ``username`` (and the field ``name`` of every
route), the address is ``email``, an address waiting for its link stays in ``email_pending*`` as in 1.16.0 (an open
link of 1.16.0 keeps working). What the module needs beyond 1.16.0 came on top (``models.py``, ``models_accounts.py``,
``services/konten_wanderung.py``).

⚠️ **The username is a key in nexlore.** Versions, uploads, comments, moves and notices keep the name of who did them
as text (``konten_wanderung.NAME_COLUMNS``). A new username carries all of it along in the same transaction
(``set_username``), and the old name stays reserved for ever (``former_names``): nobody inherits another person's
history, used storage or mentions.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..models import (
    MEMBER,
    OPERATOR,
    SESSION_VIA_PASSWORD,
    SESSION_VIA_PROVIDER,
    SIGN_IN_OIDC,
    SIGN_IN_PASSWORD,
    Account,
    ApiToken,
    AppDevice,
    AppPairing,
    AuthSession,
    McpKey,
    OidcProvider,
    utcnow,
)
from ..models import Invite as InviteRow
from ..models_accounts import FailedUnknown, FormerName, PasswordReset, SetupClaim
from ..models_accounts import Passkey as PasskeyRow
from ..security import (
    LOCK_MINUTES,
    MAX_FAILURES,
    decrypt_secret,
    encrypt_secret,
    end_all_sessions,
    hash_password,
    hash_token,
    server_key,
    verify_password,
)
from ..vendor import nexkonten
from ..vendor.nexkonten import (
    Access,
    AccountId,
    EmailChange,
    Event,
    Invite,
    NewAccount,
    Picture,
    Reset,
    Taken,
    names,
)
from ..vendor.nexkonten import Account as KontoAccount
from ..vendor.nexkonten.model2 import KIND_BROWSER, KIND_DEVICE, KIND_WAITING, STAGE_FULL
from ..vendor.nexkonten.model2 import Passkey as PasskeyData
from ..vendor.nexkonten.model2 import Session as SessionData
from .konten_wanderung import NAME_COLUMNS

logger = logging.getLogger("nexlore.auth")

#: Where an address came from, as 1.16.0 keeps it (``services/emailaddr``): ``own`` (typed, or confirmed by its
#: link), ``operator``, ``invite``, ``provider``. The module knows ``""`` (own) and ``provider``.
OWN = "own"
INVITE = "invite"
PROVIDER = "provider"
#: The operator's switches of part 2: "Require a second factor of everybody" was nexlore's ``two_factor_required``
#: already; "Passkeys allowed" is new and on from the start.
SWITCH_FACTOR_REQUIRED = "two_factor_required"
SWITCH_PASSKEYS = "passkeys_allowed"
#: The authenticator being set up is sealed apart from a confirmed one.
PENDING_TOTP_CONTEXT = "totp-pending"
#: A paired iPhone or iPad in the list "Signed-in devices": its uid is the device row's id with this mark in front.
DEVICE_UID = "device-"
#: The other ways in that stay after a new password, by their uid: ``api-<id>``, ``mcp-<id>``, ``calendar``.
API_UID, MCP_UID, CALENDAR_UID = "api-", "mcp-", "calendar"
#: Kinds of ``space_notices`` whose ``subject`` is the name of the account concerned.
NOTICE_KINDS_WITH_NAME = ("operator_added", "operator_role", "operator_removed")

#: The codes nexlore answered with before the module, for scripts, the iPhone app and pages of 1.16.0 (the module's
#: own names stay inside; ``AccountError.public_code`` answers with these). The page maps them back.
OLD_CODES = {
    "email_invalid": "invalid_email",
    "username_taken": "name_taken",
    "username_invalid": "invalid_name",
}


def configure() -> None:
    """The module knows nexlore's name, log and codes from now on. At import and by the tests."""
    nexkonten.configure(
        nexkonten.AppConfig(
            app_name="nexlore",
            # The setting, not only the environment: NEXLORE_SETUP_TOKEN may stand in a .env file.
            setup_token=lambda: get_settings().setup_token,
            logger_name="nexlore.auth",
            error_codes=OLD_CODES,
            # Before 1.1.0 nexlore looked dark for an account that had chosen nothing (E45): such an account takes
            # "dark" once at its next load (``adopt_theme``); new accounts start "as the system".
            theme_default_before="dark",
        )
    )


configure()


def theme_of(row: Account) -> str:
    """Light, dark or as the system, as the account chose it (``appearance.mode``); "" while it chose nothing."""
    look = row.appearance if isinstance(row.appearance, dict) else {}
    mode = look.get("mode")
    return mode if mode in nexkonten.profiles.THEMES else ""


def adopt_theme(db: Session, row: Account) -> None:
    """An account of before 1.1.0 that chose no look takes nexlore's look of before once (konten E45, ``dark``).
    nexlore always kept the choice at the account, never only in the browser, so no browser value counts here."""
    if theme_of(row) == "":
        taken = nexkonten.profiles.adopt_theme(KontenStore(db), row.id, None)
        row.appearance = {**(row.appearance if isinstance(row.appearance, dict) else {}), "mode": taken}


def new_device_key() -> str:
    return secrets.token_urlsafe(24)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


_DUMMY: str | None = None
_DUMMY_LOCK = threading.Lock()


def _dummy_hash() -> str:
    """What ``check_password`` verifies against when there is no account or no password: the answer takes as long
    as for a wrong password and tells nobody which names or addresses exist."""
    global _DUMMY
    with _DUMMY_LOCK:
        if _DUMMY is None:
            _DUMMY = hash_password(secrets.token_urlsafe(24))
    return _DUMMY


#: Whether the provider's picture is fetched in a thread of its own. Tests switch this off and do not wait.
PICTURE_IN_THREAD = True


def former_names_of(db: Session, account_id: int) -> list[str]:
    """The usernames the account had before, newest first."""
    return list(db.scalars(select(FormerName.name).where(FormerName.account_id == account_id)
                           .order_by(FormerName.id.desc())))


class KontenStore:
    """``nexkonten.Store`` and the stores of part 2 over nexlore's tables, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- Accounts ------------------------------------------------------------------------------------------------
    def _row(self, account_id: AccountId | None) -> Account | None:
        if account_id is None:
            return None
        try:
            return self.db.get(Account, int(account_id))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _waiting(row: Account) -> str:
        """The address that waits for its link (``email_pending``), while its link still works."""
        until = row.email_pending_until
        if not row.email_pending or until is None or _aware(until) <= utcnow():
            return ""
        return row.email_pending

    def _account(self, row: Account) -> KontoAccount:
        if row.avatar_at is None:
            picture = nexkonten.PICTURE_NONE
        else:
            picture = nexkonten.PICTURE_PROVIDER if row.avatar_source == PROVIDER else nexkonten.PICTURE_OWN
        offered = self._offered(row)
        return KontoAccount(
            id=row.id,
            username=row.name,
            display_name=row.display_name or "",
            email=row.email or "",
            email_confirmed=bool(row.email_confirmed) if row.email else True,
            email_proven=bool(row.email_proven),
            # The module knows "" (the account's own) and ``provider``; nexlore's own, operator and invitation
            # addresses are all the account's own to it.
            email_source=PROVIDER if (row.email and row.email_source == PROVIDER) else "",
            pending_email=self._waiting(row),
            has_password=row.sign_in == SIGN_IN_PASSWORD and bool(row.password_hash),
            blocked=row.blocked_at is not None or row.deleted_at is not None,
            operator=row.role == OPERATOR,
            picture=picture,
            language=row.language or "",
            offered_email=offered,
            offered_email_provider=(row.provider_email_from or "") if offered else "",
            # "No, thanks" of the module is nexlore's ``provider_email_off`` of 1.16.0: the same address stays
            # declined.
            declined_email=row.provider_email_off or "",
            password_changed_at=row.password_changed_at,
            blocked_at=row.blocked_at,
            deleted_at=row.deleted_at,
            theme=theme_of(row),
            storage_limit=row.storage_limit,
            rights=frozenset({"ai"} if row.ai_allowed else set()),
        )

    @staticmethod
    def _offered(row: Account) -> str:
        """The provider's address on offer (``provider_email``): not the own one, not one the account declined."""
        offer = row.provider_email or ""
        if not offer or (row.email and row.email.lower() == offer.lower()):
            return ""
        if row.provider_email_off and row.provider_email_off.lower() == offer.lower():
            return ""
        return offer

    def set_offered_email(self, account_id: AccountId, address: str, provider: str = "") -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.provider_email = address
        row.provider_email_from = provider[:80] if address else ""
        self._flush()

    def set_declined_email(self, account_id: AccountId, address: str) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.provider_email_off = address
        self._flush()

    def count_accounts(self) -> int:
        return int(self.db.scalar(select(func.count()).select_from(Account)) or 0)

    def get_account(self, account_id: AccountId) -> KontoAccount | None:
        row = self._row(account_id)
        return self._account(row) if row is not None else None

    def find_by_username(self, username: str) -> list[KontoAccount]:
        wanted = (username or "").strip().lower()
        if not wanted:
            return []
        rows = self.db.scalars(select(Account).where(func.lower(Account.name) == wanted))
        return [self._account(row) for row in rows]

    def find_by_email(self, address: str) -> list[KontoAccount]:
        wanted = (address or "").strip().lower()
        if not wanted:
            return []
        rows = self.db.scalars(select(Account).where(func.lower(Account.email) == wanted))
        return [self._account(row) for row in rows]

    def name_reserved(self, username: str, except_id: AccountId | None) -> bool:
        query = select(FormerName.id).where(func.lower(FormerName.name) == (username or "").strip().lower())
        if except_id is not None:
            query = query.where(or_(FormerName.account_id.is_(None), FormerName.account_id != int(except_id)))
        return self.db.scalar(query.limit(1)) is not None

    def find_by_former_name(self, username: str) -> list[KontoAccount]:
        ids = set(
            self.db.scalars(
                select(FormerName.account_id).where(
                    func.lower(FormerName.name) == (username or "").strip().lower(), FormerName.account_id.is_not(None)
                )
            )
        )
        return [account for account in (self.get_account(i) for i in ids) if account is not None]

    def display_name_taken(self, display_name: str, except_id: AccountId | None) -> bool:
        wanted = names.display_key(display_name)
        if not wanted:
            return False
        rows = self.db.execute(select(Account.id, Account.display_name).where(Account.display_name != ""))
        other = int(except_id) if except_id is not None else None
        return any(row.id != other and names.display_key(row.display_name) == wanted for row in rows)

    def _flush(self) -> None:
        """Writes what waits; a unique index that refuses becomes ``Taken``."""
        try:
            self.db.flush()
        except IntegrityError as exc:
            self.db.rollback()
            raise Taken("email" if "email" in str(exc.orig) else "username") from exc

    def add_account(self, new: NewAccount) -> AccountId:
        from . import accounts

        if new.display_name and self.display_name_taken(new.display_name, None):
            raise Taken("display_name")
        if self.find_by_username(new.username):
            raise Taken("username")
        invitation = new.invite.rights if new.invite is not None else None
        source = ""
        if new.email:
            from_invite = isinstance(invitation, InviteRow) and (invitation.email or "").lower() == new.email.lower()
            source = INVITE if from_invite else OWN
        row = Account(
            name=new.username,
            display_name=new.display_name,
            email=new.email,
            email_confirmed=new.email_confirmed if new.email else True,
            email_proven=new.email_proven if new.email else False,
            email_source=source,
            role=OPERATOR if new.operator else MEMBER,
            sign_in=SIGN_IN_PASSWORD if new.password else SIGN_IN_OIDC,
            password_hash=hash_password(new.password) if new.password else "",
            password_changed_at=utcnow() if new.password else None,
            language=new.language or "",
            whats_new_seen=__version__,
            # Since E45 a new account has its theme from the start ("system"); only accounts of before have none.
            appearance={"mode": getattr(new, "theme", "system") or "system"},
            device_key=new_device_key(),
        )
        self.db.add(row)
        self._flush()
        if isinstance(invitation, InviteRow):
            # The right in the space the invitation names (the invitation was used up already, ``consume_invite``);
            # into a space without members the one who invited comes along as manager, as in 1.16.0.
            accounts.redeem(self.db, invitation, row, consumed=True, commit=False)
        self._flush()
        logger.info("Account created name=%s role=%s sign_in=%s", row.name, row.role, row.sign_in)
        return row.id

    def set_username(self, account_id: AccountId, username: str) -> None:
        """The new name, and everything nexlore keeps under the old one carried along in the same transaction
        (versions and so the Git mirror, uploads and so the used storage, comments, moves, decisions, plugins,
        notices); the old name stays reserved for the account (``former_names``)."""
        row = self._row(account_id)
        if row is None:
            return
        old = row.name
        if any(other.id != row.id for other in self.find_by_username(username)):
            raise Taken("username")
        row.name = username
        self._flush()
        if old == username:
            return
        for table, column in NAME_COLUMNS:
            # Names of tables and columns from the constant, never input.
            self.db.execute(text(f'UPDATE "{table}" SET "{column}" = :new WHERE "{column}" = :old'),  # noqa: S608
                            {"new": username, "old": old})
        self.db.execute(
            text("UPDATE space_notices SET subject = :new WHERE subject = :old AND kind IN "
                 "('operator_added', 'operator_role', 'operator_removed')"),
            {"new": username, "old": old},
        )
        if old.lower() != username.lower():
            self.db.execute(delete(FormerName).where(FormerName.account_id == row.id,
                                                     func.lower(FormerName.name) == username.lower()))
            self.db.add(FormerName(account_id=row.id, name=old))
        self.db.flush()
        logger.info("Username changed, history carried along account_id=%s", row.id)

    def set_display_name(self, account_id: AccountId, display_name: str) -> None:
        if display_name and self.display_name_taken(display_name, account_id):
            raise Taken("display_name")
        row = self._row(account_id)
        if row is not None:
            row.display_name = display_name
            self.db.flush()

    def set_email(self, account_id: AccountId, address: str, *, confirmed: bool, proven: bool, source: str) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.email = address
        row.email_confirmed = confirmed if address else True
        row.email_proven = proven if address else False
        row.email_source = (PROVIDER if source == PROVIDER else OWN) if address else ""
        if address and row.provider_email and row.provider_email.lower() == address.lower():
            row.provider_email = ""
            row.provider_email_from = ""
        self._flush()

    def set_language(self, account_id: AccountId, language: str) -> None:
        row = self._row(account_id)
        if row is not None:
            row.language = language
            self.db.flush()

    # --- Passwords, failures, sessions ---------------------------------------------------------------------------
    def check_password(self, account_id: AccountId | None, password: str) -> bool:
        row = self._row(account_id)
        if row is None or row.sign_in != SIGN_IN_PASSWORD or not row.password_hash:
            verify_password(password or "", _dummy_hash())
            return False
        return verify_password(password or "", row.password_hash)

    def set_password(self, account_id: AccountId, password: str) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.password_hash = hash_password(password)
        row.password_changed_at = utcnow()
        row.sign_in = SIGN_IN_PASSWORD
        row.failed_logins = 0
        row.locked_until = None
        row.device_key = new_device_key()
        self.db.flush()

    def is_locked(self, account_id: AccountId) -> bool:
        row = self._row(account_id)
        return bool(row and row.locked_until is not None and _aware(row.locked_until) > utcnow())

    def note_failure(self, account_id: AccountId | None) -> None:
        """A wrong password at the account; after ``MAX_FAILURES`` locked for ``LOCK_MINUTES`` (as 1.16.0). Without
        an account the same work on the counter row: as costly, the time tells nothing."""
        row = self._row(account_id)
        if row is None:
            counted = self.db.execute(update(FailedUnknown).where(FailedUnknown.id == 1)
                                      .values(count=FailedUnknown.count + 1))
            if not counted.rowcount:
                self.db.add(FailedUnknown(id=1, count=1))
            self.db.flush()
            return
        row.failed_logins = (row.failed_logins or 0) + 1
        if row.failed_logins >= MAX_FAILURES:
            row.locked_until = utcnow() + timedelta(minutes=LOCK_MINUTES)
            row.failed_logins = 0
            logger.warning("Account locked after %s failures name=%s minutes=%s", MAX_FAILURES, row.name, LOCK_MINUTES)
        else:
            logger.warning("Check failed name=%s (%s of %s before lockout)", row.name, row.failed_logins, MAX_FAILURES)
        self.db.flush()

    def note_success(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.failed_logins = 0
            row.locked_until = None
            row.last_seen_at = utcnow()
            self.db.flush()

    def end_sessions(self, account_id: AccountId) -> None:
        """A new password: every browser session and every sign-in waiting for its code ends, and no browser counts
        as known any more. Paired devices, API tokens, MCP keys, the calendar address and passkeys stay (they are
        listed as "still have access")."""
        from ..vendor.nexkonten import factor
        from . import totp

        self.db.execute(delete(AuthSession).where(AuthSession.account_id == int(account_id),
                                                  AuthSession.kind != KIND_DEVICE))
        totp.forget_account(int(account_id))
        factor.drop_waiting(int(account_id))
        self.renew_device_key(account_id)

    def list_access(self, account_id: AccountId) -> list[Access]:
        number = int(account_id)
        found = [
            Access(f"{DEVICE_UID}{row.id}", nexkonten.ACCESS_DEVICE, row.name, row.last_seen_at)
            for row in self.db.scalars(select(AppDevice).where(AppDevice.account_id == number)
                                       .order_by(AppDevice.created_at))
        ]
        found += [
            Access(f"{API_UID}{row.id}", nexkonten.ACCESS_API_KEY, row.name, row.last_used_at)
            for row in self.db.scalars(select(ApiToken).where(ApiToken.account_id == number,
                                                              ApiToken.blocked_at.is_(None))
                                       .order_by(ApiToken.created_at))
        ]
        found += [
            Access(f"{MCP_UID}{row.id}", nexkonten.ACCESS_API_KEY, row.name, row.last_used_at)
            for row in self.db.scalars(select(McpKey).where(McpKey.account_id == number).order_by(McpKey.created_at))
        ]
        row = self._row(account_id)
        if row is not None and row.calendar_feed_hash:
            found.append(Access(CALENDAR_UID, nexkonten.ACCESS_CALENDAR, "Calendar", None))
        found += [
            Access(key.uid, nexkonten.ACCESS_PASSKEY, key.name, key.last_used_at)
            for key in self.passkeys_of(account_id)
        ]
        return found

    def revoke_access(self, account_id: AccountId) -> int:
        number = int(account_id)
        gone = int(self.db.execute(delete(AppDevice).where(AppDevice.account_id == number)).rowcount or 0)
        gone += int(self.db.execute(delete(ApiToken).where(ApiToken.account_id == number)).rowcount or 0)
        gone += int(self.db.execute(delete(McpKey).where(McpKey.account_id == number)).rowcount or 0)
        gone += self.remove_passkeys(account_id)
        row = self._row(account_id)
        if row is not None and row.calendar_feed_hash:
            row.calendar_feed_hash = None
            gone += 1
        # A QR code nobody scanned yet would bring a device right back.
        self.db.execute(delete(AppPairing).where(AppPairing.account_id == number))
        self.db.flush()
        return gone

    def second_factor(self, account_id: AccountId) -> str:
        row = self._row(account_id)
        if row is None:
            return nexkonten.SECOND_FACTOR_NONE
        if nexkonten.factor.switched_off():
            return nexkonten.SECOND_FACTOR_NONE
        if row.totp_secret_enc:
            # Also a seed that does not open any more: the second factor fails closed.
            return nexkonten.SECOND_FACTOR_ACTIVE
        state = nexkonten.factor.state(self, account_id)
        if state == nexkonten.SECOND_FACTOR_REQUIRED and row.sign_in != SIGN_IN_PASSWORD:
            # An account through a provider brings the provider's second factor.
            return nexkonten.SECOND_FACTOR_NONE
        return state

    # --- Pictures ------------------------------------------------------------------------------------------------
    def set_provider_picture(self, account_id: AccountId, picture: Picture) -> bool:
        """Through nexlore's own picture handling like an upload, and only while the account has none (one statement
        with that condition)."""
        from . import avatars

        try:
            webp = avatars.make(picture.data)
        except avatars.AvatarError:
            return False
        result = self.db.execute(
            update(Account)
            .where(Account.id == int(account_id), Account.avatar_at.is_(None))
            .values(avatar=webp, avatar_at=utcnow(), avatar_source=PROVIDER)
        )
        self._refresh(account_id)
        return int(result.rowcount or 0) == 1

    def _refresh(self, account_id: AccountId) -> None:
        row = self.db.get(Account, int(account_id))
        if row is not None:
            self.db.expire(row)

    # --- Invitations ---------------------------------------------------------------------------------------------
    def find_invite(self, key: str) -> Invite | None:
        """The invitation of a link, also when it ran out (``expires_at`` says so); None when unknown or used, or
        into a space whose inviter no longer manages it (``accounts.find_invite``, as 1.16.0)."""
        from . import accounts

        if not key:
            return None
        row = accounts.find_invite(self.db, key, expired_too=True)
        if row is None:
            return None
        return Invite(
            key=key,
            id=row.id,
            email=row.email or "",
            display_name=row.display_name or "",
            username="",
            expires_at=_aware(row.expires_at),
            rights=row,
        )

    def consume_invite(self, invite: Invite) -> bool:
        return int(self.db.execute(delete(InviteRow).where(InviteRow.id == int(invite.id))).rowcount or 0) == 1

    def accept_invite(self, account_id: AccountId, invite: Invite) -> None:
        """The right of the invitation for an account that has one already (raised, never lowered)."""
        from . import accounts

        row = self._row(account_id)
        if row is not None and isinstance(invite.rights, InviteRow):
            accounts.redeem(self.db, invite.rights, row, consumed=True, commit=False)
            self.db.flush()

    # --- Address changes: ``email_pending*`` as 1.16.0 kept them ---------------------------------------------------
    def start_email_change(self, account_id: AccountId, address: str, token: str, expires_at: datetime) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.email_pending = address
        row.email_pending_hash = hash_token(token)
        row.email_pending_until = expires_at
        self.db.flush()

    def find_email_change(self, token: str) -> EmailChange | None:
        if not token:
            return None
        row = self.db.scalar(select(Account).where(Account.email_pending_hash == hash_token(token)))
        if row is None or not row.email_pending or row.email_pending_until is None:
            return None
        return EmailChange(id=row.id, account_id=row.id, address=row.email_pending,
                           expires_at=_aware(row.email_pending_until))

    def consume_email_change(self, change: EmailChange) -> bool:
        gone = self.db.execute(
            update(Account).where(Account.id == int(change.id), Account.email_pending != "")
            .values(email_pending="", email_pending_hash="", email_pending_until=None)
        )
        self._refresh(change.id)
        return int(gone.rowcount or 0) == 1

    def drop_email_change(self, account_id: AccountId) -> None:
        self.db.execute(update(Account).where(Account.id == int(account_id))
                        .values(email_pending="", email_pending_hash="", email_pending_until=None))
        self._refresh(account_id)

    # --- Links for a new password --------------------------------------------------------------------------------
    def start_reset(
        self, account_id: AccountId, token: str, expires_at: datetime, *, created_by: AccountId | None, origin: str
    ) -> None:
        # One open link per account: an earlier one stops counting.
        self.db.execute(delete(PasswordReset).where(PasswordReset.account_id == int(account_id)))
        self.db.add(
            PasswordReset(
                token_hash=hash_token(token),
                account_id=int(account_id),
                created_by=int(created_by) if created_by is not None else None,
                expires_at=expires_at,
                origin=origin,
            )
        )
        self.db.flush()

    def find_reset(self, token: str) -> Reset | None:
        if not token:
            return None
        row = self.db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hash_token(token)))
        if row is None:
            return None
        return Reset(id=row.id, account_id=row.account_id, expires_at=_aware(row.expires_at),
                     created_by=row.created_by, origin=row.origin or nexkonten.RESET_OPERATOR)

    def consume_reset(self, reset: Reset) -> bool:
        return int(self.db.execute(delete(PasswordReset).where(PasswordReset.id == int(reset.id))).rowcount or 0) == 1

    def drop_resets(self, account_id: AccountId, *, origin: str | None = None) -> None:
        conditions = [PasswordReset.account_id == int(account_id)]
        if origin is not None:
            conditions.append(PasswordReset.origin == origin)
        self.db.execute(delete(PasswordReset).where(*conditions))

    def claim_setup(self) -> bool:
        try:
            self.db.add(SetupClaim(id=1))
            self.db.flush()
        except IntegrityError:
            self.db.rollback()
            return False
        return True

    # --- After the commit ----------------------------------------------------------------------------------------
    def notify(self, event: Event) -> None:
        """What follows a settled outcome. A password set through a link leaves the list "These devices still have
        access" for the next sign-in, and after the operator's or the server's link the notice that somebody else
        made it."""
        if event.kind == nexkonten.EVENT_PASSWORD_SET:
            origin = str(event.details.get("origin") or nexkonten.RESET_SELF)
            row = self._row(event.account_id)
            if row is not None:
                row.new_password_origin = origin
                row.password_reset_notice = origin != nexkonten.RESET_SELF
                self.db.commit()
        elif event.kind == nexkonten.EVENT_RENAMED:
            logger.info("Username changed account_id=%s", event.account_id)
        elif event.kind == nexkonten.EVENT_CREATED and event.invite is not None:
            row = self._row(event.account_id)
            if row is not None:
                logger.info("Invite used name=%s", row.name)

    # === Part 2: second factor, passkeys, sessions, pictures ========================================================

    # --- Second factor -------------------------------------------------------------------------------------------
    def totp_seed(self, account_id: AccountId) -> str | None:
        """The seed of the account's authenticator, opened; sealed as in 1.16.0 (``totp.seal_seed``), so that every
        authenticator app set up before keeps working."""
        from . import totp

        row = self._row(account_id)
        if row is None or not row.totp_secret_enc:
            return None
        try:
            return totp.open_seed(row.totp_secret_enc)
        except totp.SeedUnreadable:
            logger.error("Second factor seed unreadable name=%s (secret.key changed?)", row.name)
            return None

    def set_totp(self, account_id: AccountId, seed: str | None) -> None:
        from . import totp

        row = self._row(account_id)
        if row is None:
            return
        if seed:
            row.totp_secret_enc = totp.seal_seed(seed)
        else:
            row.totp_secret_enc = ""
            row.totp_last_step = 0
        self.db.flush()

    def pending_totp(self, account_id: AccountId) -> tuple[str, datetime] | None:
        row = self._row(account_id)
        if row is None or not row.totp_pending or row.totp_pending_until is None:
            return None
        seed = decrypt_secret(row.totp_pending, PENDING_TOTP_CONTEXT)
        return (seed, _aware(row.totp_pending_until)) if seed else None

    def set_pending_totp(self, account_id: AccountId, seed: str | None, until: datetime | None) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.totp_pending = encrypt_secret(seed, PENDING_TOTP_CONTEXT) if seed and until else ""
        row.totp_pending_until = until if seed and until else None
        self.db.flush()

    def claim_step(self, account_id: AccountId, step: int) -> bool:
        result = self.db.execute(
            update(Account)
            .where(Account.id == int(account_id), Account.totp_last_step < step)
            .values(totp_last_step=step)
        )
        self._refresh(account_id)
        return int(result.rowcount or 0) == 1

    def recovery_hashes(self, account_id: AccountId) -> list[str]:
        from . import totp

        row = self._row(account_id)
        return totp.load_recovery(row.totp_recovery) if row is not None else []

    def set_recovery(self, account_id: AccountId, hashes: list[str]) -> None:
        row = self._row(account_id)
        if row is not None:
            row.totp_recovery = json.dumps(list(hashes)) if hashes else ""
            self.db.flush()

    def claim_recovery(self, account_id: AccountId, stored: str) -> bool:
        """The code goes with one statement that only succeeds against the list it was read from: two requests with
        the same code at once, one of them wins."""
        row = self._row(account_id)
        if row is None:
            return False
        before = row.totp_recovery or ""
        hashes = self.recovery_hashes(account_id)
        if stored not in hashes:
            return False
        remaining = [entry for entry in hashes if entry != stored]
        result = self.db.execute(
            update(Account)
            .where(Account.id == int(account_id), Account.totp_recovery == before)
            .values(totp_recovery=json.dumps(remaining))
        )
        self._refresh(account_id)
        return int(result.rowcount or 0) == 1

    def recovery_key(self) -> bytes:
        return hashlib.sha256(b"nexlore-recovery:" + server_key()).digest()

    def factor_required(self) -> bool:
        from . import settings_service

        return bool(settings_service.get(self.db, SWITCH_FACTOR_REQUIRED))

    # --- Passkeys ------------------------------------------------------------------------------------------------
    def passkeys_allowed(self) -> bool:
        from . import settings_service

        return bool(settings_service.get(self.db, SWITCH_PASSKEYS))

    @staticmethod
    def _passkey(row: PasskeyRow) -> PasskeyData:
        return PasskeyData(
            uid=row.id,
            account_id=row.account_id,
            credential_id=bytes(row.credential_id),
            public_key=bytes(row.public_key),
            sign_count=row.sign_count,
            name=row.name,
            created_at=_aware(row.created_at),
            last_used_at=_aware(row.last_used_at) if row.last_used_at else None,
        )

    def passkeys_of(self, account_id: AccountId) -> list[PasskeyData]:
        rows = self.db.scalars(
            select(PasskeyRow).where(PasskeyRow.account_id == int(account_id)).order_by(PasskeyRow.created_at)
        )
        return [self._passkey(row) for row in rows]

    def find_passkey(self, credential_id: bytes) -> PasskeyData | None:
        row = self.db.scalar(select(PasskeyRow).where(PasskeyRow.credential_id == credential_id))
        return self._passkey(row) if row is not None else None

    def add_passkey(self, passkey: PasskeyData) -> None:
        self.db.add(
            PasskeyRow(
                id=passkey.uid,
                account_id=int(passkey.account_id),
                credential_id=passkey.credential_id,
                public_key=passkey.public_key,
                sign_count=passkey.sign_count,
                name=passkey.name,
                created_at=passkey.created_at,
            )
        )
        self.db.flush()

    def claim_counter(self, uid: str, old: int, new: int) -> bool:
        result = self.db.execute(
            update(PasskeyRow).where(PasskeyRow.id == uid, PasskeyRow.sign_count == old)
            .values(sign_count=new, last_used_at=utcnow())
        )
        return int(result.rowcount or 0) == 1

    def remove_passkey(self, account_id: AccountId, uid: str) -> bool:
        result = self.db.execute(
            delete(PasskeyRow).where(PasskeyRow.account_id == int(account_id), PasskeyRow.id == uid)
        )
        return int(result.rowcount or 0) == 1

    def remove_passkeys(self, account_id: AccountId) -> int:
        return int(self.db.execute(delete(PasskeyRow).where(PasskeyRow.account_id == int(account_id))).rowcount or 0)

    def user_handle(self, account_id: AccountId) -> bytes:
        row = self._row(account_id)
        if row is None:
            raise LookupError(account_id)
        if not row.passkey_handle:
            row.passkey_handle = secrets.token_urlsafe(32)
            self.db.flush()
        return row.passkey_handle.encode("ascii")

    # --- Sessions ------------------------------------------------------------------------------------------------
    @staticmethod
    def _session(row: AuthSession) -> SessionData:
        return SessionData(
            uid=row.uid or f"s{row.id}",
            account_id=row.account_id,
            kind=row.kind or KIND_BROWSER,
            created_at=_aware(row.created_at),
            expires_at=_aware(row.expires_at),
            last_seen_at=_aware(row.last_seen_at) if row.last_seen_at else None,
            remember=bool(row.remember),
            stage=row.stage or STAGE_FULL,
            provider_checked=row.via == SESSION_VIA_PROVIDER,
            label=row.user_agent or "",
            address=row.ip or "",
        )

    @staticmethod
    def _device(row: AppDevice) -> SessionData:
        created = _aware(row.created_at)
        return SessionData(
            uid=f"{DEVICE_UID}{row.id}",
            account_id=row.account_id,
            kind=KIND_DEVICE,
            created_at=created,
            expires_at=created + timedelta(days=36500),
            last_seen_at=_aware(row.last_seen_at) if row.last_seen_at else None,
            label=row.name,
        )

    def add_session(self, session: SessionData, token_hash: str) -> None:
        self.db.add(
            AuthSession(
                token_hash=token_hash,
                uid=session.uid,
                account_id=int(session.account_id),
                created_at=session.created_at,
                expires_at=session.expires_at,
                last_seen_at=session.last_seen_at or session.created_at,
                ip=session.address[:64],
                user_agent=session.label[:255],
                via=SESSION_VIA_PROVIDER if session.provider_checked else SESSION_VIA_PASSWORD,
                remember=session.remember,
                stage=session.stage,
                kind=session.kind,
            )
        )
        self.db.flush()

    def session_by_hash(self, token_hash: str) -> SessionData | None:
        row = self.db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash))
        return self._session(row) if row is not None else None

    def _by_uid(self, uid: str) -> AuthSession | None:
        if uid.startswith("s") and uid[1:].isdigit():
            return self.db.get(AuthSession, int(uid[1:]))
        return self.db.scalar(select(AuthSession).where(AuthSession.uid == uid))

    def touch_session(self, uid: str, last_seen_at: datetime, expires_at: datetime) -> None:
        row = self._by_uid(uid)
        if row is not None:
            row.last_seen_at = last_seen_at
            row.expires_at = expires_at
            self.db.flush()

    def set_stage(self, uid: str, stage: str) -> None:
        row = self._by_uid(uid)
        if row is not None:
            row.stage = stage
            self.db.flush()

    def sessions_of(self, account_id: AccountId) -> list[SessionData]:
        now = utcnow()
        rows = self.db.scalars(
            select(AuthSession).where(AuthSession.account_id == int(account_id), AuthSession.expires_at > now,
                                      AuthSession.kind != KIND_WAITING)
        )
        devices = self.db.scalars(select(AppDevice).where(AppDevice.account_id == int(account_id)))
        return [self._session(row) for row in rows] + [self._device(row) for row in devices]

    def end_session(self, account_id: AccountId, uid: str) -> bool:
        if uid.startswith(DEVICE_UID) and uid[len(DEVICE_UID):].isdigit():
            result = self.db.execute(
                delete(AppDevice).where(AppDevice.id == int(uid[len(DEVICE_UID):]),
                                        AppDevice.account_id == int(account_id))
            )
            return int(result.rowcount or 0) == 1
        row = self._by_uid(uid)
        if row is None or row.account_id != int(account_id):
            return False
        self.db.delete(row)
        self.db.flush()
        return True

    def end_everywhere(self, account_id: AccountId, keep_uid: str | None) -> int:
        """Browsers, waiting sign-ins and paired devices, and, as in 1.16.0, the MCP connectors that signed in over
        OAuth; API tokens, MCP keys made by hand, the calendar address and passkeys stay."""
        from ..vendor.nexkonten import factor
        from . import totp

        keep = self._by_uid(keep_uid) if keep_uid else None
        statement = delete(AuthSession).where(AuthSession.account_id == int(account_id))
        if keep is not None:
            statement = statement.where(AuthSession.id != keep.id)
        gone = int(self.db.execute(statement).rowcount or 0)
        gone += int(self.db.execute(delete(AppDevice).where(AppDevice.account_id == int(account_id))).rowcount or 0)
        gone += int(self.db.execute(delete(McpKey).where(McpKey.account_id == int(account_id),
                                                         McpKey.kind == "oauth")).rowcount or 0)
        totp.forget_account(int(account_id))
        factor.drop_waiting(int(account_id))
        return gone

    def device_key(self, account_id: AccountId) -> str:
        row = self._row(account_id)
        if row is None:
            raise LookupError(account_id)
        if not row.device_key:
            row.device_key = new_device_key()
            self.db.flush()
        return row.device_key

    def renew_device_key(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.device_key = new_device_key()
            self.db.flush()

    # --- Pictures (part 2) ---------------------------------------------------------------------------------------
    def picture_of(self, account_id: AccountId) -> tuple[bytes, datetime] | None:
        row = self._row(account_id)
        if row is None or row.avatar_at is None or not row.avatar:
            return None
        return bytes(row.avatar), _aware(row.avatar_at)

    def set_picture(self, account_id: AccountId, data: bytes, at: datetime, source: str) -> None:
        row = self._row(account_id)
        if row is not None:
            row.avatar = data
            row.avatar_at = at
            row.avatar_source = PROVIDER if source == PROVIDER else ""
            self.db.flush()

    def remove_picture(self, account_id: AccountId) -> None:
        row = self._row(account_id)
        if row is not None:
            row.avatar = None
            row.avatar_at = None
            row.avatar_source = ""
            self.db.flush()

    # --- Transaction ---------------------------------------------------------------------------------------------
    # --- 1.1.0: the operator's functions, the theme, the sign-in settings -------------------------------------------
    def active_operators(self) -> int:
        return int(self.db.scalar(
            select(func.count()).select_from(Account)
            .where(Account.role == OPERATOR, Account.blocked_at.is_(None), Account.deleted_at.is_(None))
        ) or 0)

    def set_operator(self, account_id: AccountId, operator: bool) -> None:
        row = self._row(account_id)
        if row is not None:
            row.role = OPERATOR if operator else MEMBER
            self._flush()

    def set_blocked(self, account_id: AccountId, at: datetime | None) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.blocked_at = at
        if at is None:
            row.failed_logins = 0
            row.locked_until = None
        self._flush()

    def set_deleted(self, account_id: AccountId, at: datetime | None) -> None:
        row = self._row(account_id)
        if row is not None:
            row.deleted_at = at
            self._flush()

    def shut_out(self, account_id: AccountId) -> None:
        """What blocking did in 1.16.0: every browser session, the OAuth connectors and the paired iPhones end, the
        marks of known browsers are worthless, a sign-in waiting for its code goes. API tokens, MCP keys made by hand
        and the calendar address stay and are refused while the account is out (``security.account_out``)."""
        from ..vendor.nexkonten import factor
        from . import totp

        end_all_sessions(self.db, int(account_id))
        totp.forget_account(int(account_id))
        factor.drop_waiting(int(account_id))

    def on_shut_out(self, account: KontoAccount) -> None:
        """Blocked or deleted (konten 1.1.0, E38). nexlore sends no pushes and syncs nothing in the background for an
        account; what reaches an account from outside (webhook, mail of a notification, the tasks of the day, a key
        running out) asks ``notify.reaches`` at the moment it goes, so nothing goes while the account is out. The
        webhook, the choices and the calendar address stay for its return."""
        logger.info("Account out: notifications held account_id=%s", account.id)

    def on_back(self, account: KontoAccount) -> None:
        """Unblocked or brought back: notifications reach it again, by the same check; nothing to start."""
        logger.info("Account back: notifications reach it again account_id=%s", account.id)

    def deleted_before(self, moment: datetime) -> list[AccountId]:
        return list(self.db.scalars(
            select(Account.id).where(Account.deleted_at.is_not(None), Account.deleted_at <= moment)
        ))

    def purge_account(self, account_id: AccountId) -> None:
        """What deleting did in 1.16.0, now after the 30 days: the row goes with its rights, sessions, keys and links;
        its notes stay where they are, and a space it was the only member of belongs to the operator. Its name stays
        reserved for ever (the history keeps it)."""
        from . import totp
        from .oidc_store import mirror_legacy

        row = self._row(account_id)
        if row is None:
            return
        # Its connections with other nex apps rested while it was deleted; now the partners hear the end (module
        # verbinden, revoked later where a partner cannot be reached).
        from ..vendor import nexverbinden
        from .verbinden_store import CONFIG, VerbindenStore

        nexverbinden.end_all(VerbindenStore(self.db), CONFIG, row.id, datetime.now(UTC))
        self.db.add(FormerName(account_id=None, name=row.name))
        self.db.delete(row)
        # The account's links and old subject go with it: the way back and its fingerprint follow in the same commit.
        mirror_legacy(self.db)
        self._flush()
        totp.forget_account(int(account_id))

    def set_storage_limit(self, account_id: AccountId, limit: int | None) -> None:
        row = self._row(account_id)
        if row is not None:
            row.storage_limit = limit
            self._flush()

    def set_right(self, account_id: AccountId, right: str, allowed: bool) -> None:
        row = self._row(account_id)
        if row is not None and right == "ai":
            row.ai_allowed = allowed
            self._flush()

    def set_theme(self, account_id: AccountId, theme: str) -> None:
        row = self._row(account_id)
        if row is None:
            return
        look = dict(row.appearance) if isinstance(row.appearance, dict) else {}
        look["mode"] = theme
        row.appearance = look
        self._flush()

    def sign_in_settings(self) -> nexkonten.model3.SignInSettings:
        from . import settings_service

        return nexkonten.model3.SignInSettings(
            password_login=bool(settings_service.get(self.db, "password_login")),
            factor_required=self.factor_required(),
            passkeys_allowed=self.passkeys_allowed(),
        )

    def save_sign_in_settings(self, settings: nexkonten.model3.SignInSettings) -> None:
        from . import settings_service

        settings_service.save(self.db, {
            "password_login": settings.password_login,
            SWITCH_FACTOR_REQUIRED: settings.factor_required,
            SWITCH_PASSKEYS: settings.passkeys_allowed,
        }, commit=False)

    def active_providers(self) -> int:
        return int(self.db.scalar(
            select(func.count()).select_from(OidcProvider).where(OidcProvider.enabled.is_(True))
        ) or 0)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


@contextmanager
def own_store() -> Iterator[KontenStore]:
    """A store with a session of its own, for work after the answer (a forgotten password, a provider's picture)."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield KontenStore(db)


def provider_picture(account_id: int, address: str, issuer: str) -> None:
    """The provider's picture for an account without one, in a thread of its own (a fetch takes up to five seconds).
    Whatever fails, the account stays without a picture; the sign-in went through long before."""

    def work() -> None:
        with own_store() as store:
            nexkonten.pictures.take_provider_picture(store, account_id, address, issuer)

    if PICTURE_IN_THREAD:
        threading.Thread(target=work, name="nexlore-provider-picture", daemon=True).start()
    else:
        work()
