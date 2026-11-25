"""nexschluessel contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexschluessel/`` run the module against nexlore's real store
(``app.services.schluessel_store``) over ``api_tokens`` and ``mcp_keys``, and present every form of key nexlore 1.16.0
made to its real ways: ``GET /api/v1/me`` (API tokens ``nxa_``) and ``POST /api/mcp`` (MCP keys ``nxl_`` made in the
interface, and the access tokens of connectors that signed in by OAuth). The database is the one of the test session
(``tests/conftest.py`` empties it before every test).
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

from schluessel_contract import LegacyKey, StandardAdapter

TAB = {"X-Nexlore-Client": "tab-contract"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexschluessel"
    prefix = "/api/connections"

    def start(self) -> None:
        """Three accounts (owner and other members with a password and a space each, the operator); the operator's
        switches for API and MCP open, as an operator using keys has them."""
        from app.db import SessionLocal
        from app.models import MANAGE, MEMBER, OPERATOR, Membership, Space
        from app.services import apitokens, mcp, settings_service
        from tests.conftest import make_account

        apitokens.forget()
        mcp.forget()
        self.accounts = {name: make_account(name, OPERATOR if name == "operator" else MEMBER)
                         for name in ("owner", "other", "operator")}
        self.spaces: dict[str, int] = {}
        with SessionLocal() as db:
            for name in ("owner", "other"):
                space = Space(folder=f"{name.title()} space")
                db.add(space)
                db.flush()
                db.add(Membership(space_id=space.id, account_id=self.accounts[name].id, role=MANAGE))
                self.spaces[name] = space.id
            db.commit()
            settings_service.save(db, {"api_tokens_allowed": True, "mcp_allowed": True, "mcp_max_level": "write"})
        self.clients: dict[str, Any] = {}

    def stop(self) -> None:
        for client in self.clients.values():
            client.close()

    def config(self) -> Any:
        from app.services.schluessel_store import CONFIG

        return CONFIG

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import sign_in

        if role not in self.clients:
            browser = TestClient(app, base_url="http://testserver", headers=TAB)
            if role != "anonymous":
                sign_in(browser, self.accounts[role])
            self.clients[role] = browser
        return self.clients[role]

    def legacy_keys(self) -> list[LegacyKey]:
        return [
            LegacyKey("API token (read)", "api", "nxa_", "read"),
            LegacyKey("API token (write)", "api", "nxa_", "write"),
            LegacyKey("MCP key made by hand (read)", "mcp", "nxl_", "read"),
            LegacyKey("MCP key made by hand (write)", "mcp", "nxl_", "write"),
            LegacyKey("connector of an AI tool", "mcp", "nxl_", "draft", program=True),
        ]

    def make_legacy(self, spec: LegacyKey, *, account: str = "owner", expired: bool = False) -> str:
        """As nexlore 1.16.0 made them: ``apitokens.make``, ``mcp.make_key`` and the token endpoint of OAuth."""
        from app.db import SessionLocal
        from app.models import Account, McpKey, OAuthClient, utcnow
        from app.routers import oauth
        from app.services import apitokens, mcp

        with SessionLocal() as db:
            row = db.get(Account, self.accounts[account].id)
            assert row is not None
            if spec.kind == "api":
                made, token = apitokens.make(db, row, spec.label, spec.right, days=90)
                if expired:
                    made.expires_at = utcnow() - timedelta(hours=1)
                    db.commit()
                return token
            if not spec.program:
                key, token = mcp.make_key(db, row, spec.label, spec.right)
                if expired:
                    key.expires_at = utcnow() - timedelta(hours=1)
                    db.commit()
                return token
            client = OAuthClient(id=f"nxo_{secrets.token_hex(8)}", name=spec.label, redirect_uris=["https://example.com/cb"])
            db.add(client)
            program = McpKey(account_id=row.id, name=spec.label, kind="oauth", client_id=client.id, level=spec.right,
                             spaces=None, token_hash="", prefix="", created_at=utcnow(), signed_in_at=utcnow())
            db.add(program)
            db.flush()
            answer = oauth._issue(db, program)
            if expired:
                program.expires_at = utcnow() - timedelta(minutes=1)
                db.commit()
            return str(answer["access_token"])

    def probe(self, kind: str, secret: str) -> int:
        from fastapi.testclient import TestClient

        from app.main import app

        program = TestClient(app, base_url="http://testserver")
        headers = {"Authorization": f"Bearer {secret}"}
        if kind == "mcp":
            body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "probe"}}}
            return program.post("/api/mcp", headers=headers, json=body).status_code
        return program.get("/api/v1/me", headers=headers).status_code

    def owe_factor(self) -> None:
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            settings_service.save(db, {"two_factor_required": True})

    def foreign_area(self) -> Any:
        return self.spaces["other"]
