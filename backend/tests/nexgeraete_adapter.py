"""nexgeraete contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexgeraete/`` run the module inside nexlore: its real app (``app.main``), its
browser sessions, its ``GeraeteStore`` over ``app_devices``, ``app_pairings`` and ``app_codes``
(``app/services/geraete_config.py``), its own device route ``GET /api/app/1/me``. The module's app routes are mounted
under ``/api/app/1`` (the four of 1.16.0 under their old names in ``routers/app1.py``), its browser routes under
``/api/devices`` (``routers/app_pairing.py``). Relay and clock go through ``geraete_config.Hooks``.

The database is the one of the test session (``tests/conftest.py`` empties it before every test).

Devices of before: nexlore 1.16.0 wrote one form of row for every way in (QR code, short code, the iPad brought in
over iCloud): ``app_devices`` with ``account_id``, ``name``, ``key_hash`` (SHA-256 of the whole ``nxd_`` key),
``created_at`` and ``last_seen_at``; no kind, no way, no push (nexlore had none).
"""

from __future__ import annotations

import secrets
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from geraete_contract import LegacyDevice, Made, Relay, StandardAdapter

from tests.conftest import PASSWORD, make_account, sign_in

ROLES = {"owner": "member", "other": "member", "operator": "operator"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexgeraete"
    app_prefix = "/api/app/1"
    browser_prefix = "/api/devices"

    def start(self) -> None:
        from app.services import devices
        from app.services.geraete_config import Hooks

        self.relay = Relay()
        Hooks.send = self.relay
        Hooks.offset = timedelta(0)
        self.paired: list[tuple[Any, str]] = []
        Hooks.listeners.append(self._heard)
        self.clients: dict[str, TestClient] = {}
        self.ids = {role: make_account(role, kind).id for role, kind in ROLES.items()}
        # The name the contract's published app shows.
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            owner = db.get(Account, self.ids["owner"])
            assert owner is not None
            owner.display_name = "Kim Example"
            db.commit()
        devices.forget()

    def _heard(self, holder: Any, device: Any) -> None:
        self.paired.append((holder.id, device.name))

    def stop(self) -> None:
        from app.services.geraete_config import Hooks

        for client in self.clients.values():
            client.close()
        Hooks.send = None
        Hooks.offset = timedelta(0)
        if self._heard in Hooks.listeners:
            Hooks.listeners.remove(self._heard)

    def restart(self) -> None:
        """Nothing about devices is kept in memory but the rate; it starts anew."""
        from app.security import brake
        from app.services import devices

        devices.forget()
        brake.forget()

    def config(self) -> Any:
        from app.services.geraete_config import CONFIG

        return CONFIG

    def client(self, role: str) -> TestClient:
        from app.main import app

        if role not in self.clients:
            if role == "anonymous":
                self.clients[role] = TestClient(app, base_url="http://testserver")
            else:
                client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{role:0<8}"})
                from app.db import SessionLocal
                from app.models import Account

                with SessionLocal() as db:
                    row = db.get(Account, self.ids[role])
                    assert row is not None
                    db.expunge(row)
                sign_in(client, row)
                self.clients[role] = client
        return self.clients[role]

    def account_id(self, role: str) -> Any:
        return self.ids[role]

    def legacy_devices(self) -> list[LegacyDevice]:
        return [LegacyDevice("QR code"), LegacyDevice("short code"), LegacyDevice("brought in over iCloud")]

    def make_legacy(self, spec: LegacyDevice, *, account: str = "owner") -> Made:
        """As 1.16.0's ``devices.make_device`` wrote every device: the row without the module's columns."""
        from sqlalchemy import insert

        from app.db import SessionLocal
        from app.models import AppDevice, utcnow
        from app.services import devices
        from app.services.geraete_config import Hooks

        token = devices.KEY_PREFIX + secrets.token_urlsafe(32)
        with SessionLocal() as db:
            db.execute(insert(AppDevice).values(
                account_id=self.ids[account], name=spec.label, key_hash=devices.digest(token),
                created_at=utcnow() + Hooks.offset - timedelta(days=3), last_seen_at=None,
            ))
            db.commit()
        return Made(token)

    def probe(self, token: str | None, headers: dict[str, str] | None = None) -> Any:
        sent = dict(headers or {})
        if token is not None:
            sent["Authorization"] = f"Bearer {token}"
        return self.device_client().get(f"{self.app_prefix}/me", headers=sent)

    def database_text(self) -> bytes:
        from app.db import engine

        path = Path(str(engine.url.database))
        found = b""
        for part in (path, path.with_name(path.name + "-wal")):
            if part.is_file():
                found += part.read_bytes()
        return found

    def _manage(self, action: str, account: str) -> None:
        from app.db import SessionLocal
        from app.models import Account
        from app.services.konten_store import KontenStore
        from app.vendor.nexkonten import manage

        with SessionLocal() as db:
            getattr(manage, action)(KontenStore(db), self.ids[account], actor_id=self._actor(account),
                                    password=PASSWORD)
        # nexlore ends the browser sessions of a blocked or deleted account; back, the person signs in again.
        if action in ("unblock", "restore") and account in self.clients:
            with SessionLocal() as db:
                row = db.get(Account, self.ids[account])
                assert row is not None
                db.expunge(row)
            sign_in(self.clients[account], row)

    def _actor(self, account: str) -> Any:
        """The operator acts; on the operator's own account a second operator does (nobody blocks themselves)."""
        if account != "operator":
            return self.ids["operator"]
        if "second operator" not in self.ids:
            self.ids["second operator"] = make_account("second", "operator").id
        return self.ids["second operator"]

    def block(self, account: str = "owner") -> None:
        self._manage("block", account)

    def unblock(self, account: str = "owner") -> None:
        self._manage("unblock", account)

    def remove(self, account: str = "owner") -> None:
        self._manage("remove", account)

    def restore(self, account: str = "owner") -> None:
        self._manage("restore", account)

    def purge(self, account: str = "owner") -> None:
        """Deleted, and the 30 days have passed (``manage.purge_due``)."""
        from app.db import SessionLocal
        from app.models import Account, utcnow
        from app.services.konten_store import KontenStore
        from app.vendor.nexkonten import manage

        self.remove(account)
        with SessionLocal() as db:
            row = db.get(Account, self.ids[account])
            assert row is not None
            row.deleted_at = utcnow() - timedelta(days=31)
            db.commit()
            manage.purge_due(KontenStore(db))

    def owe_factor(self, account: str = "owner") -> None:
        """nexlore asks a second factor of everybody by the operator's switch; the others have an authenticator,
        ``account`` has none."""
        from app.db import SessionLocal
        from app.models import Account
        from app.services import konten_store, settings_service, totp

        with SessionLocal() as db:
            for role, number in self.ids.items():
                row = db.get(Account, number)
                assert row is not None
                row.totp_secret_enc = "" if role == account else totp.seal_seed("JBSWY3DPEHPK3PXP")
            db.commit()
            settings_service.save(db, {konten_store.SWITCH_FACTOR_REQUIRED: True})

    def switch(self, name: str, on: bool) -> None:
        """``app`` and ``pairing`` are both ``app_pairing_allowed`` in nexlore."""
        from app.db import SessionLocal
        from app.services import devices, settings_service

        with SessionLocal() as db:
            settings_service.save(db, {devices.SWITCH: on})

    def travel(self, delta: timedelta) -> None:
        from app.services.geraete_config import Hooks

        Hooks.offset += delta

    def tell(self, account: str, kind: str) -> None:
        """nexlore sends no kind of its own yet; what there is goes the module's way."""
        from app.db import SessionLocal
        from app.services.geraete_config import CONFIG, GeraeteStore, send
        from app.vendor.nexgeraete import push

        with SessionLocal() as db:
            push.tell(GeraeteStore(db), CONFIG, self.ids[account], kind,
                      {"type": kind, "title": "Kim Example", "text": "changed something"}, send=send)

    def announce(self, version: str) -> None:
        """The way of ``updates.on_devices`` (G56), with the version nexlore runs."""
        from app.services import updates

        updates._on_devices(version)

    def update_wanted(self) -> bool:
        """What ``updates.devices_want`` asks (``notices.update_wanted`` over nexlore's store)."""
        from app.services import updates

        return updates._devices_want()

    def running(self) -> str:
        from app.services import updates

        return updates.APP_VERSION

    def sweep(self) -> int:
        from app.services import geraete_config

        return geraete_config.sweep()

    def paired_mails(self) -> list[tuple[Any, str]]:
        return list(self.paired)
