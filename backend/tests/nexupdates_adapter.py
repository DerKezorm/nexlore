"""nexupdates contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexupdates/`` run the module inside nexlore: its configuration from
``services/updates.py`` (the settings' ``update_check``, ``notify_version``, the bell ``notify.operators``), the routes
under ``/api/about`` (``routers/about.py``), the setup ``POST /api/setup``. The database is the test session's
(``tests/conftest.py`` empties it before every test). The bell: both operators have a webhook and mail; the webhook
counts the versions told, the mail (in the account's language, U17) gives the notices.
"""

from __future__ import annotations

import re
from typing import Any

from updates_contract import StandardAdapter

TAB = {"X-Nexlore-Client": "tab-contract"}
HOOK = "https://hooks.example.com/nexlore/updates"


class Adapter(StandardAdapter):
    package = "app.vendor.nexupdates"
    prefix = "/api/about"
    also: tuple[str, ...] = ()

    def start(self) -> None:
        import pytest

        from app.services import notify, updates
        from app.vendor import nexpost

        updates.configure()
        updates.forget()
        self.posts: list[dict[str, Any]] = []
        self.letters: list[Any] = []
        self._patch = pytest.MonkeyPatch()
        self._patch.setattr(notify, "_post", lambda _url, body: self.posts.append(body) or 200)
        real_queue = nexpost.outbox.queue

        def queued(store: Any, letter: Any) -> Any:
            self.letters.append(letter)
            return real_queue(store, letter)

        self._patch.setattr(nexpost.outbox, "queue", queued)
        self.clients: dict[str, Any] = {}
        self.accounts: dict[str, Any] = {}
        self.languages: dict[str, str] = {}

    def _accounts(self) -> None:
        """An operator (German) and a member, with a second operator (English), made at first use: the setup test
        needs an empty installation."""
        if self.accounts:
            return
        from app.db import SessionLocal
        from app.models import MEMBER, OPERATOR, Account
        from app.services import settings_service
        from tests.conftest import make_account

        self.accounts = {"operator": make_account("anna", OPERATOR), "member": make_account("bob", MEMBER),
                         "second": make_account("carl", OPERATOR)}
        with SessionLocal() as db:
            settings_service.save(db, {"smtp_host": "smtp.example.com", "smtp_from": "lore@example.com"})
            for role, language in (("operator", "de"), ("second", "en")):
                row = db.get(Account, self.accounts[role].id)
                assert row is not None
                row.language = language
                row.email = f"{row.name}@example.com"
            db.commit()
        self.languages = {"anna@example.com": "de", "carl@example.com": "en"}
        # The first operator with a webhook and mail, the second with mail only: the webhook is one operator's bell.
        for role, hook in (("operator", {"webhook": HOOK}), ("second", {})):
            answer = self.client(role).put("/api/me/notify", json={**hook, "choices": {"email": True}})
            assert answer.status_code == 200, answer.text

    def stop(self) -> None:
        for client in self.clients.values():
            client.close()
        self._patch.undo()
        from app.services import updates

        updates.configure()

    def restart(self) -> None:
        from app.services import updates

        updates.configure()
        updates.forget()

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import sign_in

        if role != "anonymous":
            self._accounts()
        if role not in self.clients:
            browser = TestClient(app, base_url="http://testserver", headers=TAB)
            if role != "anonymous":
                sign_in(browser, self.accounts[role])
            self.clients[role] = browser
        return self.clients[role]

    def stored_switch(self) -> Any:
        from app.db import SessionLocal
        from app.models import Setting

        with SessionLocal() as db:
            row = db.get(Setting, "update_check")
            return None if row is None else row.value

    def store_legacy_switch(self, on: bool) -> None:
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            settings_service.save(db, {"update_check": on})

    def setup(self, on: bool) -> None:
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import SETUP_CODE

        # Without ``with``: the app's start would set the module up again over the stand-in.
        browser = TestClient(app, base_url="http://testserver", headers=TAB)
        answer = browser.post("/api/setup", json={
            "display_name": "Anna", "name": "anna", "password": "a long password of the test",
            "password_confirm": "a long password of the test", "code": SETUP_CODE, "update_check": on,
        })
        browser.close()
        assert answer.status_code == 200, answer.text
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.query(Account).filter(Account.name == "anna").one()
            db.expunge(row)
        self.accounts = {"operator": row}
        answer = self.client("operator").put("/api/me/notify", json={"webhook": HOOK})
        assert answer.status_code == 200, answer.text

    def bell(self) -> list[str]:
        """The versions the first operator's webhook was told about (the webhook speaks English)."""
        found = [re.fullmatch(r"nexlore (\S+) is out", str(body.get("title"))) for body in self.posts]
        return ["v" + match.group(1) for match in found if match]

    def bell_notices(self) -> list[tuple[str, str, str]]:
        """Every mail of the bell as (language of the operator's account, version, title)."""
        notices = []
        for letter in self.letters:
            if not str(getattr(letter, "kind", "")).endswith("new_version"):
                continue
            subject = str(letter.subject)
            version = re.search(r"nexlore (\d+\.\d+\.\d+)", subject)
            notices.append((self.languages.get(letter.to, ""), "v" + version.group(1) if version else "", subject))
        return notices
