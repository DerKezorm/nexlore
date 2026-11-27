"""nexmcp contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexmcp/`` run the module inside nexlore: the store over ``mcp_keys``,
``oauth_clients``, ``oauth_codes``, ``mcp_requests`` and ``mcp_spent`` (``services/mcp_store.py``), nexlore's tools and
answers of before (``routers/mcp.py`` ``CONFIG``), the consent of before (``routers/oauth.py``), the key module's ways
under ``/api/connections``. The database is the one of the test session (``tests/conftest.py`` empties it before
every test); "older" writes keys and a connector the way nexlore 1.16.0 did, then runs the move of 1.1.0 over it.
"""

from __future__ import annotations

import secrets
from typing import Any

from mcp_contract import LegacyKey, LegacyProgram, StandardAdapter

TAB = {"X-Nexlore-Client": "tab-contract"}
REDIRECT = "http://127.0.0.1:33418/callback"


class Adapter(StandardAdapter):
    package = "app.vendor.nexmcp"
    keys_prefix = "/api/connections"
    prefix = "/api/connections/mcp"
    has_ai = True
    #: nexlore had MCP off until the operator opened it.
    older_had_mcp_on = False

    def start(self) -> None:
        """owner and other with a space and a note each, the operator; the highest level an operator who lets keys
        change things sets (nexlore's ceiling is ``read`` from the start)."""
        from app.db import SessionLocal
        from app.models import MANAGE, MEMBER, OPERATOR, Membership, Space
        from app.routers import oauth
        from app.services import apitokens, index, mcp, settings_service
        from tests.conftest import VAULT, make_account

        apitokens.forget()
        mcp.forget()
        oauth.forget()
        self.accounts = {name: make_account(name, OPERATOR if name == "operator" else MEMBER)
                         for name in ("owner", "other", "operator")}
        with SessionLocal() as db:
            for name, note in (("owner", "Groceries"), ("other", "Diary")):
                folder = f"{name.title()} space"
                (VAULT / folder).mkdir(parents=True, exist_ok=True)
                (VAULT / folder / f"{note}.md").write_text(f"# {note}\n\nmilk\n", encoding="utf-8")
                space = Space(folder=folder)
                db.add(space)
                db.flush()
                db.add(Membership(space_id=space.id, account_id=self.accounts[name].id, role=MANAGE))
            db.commit()
            settings_service.save(db, {"mcp_max_level": "write"})
        index.scan()
        self.clients: dict[str, Any] = {}
        self.legacy: dict[str, str] = {}
        self.program: LegacyProgram | None = None
        self._listen()

    def _listen(self) -> None:
        from app.routers import mcp as mcp_routes

        self.heard: list[tuple[str, Any]] = []
        self._listener = lambda event, found: self.heard.append((event, found.id))
        mcp_routes.LISTENERS.append(self._listener)

    def start_older(self) -> None:
        """As 1.16.0 left it: an MCP key made in the interface, a connector with its refresh token, MCP opened by the
        operator; then the move of 1.1.0 (``mcp_store.migrate``) as at the start of the new version."""
        from datetime import timedelta

        from app.db import SessionLocal, engine
        from app.models import McpKey, OAuthClient, utcnow
        from app.routers.mcp import GROUPS
        from app.services import mcp, mcp_store, settings_service

        self.start()
        with SessionLocal() as db:
            settings_service.save(db, {"mcp_allowed": True, mcp_store.MIGRATED: False})
            owner = self.accounts["owner"].id
            hand = mcp.TOKEN_PREFIX + secrets.token_urlsafe(32)
            db.add(McpKey(account_id=owner, name="old key", level="write", token_hash=mcp.digest(hand),
                          prefix=hand[:8], spaces=None, created_at=utcnow(), kind="key"))
            client = OAuthClient(id=f"nxo_{secrets.token_hex(8)}", name="Old program", redirect_uris=[REDIRECT])
            db.add(client)
            access = mcp.TOKEN_PREFIX + secrets.token_urlsafe(32)
            refresh = "nxr_" + secrets.token_urlsafe(32)
            db.add(McpKey(account_id=owner, name="Old program", kind="oauth", client_id=client.id, level="read",
                          spaces=None, token_hash=mcp.digest(access), prefix=access[:8], created_at=utcnow(),
                          signed_in_at=utcnow(), refresh_hash=mcp.digest(refresh),
                          expires_at=utcnow() + timedelta(hours=1)))
            db.commit()
        mcp_store.migrate(engine, GROUPS)
        self.legacy = {"hand": hand, "access": access}
        self.program = LegacyProgram(client.id, REDIRECT, refresh)
        self._listen()

    def stop(self) -> None:
        from app.routers import mcp as mcp_routes

        for client in self.clients.values():
            client.close()
        if getattr(self, "_listener", None) in mcp_routes.LISTENERS:
            mcp_routes.LISTENERS.remove(self._listener)

    def notified(self) -> list[tuple[str, Any]]:
        """Every call of nexlore's ``notify`` (``routers/mcp._notify``: the bell's list, webhook and mail), in order."""
        return list(self.heard)

    def change_arguments(self, request_id: Any, arguments: str) -> None:
        from app.db import SessionLocal
        from app.models import McpRequest

        with SessionLocal() as db:
            row = db.get(McpRequest, int(request_id))
            assert row is not None
            row.arguments = arguments
            db.commit()

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import sign_in

        if role not in self.clients:
            # A program (anonymous) sends no tab: the guard of changing requests must let its ways through.
            browser = TestClient(app, base_url="http://testserver", headers=TAB if role != "anonymous" else {})
            if role != "anonymous":
                sign_in(browser, self.accounts[role])
            self.clients[role] = browser
        return self.clients[role]

    def config(self) -> Any:
        from app.routers.mcp import CONFIG

        return CONFIG

    def keys_config(self) -> Any:
        from app.services.schluessel_store import CONFIG

        return CONFIG

    def read_call(self) -> tuple[str, dict[str, Any]]:
        return "read_note", {"path": "Owner space/Groceries.md"}

    def change_call(self) -> tuple[str, dict[str, Any]]:
        return "create_note", {"folder": "Owner space", "title": "From the program", "content": "Hello"}

    def foreign_call(self) -> tuple[str, dict[str, Any]]:
        return "read_note", {"path": "Other space/Diary.md"}

    def legacy_keys(self) -> list[LegacyKey]:
        return [LegacyKey("MCP key made in the interface", "hand"), LegacyKey("access token of a connector", "access")]

    def make_legacy(self, spec: LegacyKey) -> str:
        return self.legacy[spec.form]

    def legacy_program(self) -> LegacyProgram | None:
        return self.program

    def _ai(self, account: str, allowed: bool) -> None:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.get(Account, self.accounts[account].id)
            assert row is not None
            row.ai_allowed = allowed
            db.commit()

    def take_ai(self, account: str = "owner") -> None:
        self._ai(account, False)

    def give_ai(self, account: str = "owner") -> None:
        self._ai(account, True)
