"""nexverbinden contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The partner the tests play is nexnotes, the one app of the catalog that uses nexlore: it puts notes into nexlore's
spaces (``notes.add``); nexlore uses nothing of nexnotes. nexlore had no connection with another nex app before, only
API tokens (``nxa_``) at ``/api/v1``. The database is the one of the test session (``tests/conftest.py`` empties it
before every test); ``folder`` is not needed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from verbinden_contract import StandardAdapter

TAB = {"X-Nexlore-Client": "tab-connect00"}
ROLES = ("owner", "other", "operator")
#: The user names the contract tests know the accounts by (as its partner names them, ``Store.account_name``).
USER = {"owner": "kim", "other": "sam", "operator": "op"}
#: Their shown names (``display_name``), which the consent page shows with the user name (verbinden 0.1.8, V43).
SHOWN = {"owner": "Kim Example", "other": "Sam Example", "operator": "Op Example"}
#: The spaces of each account (the owner has two to give).
SPACES = {"owner": ("Kim notes", "Kim work"), "other": ("Sam notes",), "operator": ("Op notes",)}


class Adapter(StandardAdapter):
    package = "app.vendor.nexverbinden"
    partner = "nexnotes"
    base = "https://lore.example.com"
    older_link = False
    shown_names = {"owner": SHOWN["owner"], "other": SHOWN["other"]}  # noqa: RUF012 (read only)

    def start(self, folder: Path, *, older: bool = False) -> None:
        """Three accounts with their spaces; with ``older`` an API token of ``owner``, as nexlore wrote it."""
        from app.db import SessionLocal
        from app.models import MANAGE, MEMBER, OPERATOR, Account, Membership, Space
        from app.security import brake
        from app.services import apitokens, index, settings_service
        from app.services.verbinden_store import VerbindenStore
        from tests.conftest import VAULT, make_account

        brake.forget()
        apitokens.forget()
        self.ids: dict[str, int] = {}
        self.spaces: dict[str, int] = {}
        self.clients: dict[str, TestClient] = {}
        for role in ROLES:
            made = make_account(USER[role], OPERATOR if role == "operator" else MEMBER)
            self.ids[role] = made.id
        with SessionLocal() as db:
            for role in ROLES:
                row = db.get(Account, self.ids[role])
                assert row is not None
                row.display_name = SHOWN[role]
                for name in SPACES[role]:
                    (VAULT / name).mkdir(parents=True, exist_ok=True)
                    (VAULT / name / "Start.md").write_text(f"# {name}\n", encoding="utf-8")
                    space = Space(folder=name)
                    db.add(space)
                    db.flush()
                    db.add(Membership(space_id=space.id, account_id=row.id, role=MANAGE))
                    self.spaces[name] = space.id
            db.commit()
            if older:
                settings_service.save(db, {"api_tokens_allowed": True})
                owner = db.get(Account, self.ids["owner"])
                assert owner is not None
                _row, self.older_key = apitokens.make(db, owner, "Home Assistant", "read")
                self.older_key_path = "/api/v1/me"
        index.scan()
        self._session = SessionLocal()
        self.store = VerbindenStore(self._session)
        from app.routers import verbinden as verbinden_routes

        self.ended: list[tuple[Any, str]] = []
        self._listener = lambda account_id, partner: self.ended.append((account_id, partner))
        verbinden_routes.LISTENERS.append(self._listener)

    def stop(self) -> None:
        from app.routers import verbinden as verbinden_routes

        for client in self.clients.values():
            client.close()
        self.clients = {}
        self._session.close()
        if self._listener in verbinden_routes.LISTENERS:
            verbinden_routes.LISTENERS.remove(self._listener)

    def disconnected(self) -> list[tuple[Any, str]]:
        """Every call of nexlore's ``on_disconnected`` (``routers/verbinden._disconnected``), in order."""
        return list(self.ended)

    def asgi(self) -> Any:
        from app.main import app

        return app

    def client(self, role: str | None) -> TestClient:
        from app.main import app
        from app.models import Account
        from tests.conftest import sign_in

        key = role or "anonymous"
        if key not in self.clients:
            browser = TestClient(app, base_url=self.base, headers=TAB if role else {})
            if role:
                sign_in(browser, Account(id=self.ids[role]))
            self.clients[key] = browser
        return self.clients[key]

    def config(self) -> Any:
        from app.services.verbinden_store import CONFIG

        return CONFIG

    def account_id(self, role: str) -> Any:
        return self.ids[role]

    def block(self, role: str, blocked: bool = True) -> None:
        from app.db import SessionLocal
        from app.models import Account, utcnow

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            row.blocked_at = utcnow() if blocked else None
            db.commit()
        self._session.expire_all()

    def lock(self, role: str, locked: bool = True) -> None:
        """verbinden 0.2.1 (E41): locked after failed sign-ins as ``accounts.note_failure`` locks it."""
        from datetime import timedelta

        from app.db import SessionLocal
        from app.models import Account, utcnow

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            row.locked_until = utcnow() + timedelta(minutes=15) if locked else None
            db.commit()
        self._session.expire_all()

    def require_second_factor(self, role: str, required: bool = True) -> None:
        """verbinden 0.2.1 (E41): the operator asks a second factor of everybody; the others have an authenticator,
        ``role`` has none (as ``nexgeraete_adapter.owe_factor``)."""
        from app.db import SessionLocal
        from app.models import Account
        from app.services import konten_store, settings_service, totp

        with SessionLocal() as db:
            for name, number in self.ids.items():
                row = db.get(Account, number)
                assert row is not None
                row.totp_secret_enc = "" if name == role else totp.seal_seed("JBSWY3DPEHPK3PXP")
            db.commit()
            settings_service.save(db, {konten_store.SWITCH_FACTOR_REQUIRED: required})
        self._session.expire_all()

    def probe(self, purpose: str) -> str | tuple[str, str, Any] | None:
        # "notes.add" makes a note in a space given (``POST /api/v1/notes``, as nexnotes sends it).
        return ("POST", "/api/v1/notes", {"folder": SPACES["owner"][0], "title": "From nexnotes", "content": "Hello"})

    def write_into(self, purpose: str, area: Any) -> tuple[str, str, Any]:
        # "notes.add" into the space ``area`` (its id from ``areas_choice``), as nexnotes sends it.
        folder = next(name for name, space_id in self.spaces.items() if str(space_id) == str(area))
        return ("POST", "/api/v1/notes", {"folder": folder, "title": "From nexnotes", "content": "Hello"})

    def areas_seen(self, purpose: str, answer: Any) -> set[str]:
        path = str((answer or {}).get("path") or "")
        space = path.split("/", 1)[0]
        return {str(self.spaces[space])} if space in self.spaces else set()

    def everything(self) -> str:
        import sqlite3

        from app.db import engine

        path = engine.url.database
        assert path
        with sqlite3.connect(path) as db:
            return "\n".join(db.iterdump())

    def own_tables(self) -> dict[str, Any]:
        """The API tokens of before, row by row (nexlore had no connection with another nex app)."""
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import ApiToken

        with SessionLocal() as db:
            keys = [(row.id, row.account_id, row.token_hash, row.level, row.spaces, row.blocked_at)
                    for row in db.scalars(select(ApiToken).order_by(ApiToken.id))]
        return {"api_tokens": keys}
