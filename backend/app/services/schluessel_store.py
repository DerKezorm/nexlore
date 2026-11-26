"""nexlore's side of the shared key module ``vendor/nexschluessel`` (schluessel 1.0.0): the cards "API-Schlüssel" and
"KI-Werkzeuge (MCP)" under My account › Connections, "Schnittstellen" under Server › General and "API-Schlüssel aller
Konten" under Server › Accounts.

**Every key of before stays valid as it is.** The rows stay in nexlore's own tables (``api_tokens`` for the API
tokens ``nxa_``, ``mcp_keys`` for the MCP keys ``nxl_`` and the connectors of AI tools that signed in by OAuth), the
hashes are the same SHA-256 of the whole key, and the checks on presenting a key stay nexlore's
(``services/apitokens.py``, ``services/mcp.py``: spaces, levels, the operator's ceiling, rights per tool). The ids of
the module are ``api-<row>`` and ``mcp-<row>``: two tables, one list.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, ApiToken, McpKey, Space
from ..security import account_out
from ..vendor import nexschluessel
from ..vendor.nexschluessel import AppConfig, KeyKind
from ..vendor.nexschluessel.model import ALL_AREAS, Area, Holder, Key, KeyChange, NewKey
from . import apitokens, mcp, rights, settings_service, totp

CONFIG = AppConfig(
    app_name="nexlore",
    kinds=(
        KeyKind(id="api", prefix="nxa_", areas=True, default_days=None),
        KeyKind(id="mcp", prefix="nxl_", rights=("read", "draft", "write"), areas=True, expiry_days=None,
                programs_count=True, switch="mcp"),
    ),
    switches=("api", "mcp", "app"),
    programs=True,
    mcp_path="/api/mcp",
    key_id=str,
    error_status={"api_off": 401},
)

#: The operator's switches under nexlore's own names (their defaults in ``settings_service.DEFAULTS``).
SWITCHES = {"api": "api_tokens_allowed", "mcp": "mcp_allowed", "app": "app_pairing_allowed"}
API, MCP = "api-", "mcp-"
EARLIEST = datetime.min.replace(tzinfo=UTC)


def _split(key_id: Any) -> tuple[str, int] | None:
    text = str(key_id)
    for kind, start in (("api", API), ("mcp", MCP)):
        if text.startswith(start) and text[len(start):].isdigit():
            return kind, int(text[len(start):])
    return None


class SchluesselStore:
    """``nexschluessel.Store`` over ``api_tokens`` and ``mcp_keys``, inside one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- reading rows ----------------------------------------------------------------------------------------------

    @staticmethod
    def _api(row: ApiToken) -> Key:
        return Key(id=f"{API}{row.id}", account_id=row.account_id, kind="api", name=row.name, right=row.level,
                   prefix=row.prefix, created_at=row.created_at, last_used_at=row.last_used_at,
                   expires_at=row.expires_at, blocked_at=row.blocked_at,
                   areas=[int(space) for space in row.spaces] if row.spaces is not None else None)

    @staticmethod
    def _mcp(row: McpKey) -> Key:
        return Key(id=f"{MCP}{row.id}", account_id=row.account_id, kind="mcp", name=row.name, right=row.level,
                   prefix=row.prefix, created_at=row.created_at, last_used_at=row.last_used_at,
                   expires_at=row.expires_at, blocked_at=row.blocked_at,
                   areas=[int(space) for space in row.spaces] if row.spaces is not None else None,
                   program=row.kind == "oauth")

    def _all(self, account_id: Any | None = None) -> list[Key]:
        api = select(ApiToken)
        keys = select(McpKey)
        if account_id is not None:
            api = api.where(ApiToken.account_id == int(account_id))
            keys = keys.where(McpKey.account_id == int(account_id))
        found = [self._api(row) for row in self.db.scalars(api)] + [self._mcp(row) for row in self.db.scalars(keys)]
        return sorted(found, key=lambda key: key.created_at or EARLIEST, reverse=True)

    def keys_of(self, account_id: Any) -> list[Key]:
        return self._all(account_id)

    def all_keys(self) -> list[Key]:
        return self._all()

    def _row(self, key_id: Any) -> ApiToken | McpKey | None:
        found = _split(key_id)
        if found is None:
            return None
        kind, number = found
        return self.db.get(ApiToken if kind == "api" else McpKey, number)

    def key(self, key_id: Any) -> Key | None:
        row = self._row(key_id)
        if row is None:
            return None
        return self._api(row) if isinstance(row, ApiToken) else self._mcp(row)

    def key_by_hash(self, token_hash: str) -> Key | None:
        row = self.db.scalar(select(ApiToken).where(ApiToken.token_hash == token_hash))
        if row is not None:
            return self._api(row)
        other = self.db.scalar(select(McpKey).where(McpKey.token_hash == token_hash))
        return self._mcp(other) if other is not None else None

    # --- writing ---------------------------------------------------------------------------------------------------

    def add_key(self, new: NewKey) -> Key:
        spaces = sorted({int(space) for space in new.areas}) if new.areas is not None else None
        if new.kind == "api":
            row: ApiToken | McpKey = ApiToken(
                account_id=int(new.account_id), name=new.name, level=new.right, token_hash=new.token_hash,
                prefix=new.prefix[:16], spaces=spaces, created_at=new.created_at, expires_at=new.expires_at)
        else:
            row = McpKey(account_id=int(new.account_id), name=new.name, level=new.right, token_hash=new.token_hash,
                         prefix=new.prefix[:16], spaces=spaces, created_at=new.created_at, kind="key")
        self.db.add(row)
        self.db.flush()
        found = self.key(f"{API if new.kind == 'api' else MCP}{row.id}")
        assert found is not None
        return found

    def change_key(self, key_id: Any, change: KeyChange) -> Key:
        row = self._row(key_id)
        assert row is not None
        if change.name is not None:
            row.name = change.name
        if change.right is not None:
            row.level = change.right
        if change.areas is not None:
            row.spaces = None if change.areas == ALL_AREAS else sorted({int(space) for space in change.areas})
        self.db.flush()
        found = self.key(key_id)
        assert found is not None
        return found

    def remove_key(self, key_id: Any) -> None:
        row = self._row(key_id)
        if row is not None:
            self.db.delete(row)
            self.db.flush()

    def set_blocked(self, key_id: Any, when: datetime | None) -> None:
        row = self._row(key_id)
        if row is not None:
            row.blocked_at = when
            self.db.flush()

    def touch(self, key_id: Any, when: datetime) -> None:
        row = self._row(key_id)
        if row is not None:
            row.last_used_at = when
            self.db.flush()

    # --- accounts, areas, rules ------------------------------------------------------------------------------------

    def _account(self, account_id: Any) -> Account | None:
        try:
            return self.db.get(Account, int(account_id))
        except (TypeError, ValueError):
            return None

    def holder(self, account_id: Any) -> Holder | None:
        row = self._account(account_id)
        if row is None:
            return None
        return Holder(id=row.id, name=row.name, display_name=row.display_name or "", out=account_out(row))

    def areas_of(self, account_id: Any, kind: str) -> list[Area]:
        """The spaces the account may read, by name."""
        row = self._account(account_id)
        if row is None:
            return []
        readable = rights.readable_ids(self.db, row)
        spaces = self.db.scalars(select(Space).where(Space.id.in_(readable)).order_by(Space.folder)) if readable else []
        return [Area(id=space.id, name=space.folder) for space in spaces]

    def rights_allowed(self, account_id: Any, kind: str) -> list[str]:
        """MCP keys up to the operator's "highest level of a key" (``mcp_max_level``); API tokens as they are."""
        if kind != "mcp":
            return list(apitokens.LEVELS)
        ceiling = mcp.max_level(self.db)
        return [level for level in mcp.LEVELS if mcp.at_least(ceiling, level)]

    def ai_allowed(self, account_id: Any) -> bool:
        """"KI erlaubt" of the account (Server › Konten › Verwalten; MCP decision 10): without it the account makes no
        MCP key and its MCP keys and connectors rest. The operator's main switch is not asked here (ki K8)."""
        from ..vendor import nexki
        from .ki_store import KiStore

        # The module ki answers it for keys and programs (K8): "KI erlaubt" of the account, and the account not out.
        return bool(nexki.chain.for_programs(KiStore(self.db), account_id))

    def keys_wait(self, account_id: Any) -> bool:
        row = self._account(account_id)
        return row is not None and totp.setup_required(self.db, row)

    def switch(self, name: str) -> bool:
        return bool(settings_service.get(self.db, SWITCHES[name]))

    def set_switch(self, name: str, on: bool) -> None:
        settings_service.save(self.db, {SWITCHES[name]: on}, commit=False)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


