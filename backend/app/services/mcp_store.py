"""nexlore's side of the shared MCP module ``vendor/nexmcp`` (mcp 1.1.0): the ``Store`` over nexlore's own tables.

**Every key and every connector of before keeps working as it is.** The rows stay in ``mcp_keys`` (keys ``nxl_`` made
in the interface, connectors of AI programs with access ``nxl_`` and refresh ``nxr_``), ``oauth_clients``,
``oauth_codes`` and ``mcp_requests``; nothing is hashed again. The module adds only: ``mcp_spent`` (the last 20 codes
and refresh tokens a connector traded in; the one of 1.16.0 in ``mcp_keys.refresh_old_hash`` still counts),
``mcp_keys.refreshed_at``, ``oauth_codes.resource``/``extras``, ``mcp_requests.decided_by``/``summary``/``dangerous``.

The check of a presented key stays nexlore's (``services/mcp.py`` ``_caller``: account blocked, deleted, locked or
owing the second factor); the module gets a ``Caller`` whose ``account`` is nexlore's own caller (detached account
limited to the key's spaces), which the tools in ``routers/mcp.py`` hand to the routes of the interface.

One class is both stores: ``nexschluessel.Store`` (``SchluesselStore``) and ``nexmcp.Store``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..models import OPERATOR, McpKey, McpRequest, McpSpent, OAuthClient, OAuthCode, utcnow
from ..vendor.nexmcp import Caller, Client, Code, Grant, Program
from ..vendor.nexmcp import Request as ModuleRequest
from . import logs, mcp, settings_service
from .schluessel_store import SchluesselStore

logger = logging.getLogger("nexlore.mcp")

#: The module's settings under nexlore's names (their defaults in ``settings_service.DEFAULTS``).
SETTINGS = {"programs": "mcp_oauth_allowed", "max_level": "mcp_max_level", "blocked_tools": "mcp_blocked_tools"}
#: The rights nexlore gave a key of 1.16.0 until it said otherwise (``services/mcp.py`` ``DEFAULT_RIGHT``): written
#: once onto every key and connector of before (decision 3 holds for new ones only).
FORMER_DEFAULTS = {"change": "ask", "risky": "deny"}
#: The one-time step of the move (``settings``), never set by hand.
MIGRATED = "mcp_110_migrated"


def _key_number(key_id: Any) -> int | None:
    """The row of a key from the module's id: ``12``, ``"12"`` or the key module's ``"mcp-12"``."""
    text_id = str(key_id).removeprefix("mcp-")
    return int(text_id) if text_id.isdigit() and len(text_id) <= 18 else None


class McpStore(SchluesselStore):
    """``nexmcp.Store`` (and ``nexschluessel.Store``) over one session; ``http`` is the HTTP request it serves, for
    tools that need the server's address (public pages). (``request`` is the module's: a waiting request.)"""

    def __init__(self, db: Session, http: Request | None = None) -> None:
        super().__init__(db)
        self.http = http

    # --- who calls ---------------------------------------------------------------------------------------------

    def _module_caller(self, row: McpKey, *, used: bool) -> Caller | None:
        found = mcp._caller(self.db, row, used=used)
        if found is None:
            return None
        account = found.account
        return Caller(
            # The key module's id (``mcp-<n>``, E33): the same key under one name on every page of both modules.
            key_id=f"mcp-{row.id}",
            key_name=row.name,
            account_id=account.id,
            account_name=account.name,
            level=row.level,
            areas=[int(space) for space in row.spaces] if row.spaces is not None else None,
            options={},
            rights=dict(row.tool_rights) if isinstance(row.tool_rights, dict) else {},
            program=row.kind == "oauth",
            admin=account.role == OPERATOR,
            ai_allowed=bool(getattr(account, "ai_allowed", True)),
            account=found,
        )

    def caller(self, token: str) -> Caller | None:
        """nexlore's check as before: the prefix ``nxl_``, the hash, not locked, not run out (a connector's access
        token after an hour); then the account's (``mcp._caller``)."""
        if not token or not token.startswith(mcp.TOKEN_PREFIX) or len(token) > 200:
            return None
        row = self.db.scalar(select(McpKey).where(McpKey.token_hash == mcp.digest(token)))
        if row is None or row.blocked_at is not None or (row.expires_at is not None and row.expires_at <= utcnow()):
            return None
        found = self._module_caller(row, used=True)
        if found is not None:
            logs.set_actor(found.account_name)
        return found

    def caller_of_key(self, key_id: Any) -> Caller | None:
        number = _key_number(key_id)
        row = self.db.get(McpKey, number) if number is not None else None
        if row is None or row.blocked_at is not None:
            return None
        return self._module_caller(row, used=False)

    def count_keys(self, account_id: Any) -> int:
        return int(self.db.scalar(select(func.count()).select_from(McpKey).where(McpKey.account_id == int(account_id)))
                   or 0)

    def account_may(self, account_id: Any) -> bool:
        """No new tokens for an account that is locked, gone, or still owes the second factor the operator requires."""
        from . import totp

        row = self._account(account_id)
        if row is None or row.blocked_at is not None or row.deleted_at is not None or (
            row.locked_until is not None and row.locked_until > utcnow()
        ):
            return False
        return not totp.setup_required(self.db, row)

    def key_areas(self, account_id: Any) -> list[dict[str, Any]]:
        from . import paths

        return [{"id": area.id, "name": area.name} for area in self.areas_of(account_id, "mcp")
                if paths.space_present(str(area.name))]

    # --- settings ----------------------------------------------------------------------------------------------

    def mcp_on(self) -> bool:
        return self.switch("mcp")

    def setting(self, name: str) -> Any:
        return settings_service.get(self.db, SETTINGS[name])

    def set_setting(self, name: str, value: Any) -> None:
        settings_service.save(self.db, {SETTINGS[name]: value}, commit=False)

    def key_rights(self, key_id: Any) -> dict[str, str]:
        number = _key_number(key_id)
        row = self.db.get(McpKey, number) if number is not None else None
        return dict(row.tool_rights) if row is not None and isinstance(row.tool_rights, dict) else {}

    def set_key_rights(self, key_id: Any, rights: dict[str, str]) -> None:
        number = _key_number(key_id)
        row = self.db.get(McpKey, number) if number is not None else None
        if row is not None:
            row.tool_rights = dict(rights) or None
            self.db.flush()

    # --- OAuth -------------------------------------------------------------------------------------------------

    def _client(self, row: OAuthClient) -> Client:
        in_use = self.db.scalar(select(McpKey.id).where(McpKey.client_id == row.id).limit(1)) is not None
        return Client(id=row.id, name=row.name or "", redirect_uris=tuple(row.redirect_uris or ()),
                      created_at=row.created_at or utcnow(), last_used_at=row.last_used_at, in_use=in_use)

    def add_client(self, client: Client) -> None:
        self.db.add(OAuthClient(id=client.id, name=client.name[:100], redirect_uris=list(client.redirect_uris),
                                created_at=client.created_at))
        self.db.flush()

    def client(self, client_id: str) -> Client | None:
        row = self.db.get(OAuthClient, client_id) if client_id and len(client_id) <= 64 else None
        return None if row is None else self._client(row)

    def clients(self) -> list[Client]:
        return [self._client(row) for row in self.db.scalars(select(OAuthClient))]

    def remove_client(self, client_id: str) -> None:
        self.db.execute(delete(OAuthClient).where(OAuthClient.id == client_id))

    def touch_client(self, client_id: str, when: datetime) -> None:
        self.db.execute(update(OAuthClient).where(OAuthClient.id == client_id).values(last_used_at=when))

    def add_code(self, code: Code) -> None:
        self.db.execute(delete(OAuthCode).where(OAuthCode.expires_at <= utcnow()))
        self.db.add(OAuthCode(code_hash=code.code_hash, client_id=code.client_id, account_id=int(code.account_id),
                              redirect_uri=code.redirect_uri, challenge=code.challenge, level=code.level,
                              spaces=[int(area) for area in code.areas] if code.areas is not None else None,
                              expires_at=code.expires_at, resource=code.resource, extras=dict(code.options)))
        self.db.flush()

    def take_code(self, code_hash: str) -> Code | None:
        row = self.db.get(OAuthCode, code_hash)
        if row is None:
            return None
        found = Code(code_hash=row.code_hash, client_id=row.client_id, account_id=row.account_id,
                     redirect_uri=row.redirect_uri, challenge=row.challenge, level=row.level,
                     areas=list(row.spaces) if row.spaces is not None else None,
                     options=dict(row.extras) if isinstance(row.extras, dict) else {},
                     expires_at=row.expires_at, resource=row.resource or "")
        # Taken away in the same step: a code is traded once, even when two requests bring it at the same moment.
        gone = self.db.execute(delete(OAuthCode).where(OAuthCode.code_hash == code_hash)).rowcount
        self.db.expunge(row)
        return found if gone == 1 else None

    def has_program(self, account_id: Any, client_id: str) -> bool:
        return self._program_row(account_id, client_id) is not None

    def _program_row(self, account_id: Any, client_id: str) -> McpKey | None:
        return self.db.scalar(select(McpKey).where(McpKey.account_id == int(account_id), McpKey.kind == "oauth",
                                                   McpKey.client_id == client_id))

    def program_signed_in(self, account_id: Any, client: Client, *, level: str, areas: list[Any] | None,
                          options: dict[str, bool], grant: Grant, now: datetime) -> Any:
        row = self._program_row(account_id, client.id)
        spaces = sorted({int(area) for area in areas}) if areas is not None else None
        if row is None:
            row = McpKey(account_id=int(account_id), name=client.name[:100] or "MCP", kind="oauth",
                         client_id=client.id, level=level, spaces=spaces, token_hash=grant.access_hash,
                         prefix=grant.access_prefix[:16], created_at=now)
            self.db.add(row)
        else:
            # Signing in again keeps the rights per tool that were set for this connector.
            row.level, row.spaces = level, spaces
            row.token_hash, row.prefix = grant.access_hash, grant.access_prefix[:16]
        row.expires_at = grant.access_expires
        row.refresh_old_hash = None
        row.refresh_hash = grant.refresh_hash
        row.signed_in_at = now
        row.refreshed_at = now
        self.db.flush()
        logger.info("MCP connector signed in key_id=%s", row.id)
        return row.id

    @staticmethod
    def _program(row: McpKey | None) -> Program | None:
        if row is None or row.client_id is None:
            return None
        signed = row.signed_in_at or row.created_at or utcnow()
        # A connector of 1.16.0 has no refreshed_at: its access token ran out an hour after its last refresh.
        refreshed = row.refreshed_at or (row.expires_at - timedelta(hours=1) if row.expires_at else signed)
        return Program(key_id=row.id, account_id=row.account_id, client_id=row.client_id, signed_in_at=signed,
                       refreshed_at=refreshed)

    def program_by_refresh(self, refresh_hash: str) -> Program | None:
        return self._program(self.db.scalar(select(McpKey).where(McpKey.refresh_hash == refresh_hash,
                                                                 McpKey.client_id.is_not(None))))

    def program_of_token(self, token_hash: str) -> Program | None:
        return self._program(self.db.scalar(select(McpKey).where(
            McpKey.client_id.is_not(None), (McpKey.refresh_hash == token_hash) | (McpKey.token_hash == token_hash))))

    def program_refreshed(self, key_id: Any, grant: Grant, now: datetime) -> None:
        row = self.db.get(McpKey, int(key_id))
        if row is None:
            return
        row.token_hash, row.prefix = grant.access_hash, grant.access_prefix[:16]
        row.expires_at = grant.access_expires
        if row.refresh_old_hash:
            # The token 1.16.0 kept as spent stays known as spent.
            self.db.merge(McpSpent(token_hash=row.refresh_old_hash, key_id=row.id, spent_at=now))
        # The one before stays where 1.16.0 kept it, too: a way back to it still knows a copy.
        row.refresh_old_hash = row.refresh_hash
        row.refresh_hash = grant.refresh_hash
        row.refreshed_at = now
        self.db.flush()

    def spend(self, key_id: Any, token_hash: str, keep: int) -> None:
        self.db.merge(McpSpent(token_hash=token_hash, key_id=int(key_id), spent_at=utcnow()))
        self.db.flush()
        kept = select(McpSpent.token_hash).where(McpSpent.key_id == int(key_id)).order_by(
            McpSpent.spent_at.desc()).limit(keep)
        self.db.execute(delete(McpSpent).where(McpSpent.key_id == int(key_id), McpSpent.token_hash.not_in(kept)))

    def spent_by(self, token_hash: str) -> Any:
        row = self.db.get(McpSpent, token_hash)
        if row is not None:
            return row.key_id
        # The refresh token a connector of 1.16.0 traded last.
        return self.db.scalar(select(McpKey.id).where(McpKey.refresh_old_hash == token_hash,
                                                      McpKey.client_id.is_not(None)))

    def end_program(self, key_id: Any) -> None:
        number = _key_number(key_id)
        if number is None:
            return
        self.db.execute(delete(McpSpent).where(McpSpent.key_id == number))
        self.db.execute(delete(McpKey).where(McpKey.id == number))
        logger.warning("MCP connector ended key_id=%s", number)

    # --- requests ----------------------------------------------------------------------------------------------

    @staticmethod
    def _request(row: McpRequest | None) -> ModuleRequest | None:
        if row is None:
            return None
        return ModuleRequest(
            id=row.id, account_id=row.account_id, key_id=f"mcp-{row.key_id}", key_name=row.key_name, tool=row.tool,
            arguments=row.arguments, digest=row.digest, status=row.status, created_at=row.created_at,
            expires_at=row.expires_at, decided_at=row.decided_at, decided_by=row.decided_by or "",
            result=row.result or None, summary=row.summary or "", dangerous=bool(row.dangerous),
        )

    def add_request(self, request: ModuleRequest) -> ModuleRequest:
        row = McpRequest(account_id=int(request.account_id), key_id=_key_number(request.key_id),
                         key_name=request.key_name,
                         tool=request.tool, arguments=request.arguments, digest=request.digest, status=request.status,
                         created_at=request.created_at, expires_at=request.expires_at, summary=request.summary[:300],
                         dangerous=request.dangerous, result="")
        self.db.add(row)
        self.db.flush()
        found = self._request(row)
        assert found is not None
        return found

    def request(self, request_id: Any) -> ModuleRequest | None:
        number = _key_number(request_id)
        return self._request(self.db.get(McpRequest, number)) if number is not None else None

    def requests_of(self, account_id: Any) -> list[ModuleRequest]:
        rows = self.db.scalars(select(McpRequest).where(McpRequest.account_id == int(account_id))
                               .order_by(McpRequest.id.desc()).limit(200))
        return [found for row in rows if (found := self._request(row)) is not None]

    def count_waiting(self, account_id: Any, key_id: Any = None) -> int:
        query = select(func.count()).select_from(McpRequest).where(McpRequest.account_id == int(account_id),
                                                                   McpRequest.status == "waiting")
        if key_id is not None:
            query = query.where(McpRequest.key_id == _key_number(key_id))
        return int(self.db.scalar(query) or 0)

    def claim(self, request_id: Any, status: str, *, now: datetime, by: str = "") -> bool:
        taken = self.db.execute(update(McpRequest).where(McpRequest.id == int(request_id),
                                                         McpRequest.status == "waiting")
                                .values(status=status, decided_at=now, decided_by=by[:100]))
        self.db.expire_all()
        return bool(taken.rowcount == 1)

    def finish(self, request_id: Any, status: str, result: str | None, now: datetime) -> None:
        self.db.execute(update(McpRequest).where(McpRequest.id == int(request_id))
                        .values(status=status, result=result or "", decided_at=now))
        self.db.expire_all()

    def expire(self, now: datetime) -> int:
        changed = self.db.execute(update(McpRequest).where(McpRequest.status == "waiting",
                                                           McpRequest.expires_at <= now)
                                  .values(status="expired", decided_at=now))
        self.db.expire_all()
        return int(changed.rowcount or 0)


