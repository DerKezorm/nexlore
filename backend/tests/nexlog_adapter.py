"""nexlog contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexlog/`` run the module inside nexlore: its start (``main.lifespan``:
``logs.setup``, the level stored under ``log_mode`` and ``log_mode_until``), its middleware (request numbers in
``x-request-id``, who acts), its check of operators and its routes under ``/api/logs``. The database and data folder are
the ones of the test session (``tests/conftest.py`` empties the database before every test).
"""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from log_contract import LegacyLine, Secret, StandardAdapter

OPERATOR_NAME = "tester"
TAB = {"X-Nexlore-Client": "tab-tests000"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexlog"
    prefix = "/api/logs"
    request_id_header = "x-request-id"
    #: A route behind the sign-in: ``/api/about`` answers everyone and so names nobody.
    probe_path = "/api/auth/me"

    def start(self) -> None:
        """nexlore started as in production: the lifespan of the app (setup, the stored level, the watchdog off in
        the tests)."""
        from fastapi.testclient import TestClient

        from app.main import app
        from app.services import logs

        self._clients: list[Any] = []
        # A fresh log folder, as on a new server: the session's own log holds the lines of every test before.
        self._folder = Path(tempfile.mkdtemp(prefix="nexlore-log-"))
        logs.configure(log_dir=self._folder)
        self._main = TestClient(app, base_url="http://testserver", headers=TAB)
        self._main.__enter__()

    def stop(self) -> None:
        from app.services import logs
        from app.vendor import nexlog

        for client in self._clients:
            client.close()
        self._main.__exit__(None, None, None)
        nexlog.shutdown()
        logs.configure()
        logs.setup()
        shutil.rmtree(self._folder, ignore_errors=True)

    def client(self, role: str) -> Any:
        from fastapi.testclient import TestClient

        from app.main import app
        from app.models import MEMBER, OPERATOR
        from tests.conftest import make_account, sign_in

        client = TestClient(app, base_url="http://testserver", headers=TAB)
        if role != "anonymous":
            name = OPERATOR_NAME if role == "operator" else "member"
            sign_in(client, self._account(name, OPERATOR if role == "operator" else MEMBER, make_account))
        self._clients.append(client)
        return client

    @staticmethod
    def _account(name: str, role: str, make: Any) -> Any:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.query(Account).filter_by(name=name).one_or_none()
            if row is not None:
                db.expunge(row)
                return row
        return make(name, role)

    def operator_name(self) -> str:
        return OPERATOR_NAME

    def stored(self) -> tuple[Any, Any]:
        from app.db import SessionLocal
        from app.services import settings_service

        with SessionLocal() as db:
            return settings_service.get(db, "log_mode"), settings_service.get(db, "log_mode_until")

    def store_legacy(self, deep: bool, minutes_from_now: int) -> None:
        """As nexlore 1.16.0 stored it (``main._write_log_mode``): the mode, its end as ISO text in UTC or None."""
        from app.db import SessionLocal
        from app.services import settings_service

        if deep:
            until = datetime.now(UTC) + timedelta(minutes=minutes_from_now)
            values = {"log_mode": "detailed", "log_mode_until": until.isoformat()}
        else:
            values = {"log_mode": "quiet", "log_mode_until": None}
        with SessionLocal() as db:
            settings_service.save(db, values)

    @contextmanager
    def environment(self, value: str) -> Iterator[None]:
        from app.config import get_settings

        settings = get_settings()
        before = settings.log_level
        settings.log_level = value
        try:
            yield
        finally:
            settings.log_level = before

    def legacy_lines(self) -> list[LegacyLine]:
        """Lines in the form nexlore 1.16.0 wrote them (``services/logs.py`` before the module), server clock."""
        local = datetime(2026, 11, 20, 9, 15, 2).astimezone().isoformat()
        return [
            LegacyLine(
                raw="2026-11-20 09:15:02 INFO     nexlore.vault [a1b2c3 u:kim] | Note saved path=Garden/Roses.md size=418",
                level="INFO",
                logger="nexlore.vault",
                message="Note saved path=Garden/Roses.md size=418",
                request_id="a1b2c3",
                user="kim",
                at=local,
            ),
            LegacyLine(
                raw="2026-11-20 09:15:03 WARNING  nexlore.auth [d4e5f6] | Sign-in refused name=kim reason=password",
                level="WARNING",
                logger="nexlore.auth",
                message="Sign-in refused name=kim reason=password",
                request_id="d4e5f6",
            ),
            LegacyLine(
                raw="2026-11-20 09:15:04 INFO     nexlore [-] | nexlore 1.16.0 started sqlite=3.46.1",
                level="INFO",
                logger="nexlore",
                message="nexlore 1.16.0 started sqlite=3.46.1",
            ),
        ]

    def secrets(self) -> list[Secret]:
        made = os.urandom(9).hex()
        return [
            *(Secret(f"Token used {prefix}{made}", hidden=made, kept=[f"{prefix}…"])
              for prefix in ("nxa_", "nxc_", "nxl_", "nxr_", "nxe_", "nxd_")),
            Secret(f"GET /api/invite/{made}x -> 200", hidden=made, kept=["/api/invite/…"]),
            Secret(f"GET /api/email/{made}x -> 200", hidden=made, kept=["/api/email/…"]),
            Secret(f"GET /api/reset/{made}x -> 200", hidden=made, kept=["/api/reset/…"]),
            Secret(f"GET /s/{made}x -> 200", hidden=made, kept=["/s/…"]),
            Secret(f"GET /api/public/{made}x -> 200", hidden=made, kept=["/api/public/…"]),
            Secret(f"GET /join?invite={made} -> 200", hidden=made, kept=["?invite=…"]),
        ]
