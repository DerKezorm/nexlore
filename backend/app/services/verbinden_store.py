"""nexlore's side of the shared module verbinden (``vendor/nexverbinden`` 0.1.3, plan "Entwurf Apps verbinden"): its
``AppConfig`` and the ``Store`` over the tables of ``models_verbinden``.

nexlore is only the host in the catalog (Runde 2, Teil B): nexnotes puts a note into a space of nexlore
(``notes.add``). What a connection opens here is ``/api/v1`` with the right to make a note, and to see the spaces it may
make one in, only in the spaces given (``routers/v1.caller``); the areas of a connection are nexlore's spaces the
account may write in. nexlore asks no partner itself.

⚠️ **Old connections notice nothing.** nexlore had none with another nex app; its API tokens (``nxa_``) stay as they
are and keep working at ``/api/v1``. A token of nexlore that a partner had typed in ends itself after the partner
connected anew (``retire_key``).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import __version__
from ..models import WRITE, Account, ApiToken, Setting, Space
from ..models_verbinden import (
    AppConnection,
    AppConnectionCode,
    AppConnectionPending,
    AppConnectionSpent,
    AppConnectionWaiting,
)
from ..security import account_out, decrypt_secret, encrypt_secret
from ..vendor import nexverbinden
from . import apitokens, paths, rights, settings_service

logger = logging.getLogger("nexlore.connect")

#: nexlore's tokens for its partners: never the start of one of its keys (``nxa_``, ``nxl_``, ``nxr_``, ``nxc_``,
#: ``nxe_``, ``nxd_``). Partner in use (V20): nexnotes, which puts notes into nexlore (it grants ``notes.add``).
CONFIG = nexverbinden.AppConfig(app_name="nexlore", version=__version__, access_prefix="nxv_",
                                refresh_prefix="nxvr_", code_prefix="nxvc_", in_use=("nexnotes",))
#: The module's settings under nexlore's names (``connect.connections``, ``connect.addresses``).
SETTING_PREFIX = "connect."
#: How the sealing of the module's secrets is told apart from nexlore's other sealed texts.
SEAL_CONTEXT = "verbinden"


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _list(value: Any) -> list[Any] | None:
    return list(value) if value is not None else None


class VerbindenStore:
    """``nexverbinden.Store`` inside one session (one request)."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- connections ------------------------------------------------------------------------------------------------

    @staticmethod
    def _connection(row: AppConnection | None) -> nexverbinden.Connection | None:
        if row is None:
            return None
        return nexverbinden.Connection(
            id=row.id, account_id=row.account_id, partner=row.partner, partner_base=row.partner_base,
            partner_account=row.partner_account, uses=tuple(row.uses or ()), grants=tuple(row.grants or ()),
            areas_granted=_list(row.areas_granted), areas_used=_list(row.areas_used), held=row.held,
            issued_access_hash=row.issued_access_hash, issued_refresh_hash=row.issued_refresh_hash,
            issued_access_expires=_aware(row.issued_access_expires) or datetime.now(UTC),
            created_at=_aware(row.created_at) or datetime.now(UTC), used_at=_aware(row.used_at),
            ok_at=_aware(row.ok_at), state=row.state, stale_since=_aware(row.stale_since), problem=row.problem,
            partner_version=row.partner_version or "",
        )

    def connections(self, account_id: Any) -> list[nexverbinden.Connection]:
        rows = self.db.scalars(select(AppConnection).where(AppConnection.account_id == int(account_id))
                               .order_by(AppConnection.partner))
        return [found for row in rows if (found := self._connection(row)) is not None]

    def connection(self, account_id: Any, partner: str) -> nexverbinden.Connection | None:
        return self._connection(self.db.scalar(select(AppConnection).where(
            AppConnection.account_id == int(account_id), AppConnection.partner == partner)))

    def by_issued_access(self, token_hash: str) -> nexverbinden.Connection | None:
        return self._connection(self.db.scalar(select(AppConnection)
                                               .where(AppConnection.issued_access_hash == token_hash)))

    def by_issued_refresh(self, token_hash: str) -> nexverbinden.Connection | None:
        return self._connection(self.db.scalar(select(AppConnection)
                                               .where(AppConnection.issued_refresh_hash == token_hash)))

    def save(self, c: nexverbinden.Connection) -> None:
        row = self.db.get(AppConnection, c.id)
        if row is None:
            # One connection per account and partner: a new one takes the place of one of before.
            self.db.execute(delete(AppConnection).where(AppConnection.account_id == int(c.account_id),
                                                        AppConnection.partner == c.partner))
            row = AppConnection(id=c.id)
            self.db.add(row)
        row.account_id = int(c.account_id)
        row.partner, row.partner_base, row.partner_account = c.partner, c.partner_base, c.partner_account
        row.uses, row.grants = list(c.uses), list(c.grants)
        row.areas_granted, row.areas_used = c.areas_granted, c.areas_used
        row.held = c.held
        row.issued_access_hash, row.issued_refresh_hash = c.issued_access_hash, c.issued_refresh_hash
        row.issued_access_expires, row.created_at = c.issued_access_expires, c.created_at
        row.used_at, row.ok_at, row.state, row.stale_since = c.used_at, c.ok_at, c.state, c.stale_since
        row.problem, row.partner_version = c.problem, c.partner_version
        self.db.flush()

    def remove(self, connection_id: str) -> None:
        self.db.execute(delete(AppConnection).where(AppConnection.id == connection_id))
        self.db.execute(delete(AppConnectionSpent).where(AppConnectionSpent.connection_id == connection_id))

    # --- started connections and codes -----------------------------------------------------------------------------

    def add_pending(self, p: nexverbinden.Pending) -> None:
        self.db.add(AppConnectionPending(state_hash=p.state_hash, account_id=int(p.account_id), partner=p.partner,
                                         partner_base=p.partner_base, verifier=p.verifier,
                                         areas_granted=p.areas_granted, created_at=p.created_at))
        self.db.flush()

    def take_pending(self, state_hash: str) -> nexverbinden.Pending | None:
        row = self.db.get(AppConnectionPending, state_hash)
        if row is None:
            return None
        found = nexverbinden.Pending(state_hash=row.state_hash, account_id=row.account_id, partner=row.partner,
                                     partner_base=row.partner_base, verifier=row.verifier,
                                     areas_granted=_list(row.areas_granted),
                                     created_at=_aware(row.created_at) or datetime.now(UTC))
        self.db.delete(row)
        self.db.flush()
        return found

    def add_code(self, c: nexverbinden.Code) -> None:
        self.db.add(AppConnectionCode(code_hash=c.code_hash, account_id=int(c.account_id), partner=c.partner,
                                      partner_base=c.partner_base, redirect_uri=c.redirect_uri,
                                      challenge=c.challenge, areas_granted=c.areas_granted, expires_at=c.expires_at))
        self.db.flush()

    def take_code(self, code_hash: str) -> nexverbinden.Code | None:
        row = self.db.get(AppConnectionCode, code_hash)
        if row is None:
            return None
        found = nexverbinden.Code(code_hash=row.code_hash, account_id=row.account_id, partner=row.partner,
                                  partner_base=row.partner_base, redirect_uri=row.redirect_uri,
                                  challenge=row.challenge, areas_granted=_list(row.areas_granted),
                                  expires_at=_aware(row.expires_at) or datetime.now(UTC))
        self.db.delete(row)
        self.db.flush()
        return found

    # --- spent ------------------------------------------------------------------------------------------------------

    def spend(self, connection_id: str, token_hash: str, keep: int) -> None:
        at = int(self.db.scalar(select(func.coalesce(func.max(AppConnectionSpent.at), 0))) or 0) + 1
        self.db.merge(AppConnectionSpent(token_hash=token_hash, connection_id=connection_id, at=at))
        self.db.flush()
        kept = (select(AppConnectionSpent.at).where(AppConnectionSpent.connection_id == connection_id)
                .order_by(AppConnectionSpent.at.desc()).limit(keep))
        self.db.execute(delete(AppConnectionSpent).where(AppConnectionSpent.connection_id == connection_id,
                                                         AppConnectionSpent.at.not_in(kept)))

    def spent_by(self, token_hash: str) -> str | None:
        row = self.db.get(AppConnectionSpent, token_hash)
        return row.connection_id if row is not None else None

    # --- revocations that wait ----------------------------------------------------------------------------------------

    def revoke_later(self, account_id: Any, partner_base: str, sealed_token: str, now: datetime) -> None:
        self.db.add(AppConnectionWaiting(account_id=int(account_id), partner_base=partner_base, token=sealed_token,
                                         since=now))
        self.db.flush()

    def waiting(self) -> list[nexverbinden.Waiting]:
        rows = self.db.scalars(select(AppConnectionWaiting).order_by(AppConnectionWaiting.id))
        return [nexverbinden.Waiting(row.id, row.partner_base, row.token, _aware(row.since) or datetime.now(UTC))
                for row in rows]

    def done_waiting(self, waiting_id: Any) -> None:
        self.db.execute(delete(AppConnectionWaiting).where(AppConnectionWaiting.id == int(waiting_id)))

    # --- the account and the app ------------------------------------------------------------------------------------

    def account_may(self, account_id: Any) -> bool:
        account = self.db.get(Account, int(account_id))
        return account is not None and not account_out(account)

    def account_name(self, account_id: Any) -> str:
        account = self.db.get(Account, int(account_id))
        return (account.display_name or account.name) if account is not None else ""

    def areas(self, account_id: Any) -> list[dict[str, Any]]:
        """The spaces the account may write in (a note can go only there), by their names."""
        account = self.db.get(Account, int(account_id))
        if account is None:
            return []
        ids = [space_id for space_id in rights.readable_ids(self.db, account)
               if rights.at_least(rights.role_in(self.db, account, space_id), WRITE)]
        rows = self.db.execute(select(Space.id, Space.folder).where(Space.id.in_(ids))).all()
        return [{"id": space_id, "name": folder} for space_id, folder in sorted(rows, key=lambda row: row[1].lower())
                if paths.space_present(folder)]

    def legacy(self, account_id: Any) -> list[nexverbinden.Legacy]:
        """nexlore had no connection with another nex app typed in by hand."""
        return []

    def retire_key(self, token: str) -> bool:
        """An API token of nexlore that a partner had typed in ends itself (after the partner connected anew)."""
        if not token.startswith(apitokens.TOKEN_PREFIX):
            return False
        row = self.db.scalar(select(ApiToken).where(ApiToken.token_hash == apitokens.digest(token)))
        if row is None:
            return False
        logger.info("An API token ended itself after a new connection token_id=%s", row.id)
        self.db.delete(row)
        self.db.flush()
        return True

    def setting(self, name: str) -> Any:
        row = self.db.get(Setting, SETTING_PREFIX + name)
        return None if row is None else row.value

    def set_setting(self, name: str, value: Any) -> None:
        row = self.db.get(Setting, SETTING_PREFIX + name)
        if row is None:
            self.db.add(Setting(key=SETTING_PREFIX + name, value=value))
        else:
            row.value = value
        self.db.flush()

    def local_allowed(self) -> bool:
        return bool(settings_service.get(self.db, "connections_local_network"))

    def seal(self, text: str) -> str:
        return encrypt_secret(text, SEAL_CONTEXT)

    def unseal(self, sealed: str) -> str:
        return decrypt_secret(sealed, SEAL_CONTEXT)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()
