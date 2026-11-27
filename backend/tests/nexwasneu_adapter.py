"""nexwasneu contract tests: the app's adapter. Copied once by the module's ``tools/sync.py copy <app>`` to
``backend/tests/nexwasneu_adapter.py``; from then on it is the app's file.

nexlore's adapter: its real app (``app.main``), the module configured by ``app/services/whatsnew.py``, the field
``Account.whats_new_seen`` and the way of before ``POST /api/me/whats-new/seen``. The database is the one of the test
session (``tests/conftest.py`` empties it before every test). The contract tests in ``backend/tests/nexwasneu/`` (same in every app, never
edit them) call only what is here and in ``StandardAdapter``. Worked examples: the module's
``tests-fuer-apps/reference/nexwasneu_adapter.py`` (an app like nexnotes) and ``tests/mail_like_adapter.py`` (like
nexmail and nexpaper: ``wasneu_gesehen``, routes under ``/api/v1/whats-new``, French built in). Run them with
``pytest tests/nexwasneu``. The route tests put their own texts in place of the app's for a moment; the guard reads the
app's own.
"""

from __future__ import annotations

import itertools
from typing import Any

from fastapi.testclient import TestClient
from wasneu_contract import StandardAdapter

from tests.conftest import make_account, sign_in

ROLES = {"operator": "olga", "member": "mia"}
_names = itertools.count()


class Adapter(StandardAdapter):
    package = "app.vendor.nexwasneu"
    root_package = "app"
    prefix = "/api/whats-new"
    old_seen: tuple[str, ...] = ("/api/me/whats-new/seen",)
    me = "/api/auth/me"
    me_field = "whats_new_seen"

    def start(self) -> None:
        from app.services import whatsnew

        whatsnew.configure()
        self.ids = {role: make_account(name, "operator" if role == "operator" else "member").id
                    for role, name in ROLES.items()}

    def stop(self) -> None:
        from app.services import whatsnew

        whatsnew.configure()

    def client(self, role: str) -> Any:
        from app.db import SessionLocal
        from app.main import app
        from app.models import Account

        client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{role:0<8}"})
        if role in self.ids:
            with SessionLocal() as db:
                row = db.get(Account, self.ids[role])
                assert row is not None
                db.expunge(row)
            sign_in(client, row)
        return client

    def stored_seen(self, role: str) -> str:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            return row.whats_new_seen or ""

    def set_seen(self, role: str, version: str) -> None:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.get(Account, self.ids[role])
            assert row is not None
            row.whats_new_seen = version
            db.commit()

    def new_account_seen(self) -> str:
        """As the setup and the operator's list make an account (``accounts.create_with_password``)."""
        from app.db import SessionLocal
        from app.services import accounts

        with SessionLocal() as db:
            row = accounts.create_with_password(db, f"new{next(_names)}", "correct horse battery")
            return row.whats_new_seen or ""
