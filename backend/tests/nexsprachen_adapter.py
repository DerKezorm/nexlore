"""nexsprachen contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexsprachen/`` run the module inside nexlore: its configuration
(``services/locales.py``: the folder ``<data_dir>/locales`` or ``NEXLORE_LOCALES_DIR`` of before, German and English
built in), its routes under ``/api/locales`` (readable without signing in, as before; adding and removing for the
operator, ``deps.require_operator``) and nexlore's form of a refusal (``{"detail": {"code", "message", …}}``). The
page makes the template from its English texts, so the server hands none out. Each start gets a folder of its own.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any, ClassVar

from sprachen_contract import StandardAdapter

TAB = {"X-Nexlore-Client": "tab-tests000"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexsprachen"
    prefix = "/api/locales"
    also: tuple[str, ...] = ()
    built_in: ClassVar[dict[str, str]] = {"de": "Deutsch", "en": "English"}
    public_read = True
    has_template = False

    def start(self) -> None:
        from app.config import get_settings
        from app.services import locales

        self._clients: list[Any] = []
        self._settings = get_settings()
        self._before = self._settings.locales_dir
        self._folder = Path(tempfile.mkdtemp(prefix="nexlore-locales-"))
        self._settings.locales_dir = self._folder
        locales.configure()

    def stop(self) -> None:
        from app.services import locales

        for client in self._clients:
            client.close()
        self._settings.locales_dir = self._before
        locales.configure()
        shutil.rmtree(self._folder, ignore_errors=True)

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import MEMBER, OPERATOR, Account
        from tests.conftest import make_account, sign_in

        client = TestClient(app, base_url="http://testserver", headers=TAB)
        if role != "anonymous":
            name = "tester" if role == "operator" else "member"
            with SessionLocal() as db:
                row = db.query(Account).filter_by(name=name).one_or_none()
                if row is not None:
                    db.expunge(row)
            account = row or make_account(name, OPERATOR if role == "operator" else MEMBER)
            sign_in(client, account)
        self._clients.append(client)
        return client
