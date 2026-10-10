"""nexlore's side of the shared sign-in module ``vendor/nexoidc``: the ``Store`` over its tables, the start-up
configuration, and the migration from the single provider of the settings to the list.

The module (anmeldung mit OIDC und authentik, the shared blueprint) runs the protocol, decides who an identity is and
keeps the provider list; it never sees a database. What is nexlore's own lives here: accounts and their names, the
rights an invitation brings into a space, the address an account takes from its provider (``services/emailaddr``),
and the encryption of the client secrets with the server secret.

A ``SqlStore`` works inside one SQLAlchemy session, one request. The module commits when an outcome is settled and
rolls back when it refuses after a write (a consumed invitation comes back that way).
"""

from __future__ import annotations

import logging
import re

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .. import __version__
from ..config import get_settings
from ..db import SessionLocal
from ..models import (
    MEMBER,
    SIGN_IN_OIDC,
    SIGN_IN_PASSWORD,
    Account,
    OidcLink,
    OidcProvider,
    Setting,
    utcnow,
)
from ..models import Invite as InviteRow
from ..security import decrypt_secret, encrypt_secret
from ..vendor import nexoidc
from ..vendor.nexoidc import AccountState, Invite, Link, Provider, ProviderValues, migrate, secret_context
from . import accounts, emailaddr, settings_service

logger = logging.getLogger("nexlore.oidc")

APP_NAME = "nexlore"
#: Where nexlore's sign-in and account pages are, as the module sends the browser there.
LOGIN_PAGE = "/login"
ACCOUNT_PAGE = "/account"
HOME = "/"
#: Longest account name (``accounts.NAME_PATTERN``).
NAME_MAX = 64
_NUMBERED = re.compile(r"^(.*?)(-\d+)$")


def _public_url() -> str:
    with SessionLocal() as db:
        return settings_service.public_url(db)


def _save_public_url(url: str) -> None:
    """The address the operator confirmed in the authentik card (module 1.0.10): the same setting the settings page
    writes and ``_public_url`` reads first, committed at once in a transaction of its own."""
    with SessionLocal() as db:
        settings_service.save(db, {"public_url": url})


def _server_secret() -> str:
    return get_settings().resolved_secret_key()


def configure() -> None:
    """Tell the module who it runs in; called once at start-up (and by the tests)."""
    nexoidc.configure(
        nexoidc.AppConfig(
            app_name=APP_NAME,
            server_secret=_server_secret,
            public_url=_public_url,
            save_public_url=_save_public_url,
            login_page=LOGIN_PAGE,
            account_page=ACCOUNT_PAGE,
            home=HOME,
        )
    )


def clean_name(raw: str) -> str:
    """An account name from what the provider suggests: lower case, nexlore's characters, at most 64; a number at the
    end (``max-2``) survives the cut. Empty when nothing usable is left."""
    cleaned = re.sub(r"[^a-z0-9._-]", "-", raw.strip().lower()).strip("-._")
    if len(cleaned) > NAME_MAX:
        numbered = _NUMBERED.match(cleaned)
        suffix = numbered.group(2) if numbered else ""
        stem = numbered.group(1) if numbered else cleaned
        cleaned = stem[: NAME_MAX - len(suffix)].rstrip("-._") + suffix
    return cleaned if accounts.NAME_PATTERN.match(cleaned) else ""


def has_links(db: Session, account_id: int) -> bool:
    return db.scalar(select(OidcLink.id).where(OidcLink.account_id == account_id).limit(1)) is not None


