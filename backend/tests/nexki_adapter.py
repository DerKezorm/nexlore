"""nexki contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexki/`` run the module inside nexlore: the store over nexlore's own fields
(``services/ki_store.py``), the module's routes ``/api/server/ai`` and ``/api/me/ai``, a task of a button in a note
through nexlore's own route ``POST /api/ai/run`` (``services/ai.run`` asks through ``nexki.ask``). The database is the
test session's (``tests/conftest.py`` empties it before every test). nexlore had both ways before (``ai_mode``:
``own`` and ``shared``), so both are older forms.
"""

from __future__ import annotations

from typing import Any

import pytest
from ki_contract import StandardAdapter

TAB = {"X-Nexlore-Client": "tab-contract"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexki"
    server_prefix = "/api/server/ai"
    me_prefix = "/api/me/ai"
    older_forms: tuple[str, ...] = ("own", "shared")

    def start(self) -> None:
        from app.models import MEMBER, OPERATOR
        from app.services import ai, ki_store
        from app.vendor.nexki.brake import BRAKE
        from tests.conftest import make_account

        ai.pace.forget()
        BRAKE.forget()
        self.accounts = {name: make_account(name, OPERATOR if name == "operator" else MEMBER)
                         for name in ("owner", "other", "operator")}
        ki_store.adopt()
        self.clients: dict[str, Any] = {}

    def start_older(self, form: str, base: str, key: str) -> None:
        """As 1.16.0 wrote it: the main switch open, the way, the service (the operator's, or the owner's own), the
        key sealed with its old context, "KI für mich" on; then the start of the new version (``adopt``)."""
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account
        from app.security import encrypt_secret
        from app.services import ai, ki_store, settings_service
        from app.vendor.nexki.brake import BRAKE
        from tests.conftest import make_account

        ai.pace.forget()
        BRAKE.forget()
        self.accounts = {name: make_account(name, OPERATOR if name == "operator" else MEMBER)
                         for name in ("owner", "other", "operator")}
        with SessionLocal() as db:
            settings_service.save(db, {"ai_allowed": True, "ai_mode": form})
            if form == "shared":
                settings_service.save(db, {"ai_shared_url": base, "ai_shared_model": "plain",
                                           "ai_shared_key_enc": encrypt_secret(key, "operator:ai-key")})
            for name in ("owner", "other", "operator"):
                row = db.get(Account, self.accounts[name].id)
                assert row is not None
                row.ai_active = True
                if form == "own" and name == "owner":
                    row.ai_url, row.ai_model = base, "plain"
                    row.ai_key_enc = encrypt_secret(key, f"account:{row.id}:ai-key")
            db.commit()
        ki_store.adopt()
        self.clients = {}

    def stop(self) -> None:
        for client in self.clients.values():
            client.close()

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

    def config(self) -> Any:
        from app.services.ki_store import CONFIG

        return CONFIG

    def store(self) -> Any:
        from app.db import SessionLocal
        from app.services.ki_store import KiStore

        return KiStore(SessionLocal())

    def account_id(self, role: str) -> Any:
        return self.accounts[role].id

    def manual(self, role: str, text: str) -> Any:
        return self.client(role).post("/api/ai/run", json={"task": "spelling", "text": text})

    def automatic(self, role: str, text: str) -> Any:
        # nexlore asks no chat model by itself (its search by meaning asks for vectors, which the module does not
        # carry yet): there is no automatic task to run. Question in einst-fragen/nexlore-module.md.
        pytest.skip("nexlore has no automatic chat task")

    def app_refused(self, role: str, text: str) -> Any:
        # nexlore has no check of its own before a task (no "private" place the AI may not read).
        pytest.skip("nexlore keeps nothing from the AI by a check of its own")

    def _account(self, role: str, **values: Any) -> None:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.get(Account, self.accounts[role].id)
            assert row is not None
            for name, value in values.items():
                setattr(row, name, value)
            db.commit()

    def take_ai(self, role: str) -> None:
        self._account(role, ai_allowed=False)

    def give_ai(self, role: str) -> None:
        self._account(role, ai_allowed=True)

    def shut_out(self, role: str) -> None:
        from app.models import utcnow

        self._account(role, blocked_at=utcnow())

    def let_in(self, role: str) -> None:
        self._account(role, blocked_at=None)

    def dump(self) -> str:
        from app.db import engine

        connection = engine.raw_connection()
        try:
            return "\n".join(connection.iterdump())  # type: ignore[attr-defined]
        finally:
            connection.close()