# --- the old ways (``/api/api-tokens``, ``/api/mcp/keys``, ``/api/admin/api-tokens``) ---------------------------------

#: The module's refusals as the old ways answered them: per kind ``code -> (code, text, status)``.
_OLD_TEXTS = {
    "api": {
        "too_many_keys": ("too_many_tokens", "An account holds at most 20 tokens.", 409),
        "right_invalid": ("invalid_input", "No such level.", 422),
        "days_invalid": ("invalid_input", "A token runs out after 30, 90 or 365 days, or never.", 422),
        "api_off": ("api_off", "The operator has not switched the programming interface (API) on.", 403),
    },
    "mcp": {
        "too_many_keys": ("too_many_keys", "An account holds at most 20 keys.", 409),
        "right_invalid": ("level_not_allowed", "The operator does not allow keys of this level.", 403),
        "mcp_off": ("mcp_off", "The operator has not switched MCP on.", 403),
    },
}
_OLD_COMMON = {
    "choose_areas": ("invalid_input", "Choose spaces you may read.", 422),
    "areas_invalid": ("invalid_input", "Choose spaces you may read.", 422),
    "not_found": ("not_found", "Not found.", 404),
}


def old_refusal(exc: nexschluessel.KeyRefused, kind: str) -> tuple[str, str, int]:
    """A refusal of the module in the form the old way gave it (code, text, status); others as the module says."""
    found = _OLD_TEXTS.get(kind, {}).get(exc.code) or _OLD_COMMON.get(exc.code)
    return found or (exc.public_code, exc.message, exc.status)


def old_id(key_id: Any, kind: str) -> int:
    """The number of a row from the module's id (``api-7`` -> 7)."""
    found = _split(key_id)
    assert found is not None and found[0] == kind
    return found[1]


def store() -> Iterator[SchluesselStore]:
    """The dependency of the module's routes: a store over a session of its own."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield SchluesselStore(db)


__all__ = ["CONFIG", "SWITCHES", "SchluesselStore", "nexschluessel", "old_id", "old_refusal", "store"]