class SqlStore:
    """``nexoidc.Store`` over ``oidc_providers`` and ``oidc_links``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- Providers -------------------------------------------------------------------------------------------------

    def _provider(self, row: OidcProvider | None) -> Provider | None:
        if row is None:
            return None
        return Provider(
            id=row.id,
            slug=row.slug,
            label=row.label,
            issuer=row.issuer,
            client_id=row.client_id,
            client_secret=decrypt_secret(row.client_secret_enc, secret_context(row.id)),
            scopes=row.scopes,
            enabled=row.enabled,
            auto_create=row.auto_create,
            trusts_second_factor=row.trusts_second_factor,
            managed=row.managed,
            position=row.position,
            redirect_path=row.redirect_path,
            created_at=row.created_at,
            registered_redirect=row.registered_redirect or "",
        )

    def list_providers(self) -> list[Provider]:
        rows = self.db.scalars(select(OidcProvider).order_by(OidcProvider.position, OidcProvider.id))
        return [provider for provider in (self._provider(row) for row in rows) if provider is not None]

    def get_provider(self, provider_id: int) -> Provider | None:
        return self._provider(self.db.get(OidcProvider, provider_id))

    def provider_by_slug(self, slug: str) -> Provider | None:
        return self._provider(self.db.scalar(select(OidcProvider).where(OidcProvider.slug == slug)))

    @staticmethod
    def _apply(row: OidcProvider, values: ProviderValues) -> None:
        row.slug, row.label, row.issuer, row.client_id = values.slug, values.label, values.issuer, values.client_id
        row.scopes, row.enabled, row.auto_create = values.scopes, values.enabled, values.auto_create
        row.trusts_second_factor, row.managed, row.position = (
            values.trusts_second_factor,
            values.managed,
            values.position,
        )
        row.redirect_path = values.redirect_path
        if values.registered_redirect is not None:
            row.registered_redirect = values.registered_redirect

    def insert_provider(self, values: ProviderValues) -> Provider:
        row = OidcProvider()
        self._apply(row, values)
        self.db.add(row)
        self.db.flush()
        row.client_secret_enc = encrypt_secret(values.client_secret or "", secret_context(row.id))
        self.db.flush()
        provider = self._provider(row)
        assert provider is not None
        return provider

    def update_provider(self, provider_id: int, values: ProviderValues) -> Provider:
        row = self.db.get(OidcProvider, provider_id)
        assert row is not None
        self._apply(row, values)
        if values.client_secret is not None:
            row.client_secret_enc = encrypt_secret(values.client_secret, secret_context(row.id))
        self.db.flush()
        provider = self._provider(row)
        assert provider is not None
        return provider

    def delete_provider(self, provider_id: int) -> None:
        # Foreign keys are on (db.py), the links would go anyway; said here so that nothing depends on a pragma.
        self.drop_links(provider_id)
        self.db.execute(delete(OidcProvider).where(OidcProvider.id == provider_id))

    # --- Links -----------------------------------------------------------------------------------------------------

    @staticmethod
    def _link(row: OidcLink) -> Link:
        return Link(row.provider_id, row.subject, row.account_id, row.issuer, row.email, row.created_at,
                    row.last_used_at)

    def find_link(self, provider_id: int, subject: str) -> Link | None:
        row = self.db.scalar(select(OidcLink).where(OidcLink.provider_id == provider_id, OidcLink.subject == subject))
        return self._link(row) if row else None

    def links_of_provider(self, provider_id: int) -> list[Link]:
        rows = self.db.scalars(select(OidcLink).where(OidcLink.provider_id == provider_id).order_by(OidcLink.id))
        return [self._link(row) for row in rows]

    def links_of_account(self, account_id: int) -> list[Link]:
        rows = self.db.scalars(select(OidcLink).where(OidcLink.account_id == account_id).order_by(OidcLink.id))
        return [self._link(row) for row in rows]

    def add_link(self, link: Link) -> None:
        self.db.add(OidcLink(provider_id=link.provider_id, subject=link.subject, account_id=link.account_id,
                             issuer=link.issuer, email=link.email))
        self.db.flush()
        self._address(link.account_id, link.email)

    def remove_link(self, provider_id: int, account_id: int) -> bool:
        result = self.db.execute(
            delete(OidcLink).where(OidcLink.provider_id == provider_id, OidcLink.account_id == account_id)
        )
        removed = bool(result.rowcount)  # type: ignore[attr-defined]
        if removed:
            self._forget_provider_address(account_id)
        return removed

    def drop_links(self, provider_id: int) -> int:
        holders = set(self.db.scalars(select(OidcLink.account_id).where(OidcLink.provider_id == provider_id)))
        result = self.db.execute(delete(OidcLink).where(OidcLink.provider_id == provider_id))
        for account_id in holders:
            self._forget_provider_address(account_id)
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    def _forget_provider_address(self, account_id: int) -> None:
        """No provider left for the account: an address that came from one goes too, an own one stays."""
        if not has_links(self.db, account_id):
            account = self.db.get(Account, account_id)
            if account is not None:
                emailaddr.unlinked(account)

    def touch_link(self, provider_id: int, subject: str, email: str | None) -> None:
        self.db.execute(
            update(OidcLink)
            .where(OidcLink.provider_id == provider_id, OidcLink.subject == subject)
            .values(last_used_at=utcnow(), email=email)
        )
        account_id = self.db.scalar(
            select(OidcLink.account_id).where(OidcLink.provider_id == provider_id, OidcLink.subject == subject)
        )
        if account_id is not None:
            self._address(account_id, email)

    def _address(self, account_id: int, email: str | None) -> None:
        """What the provider says about the address, as nexlore treats any address change: an account through the
        provider only follows it, a linked one with a password is offered it (``services/emailaddr``)."""
        account = self.db.get(Account, account_id)
        if account is not None and email:
            emailaddr.from_provider(self.db, account, email)

    # --- Accounts --------------------------------------------------------------------------------------------------

    def account_state(self, account_id: int) -> AccountState | None:
        row = self.db.get(Account, account_id)
        if row is None:
            return None
        # nexlore has no blocked accounts: the lock after wrong passwords keeps out guessing at the password, and a
        # stranger could set it off from outside; it does not close the provider's way in.
        return AccountState(
            id=row.id,
            name=row.name,
            blocked=False,
            has_password=row.sign_in == SIGN_IN_PASSWORD and bool(row.password_hash),
            has_second_factor=bool(row.totp_secret_enc),
        )

    def clean_name(self, raw: str) -> str:
        return clean_name(raw)

    def name_taken(self, name: str) -> bool:
        return accounts.by_name(self.db, name) is not None

    def create_account(self, name: str, *, invite: Invite | None, email: str | None) -> int:
        row = Account(name=name, role=MEMBER, sign_in=SIGN_IN_OIDC, whats_new_seen=__version__)
        self.db.add(row)
        self.db.flush()
        if email:
            emailaddr.from_provider(self.db, row, email)
        if invite is not None and isinstance(invite.rights, InviteRow):
            accounts.redeem(self.db, invite.rights, row, consumed=True, commit=False)
        logger.info("Account created name=%s role=%s sign_in=oidc", row.name, MEMBER)
        return row.id

    # --- Invitations -----------------------------------------------------------------------------------------------

    def find_invite(self, key: str) -> Invite | None:
        row = accounts.find_invite(self.db, key)
        return Invite(key=key, id=row.id, rights=row) if row is not None else None

    def consume_invite(self, invite: Invite) -> bool:
        row = invite.rights
        return isinstance(row, InviteRow) and accounts.consume(self.db, row)

    def accept_invite(self, account_id: int, invite: Invite) -> None:
        # A known identity came through an invitation (module 1.0.8): the rights of the invitation come on top of the
        # account's own, never fewer (``accounts.redeem`` only raises). The address it was made for is not taken over:
        # the account has its own. Only uncoupled: coupled, ``find_invite`` finds none.
        row = self.db.get(Account, account_id)
        if row is not None and isinstance(invite.rights, InviteRow):
            accounts.redeem(self.db, invite.rights, row, consumed=True, commit=False)

    # --- Transaction -----------------------------------------------------------------------------------------------

    def commit(self) -> None:
        # Whatever the module settled, the way back to the version before the list sees the same (``mirror_legacy``).
        mirror_legacy(self.db)
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


# --- The migration from the single provider of the settings (blueprint 01 "Umstieg", 06 "Wanderung") --------------

#: How nexlore 1.5 behaved after the provider: it asked no code of its own (blueprint 06 "Wanderung").
TRUSTED_BEFORE = True
#: The fingerprint of what the way back wrote last (``migrate.fingerprint``), a setting.
FINGERPRINT = "oidc_legacy_fingerprint"
#: The issuer the version before the list knows, or ``migrate.CLOSED`` (module 1.0.10, ``migrate.way_back``).
ANCHOR = "oidc_legacy_anchor"
#: The settings of the single provider before the list. They stay readable for one version (the way back), then go.
LEGACY_KEYS = ("oidc_issuer", "oidc_client_id", "oidc_client_secret_enc", "oidc_provider_name", "oidc_auto_create")


def read_legacy(db: Session) -> tuple[migrate.Legacy, list[tuple[int, str]]]:
    """The old settings and the old column, read the one way the migration, the fingerprint and ``resync`` read them
    (the secret decrypted: sealed with a random nonce, the stored text would differ at every write)."""
    values = settings_service.get_all(db)
    label = str(values.get("oidc_provider_name") or "")
    legacy = migrate.Legacy(
        issuer=str(values.get("oidc_issuer") or ""),
        client_id=str(values.get("oidc_client_id") or ""),
        client_secret=decrypt_secret(str(values.get("oidc_client_secret_enc") or "")),
        label=label,
        auto_create=bool(values.get("oidc_auto_create")),
        # The authentik button of nexlore 1.2 to 1.5 named the provider "authentik"; the form never did by itself.
        set_up_by_button=label == "authentik",
    )
    subjects = [
        (account_id, subject)
        for account_id, subject in db.execute(
            select(Account.id, Account.oidc_subject).where(Account.oidc_subject != "").order_by(Account.id)
        )
    ]
    return legacy, subjects


def legacy_plan(db: Session) -> migrate.Plan | None:
    """The entry ``oidc`` and its links the old settings become; None when no provider was set up."""
    legacy, subjects = read_legacy(db)
    # nexlore asked no code after the provider before the list: the migrated entry keeps that (blueprint 06).
    return migrate.plan(legacy, subjects, trusts_second_factor=TRUSTED_BEFORE)


def mirror_legacy(db: Session) -> None:
    """Write the way back (``_write_legacy``), then the fingerprint of what stands there for ``migrate.resync`` at the
    next start: what the older version changes in between is taken over, nothing else (module 1.0.9). Nothing is
    committed here; the store calls it before every commit, and so does every other commit that changes accounts,
    links or the entry (deleting an account)."""
    db.flush()
    _write_legacy(db)
    db.flush()
    legacy, subjects = read_legacy(db)
    put_settings(db, {FINGERPRINT: migrate.fingerprint(legacy, subjects)})


def stored_anchor(db: Session) -> str | None:
    """The issuer the version before the list knows, or ``migrate.CLOSED``; None while nothing is stored yet."""
    return str(settings_service.get(db, ANCHOR) or "") or None


def _write_legacy(db: Session) -> None:
    """The way back to nexlore 1.5 (blueprint 01 "Umstieg" 4): that version reads the old settings ``oidc_*`` and the
    column ``oidc_subject``. What they show is ``migrate.way_back``'s, one rule for every app (module 1.0.10): the
    entry ``oidc`` and the stored anchor decide, nexlore only writes it in its old form (the secret sealed without a
    context, as 1.5 reads it) and stores the anchor that comes back."""
    store = SqlStore(db)
    entry = store.provider_by_slug(nexoidc.LEGACY_SLUG)
    links = [(link.account_id, link.subject) for link in store.links_of_provider(entry.id)] if entry else []
    before = stored_anchor(db)
    mirror = migrate.way_back(entry, links, before)
    shown = mirror.legacy
    changes: dict[str, object] = {}
    wanted = {
        "oidc_issuer": shown.issuer,
        "oidc_client_id": shown.client_id,
        "oidc_provider_name": shown.label,
        "oidc_auto_create": bool(shown.auto_create),
        ANCHOR: mirror.anchor,
    }
    for key, value in wanted.items():
        if settings_service.get(db, key) != value:
            changes[key] = value
    # A sealed secret differs at every write (random nonce): compare what is inside.
    if decrypt_secret(str(settings_service.get(db, "oidc_client_secret_enc") or "")) != (shown.client_secret or ""):
        changes["oidc_client_secret_enc"] = encrypt_secret(shown.client_secret) if shown.client_secret else ""
    if changes:
        put_settings(db, changes)
    if mirror.anchor == migrate.CLOSED and before not in (None, migrate.CLOSED):
        logger.info("The provider before the list is gone or another: its old settings and subjects are emptied")
    for account in db.scalars(
        select(Account).where((Account.oidc_subject != "") | Account.id.in_([account_id for account_id, _ in links]))
    ):
        wanted_subject = mirror.subjects.get(account.id, "")
        if account.oidc_subject != wanted_subject:
            account.oidc_subject = wanted_subject


def put_settings(db: Session, changes: dict[str, object]) -> None:
    """Settings written in the open transaction (``settings_service.save`` commits on its own); flushed, so that what
    the mirror reads next in the same transaction (the anchor) is there."""
    for key, value in changes.items():
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    db.flush()


#: Set once the settings were looked at: an operator who later removes every entry must not get the old provider
#: back at the next start.
MIGRATED = "oidc_list_migrated"


def migration_due(db: Session) -> bool:
    return (
        not settings_service.get(db, MIGRATED)
        and db.scalar(select(func.count()).select_from(OidcProvider)) == 0
        and legacy_plan(db) is not None
    )


def migrate_settings(*, backup: bool = True) -> Provider | None:
    """What the app runs at every start-up, after the check of the database: once, the provider of the settings
    becomes the entry ``oidc`` with a link per stored subject (``/api/oidc/callback`` keeps signing in; a backup goes
    first, the way back). Every later start takes over what the version before the list changed in the old settings
    and the old column since (``migrate.resync``, a backup first when there is something), and writes the way back
    and its fingerprint again. Returns the new entry of the first kind, else None."""
    with SessionLocal() as db:
        due = migration_due(db)
        if not due and not settings_service.get(db, MIGRATED):
            settings_service.save(db, {MIGRATED: True})
    if not due:
        _take_over(backup=backup)
        return None
    if backup:
        from . import backups

        backups.create(kind=backups.UPDATE, note="before the sign-in provider list")
    with SessionLocal() as db:
        if not migration_due(db):
            return None
        # The anchor first: the mirror inside the commit of ``apply`` reads it (module 1.0.10).
        legacy, _subjects = read_legacy(db)
        put_settings(db, {ANCHOR: migrate.anchor_of(legacy)})
        entry = migrate.apply(SqlStore(db), legacy_plan(db))
        settings_service.save(db, {MIGRATED: True})
        return entry


def _take_over(*, backup: bool) -> None:
    """``migrate.resync`` against the fingerprint of the last mirror, then the mirror and the new fingerprint (the
    store's commit does both). The first start with the fingerprint has none stored: nothing is taken over."""
    with SessionLocal() as db:
        legacy, subjects = read_legacy(db)
        previous = str(settings_service.get(db, FINGERPRINT) or "") or None
        found = migrate.changes(previous, migrate.fingerprint(legacy, subjects))
    if found.any and backup:
        from . import backups

        backups.create(kind=backups.UPDATE, note="before taking over the old sign-in settings")
    with SessionLocal() as db:
        store = SqlStore(db)
        legacy, subjects = read_legacy(db)

        def keep_anchor(value: str) -> None:
            put_settings(db, {ANCHOR: value})

        migrate.resync(
            store,
            legacy,
            subjects,
            previous=previous,
            trusts_second_factor=TRUSTED_BEFORE,
            anchor=stored_anchor(db),
            keep_anchor=keep_anchor,
        )
        # Always, also without any provider: the mirror and the fingerprint of what stands there, or a provider set
        # up later in the older version would be thrown away at the next start.
        store.commit()