def store(request: Request) -> Iterator[McpStore]:
    """The dependency of the module's routes: a store over a session of its own, knowing its request."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield McpStore(db, request)


# --- the move to the module, once ---------------------------------------------------------------------------------


def migrate(engine: Engine, groups: dict[str, str]) -> None:
    """Every key and connector of before keeps the rights it had (Entwurf MCP-Modul, "Alte Zugänge"): what was asked
    (group ``change``) or denied (``risky``) by nexlore's old defaults is written onto it, where it did not set the
    tool itself. New keys start with "allow everything of the level" (decision 3). ``groups``: tool -> group. Once,
    on a database of an older version; a fresh one only marks it done."""
    with Session(engine) as db:
        if settings_service.get(db, MIGRATED):
            return
        rows = db.scalars(select(McpKey)).all()
        for row in rows:
            own = dict(row.tool_rights) if isinstance(row.tool_rights, dict) else {}
            for tool, group in groups.items():
                if tool not in own and group in FORMER_DEFAULTS:
                    own[tool] = FORMER_DEFAULTS[group]
            row.tool_rights = own or None
        settings_service.save(db, {MIGRATED: True})
        if rows:
            logger.info("MCP keys of an older version keep their rights count=%s", len(rows))
    _requests_outlive_their_key(engine)


def _requests_outlive_their_key(engine: Engine) -> None:
    """A database of 1.16.0 links ``mcp_requests.key_id`` to its key with ``ON DELETE CASCADE``: a revoked key took
    its requests along. The table is built again without that link, every row and column kept (the way back reads it
    as before); the backup before the added columns of this start holds the state before."""
    from ..models import McpRequest as Row

    with engine.connect() as connection:
        links = connection.execute(text("PRAGMA foreign_key_list(mcp_requests)")).mappings().all()
        if not any(link["table"] == "mcp_keys" for link in links):
            return
        columns = [row["name"] for row in connection.execute(text("PRAGMA table_info(mcp_requests)")).mappings()]
        connection.commit()
        # Off outside a transaction (inside, SQLite ignores it), so that the rename does not touch the links of others.
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        try:
            connection.execute(text("ALTER TABLE mcp_requests RENAME TO mcp_requests_before_110"))
            for index in Row.__table__.indexes:
                connection.execute(text(f'DROP INDEX IF EXISTS "{index.name}"'))
            Row.__table__.create(connection)
            kept = ", ".join(f'"{name}"' for name in columns if name in Row.__table__.columns)
            connection.execute(text(f"INSERT INTO mcp_requests ({kept}) SELECT {kept} FROM mcp_requests_before_110"))  # noqa: S608
            connection.execute(text("DROP TABLE mcp_requests_before_110"))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            connection.commit()
    logger.info("MCP requests outlive their key now")


__all__ = ["McpStore", "migrate", "store"]
