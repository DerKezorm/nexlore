"""nexoidc contract tests: nexlore's adapter (copied once from ``bauplaene/oidc/tests-fuer-apps/adapter_template.py``,
from then on nexlore's own file).

The contract tests in ``tests/nexoidc/`` are the same in every nex app and never edited here. They reach nexlore
only through this class: its real routes, its database, its accounts, invitations and second factor. The test run's
own data directory and the cleaning between tests come from ``tests/conftest.py``. Passwords and seeds are made at
run time; none is written into this file.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Any

import httpx
from fastapi.testclient import TestClient
from oidc_contract import StandardAdapter
from sqlalchemy import select

from app.db import SessionLocal
from app.deps import normal_address
from app.main import app
from app.models import OPERATOR, SIGN_IN_PASSWORD, WRITE, Account, Membership, Space
from app.routers.auth import PENDING_COOKIE
from app.security import Brake, brake, encrypt_secret, hash_password
from app.services import accounts, oidc_store, settings_service, totp, vault

OPERATOR_NAME = "operator"
#: The space an invitation with the rights "editor" brings write access to.
SPACE = "Shared"


class Adapter(StandardAdapter):
    package = "app.vendor.nexoidc"
    api = "/api"
    single_account = False
    only_authentik = False
    has_second_factor = True
    legacy_model = "single"
    old_callback_paths: tuple[str, ...] = ()
    operator_name = OPERATOR_NAME

    def start(self) -> None:
        # tests/conftest.py emptied the database and the vault before this test.
        oidc_store.configure()
        self._operator: TestClient | None = None
        self._seeds: dict[str, str] = {}
        self.make_account(OPERATOR_NAME, role=OPERATOR)

    def stop(self) -> None:
        pass

    def browser(self) -> TestClient:
        # As the interface does: every request names its tab (changes are refused without it).
        return TestClient(app, base_url="http://testserver", follow_redirects=False,
                          headers={"X-Nexlore-Client": "tab-" + secrets.token_hex(6)})

    def operator(self) -> TestClient:
        if self._operator is None:
            self._operator = self.browser()
            self.sign_in_with_password(self._operator, OPERATOR_NAME)
        return self._operator

    def make_account(self, name: str, *, password: bool = True, second_factor: bool = False,
                     role: str = "member") -> int:
        with SessionLocal() as db:
            row = Account(name=name, role=role, sign_in=SIGN_IN_PASSWORD if password else "oidc",
                          password_hash=hash_password(self.password_for(name)) if password else "")
            if second_factor:
                seed = totp.generate_seed()
                self._seeds[name] = seed
                row.totp_secret_enc = totp.seal_seed(seed)
            db.add(row)
            db.commit()
            return row.id

    def sign_in_with_password(self, client: Any, name: str) -> None:
        answer = client.post("/api/auth/login", json={"name": name, "password": self.password_for(name)})
        assert answer.status_code == 200, answer.text
        if answer.json().get("second_factor"):
            # A code of the step after the last one taken, so that no two sign-ins in one step collide.
            code = totp.code_at(self._seeds[name], time.time() + 30 * self._codes_used(name))
            done = client.post("/api/auth/login/totp", json={"code": code})
            assert done.status_code == 200, done.text

    def _codes_used(self, name: str) -> int:
        with SessionLocal() as db:
            row = accounts.by_name(db, name)
            assert row is not None
            return 1 if row.totp_last_step else 0

    def who(self, client: Any) -> str | None:
        answer = client.get("/api/auth/me")
        return answer.json()["name"] if answer.status_code == 200 else None

    def second_factor_asked(self, client: Any, response: httpx.Response) -> bool:
        waiting = client.cookies.get(PENDING_COOKIE)
        return (
            response.headers.get("location", "") == "/login?step=code"
            and waiting is not None
            and totp.get_pending(waiting) is not None
        )

    def _space(self) -> int:
        with SessionLocal() as db:
            space = db.scalar(select(Space).where(Space.folder == SPACE))
            if space is not None:
                return space.id
        vault.create_space(SPACE)
        with SessionLocal() as db:
            space = db.scalar(select(Space).where(Space.folder == SPACE))
            assert space is not None
            operator = accounts.by_name(db, OPERATOR_NAME)
            assert operator is not None
            db.add(Membership(space_id=space.id, account_id=operator.id, role="manage"))
            db.commit()
            return space.id

    def make_invite(self, rights: str) -> str:
        space_id = self._space() if rights == "editor" else None
        with SessionLocal() as db:
            operator = accounts.by_name(db, OPERATOR_NAME)
            assert operator is not None
            _invite, token = accounts.create_invite(
                db, operator, space_id=space_id, space_role=WRITE if space_id else "", days=7
            )
        return token

    def rights_of(self, name: str) -> str | None:
        with SessionLocal() as db:
            row = accounts.by_name(db, name)
            if row is None:
                return None
            right = db.scalar(
                select(Membership.role).join(Space, Space.id == Membership.space_id)
                .where(Membership.account_id == row.id, Space.folder == SPACE)
            )
            return "editor" if right == WRITE else "member"

    def account_names(self) -> list[str]:
        with SessionLocal() as db:
            return sorted(db.scalars(select(Account.name)))

    def store(self) -> AbstractContextManager[Any]:
        @contextmanager
        def opened() -> Iterator[oidc_store.SqlStore]:
            with SessionLocal() as db:
                yield oidc_store.SqlStore(db)

        return opened()

    def set_public_url(self, url: str) -> None:
        with SessionLocal() as db:
            settings_service.save(db, {"public_url": url})

    def legacy_setup(
        self, *, issuer: str, client_id: str, client_secret: str, label: str, subjects: dict[str, str]
    ) -> None:
        # As nexlore 1.5.2 kept its one provider: in the settings, the secret sealed without a context.
        with SessionLocal() as db:
            settings_service.save(db, {
                "oidc_issuer": issuer,
                "oidc_client_id": client_id,
                "oidc_client_secret_enc": encrypt_secret(client_secret),
                "oidc_provider_name": label,
                oidc_store.MIGRATED: False,
            })
            for name, subject in subjects.items():
                row = accounts.by_name(db, name)
                assert row is not None
                row.oidc_subject = subject
            db.commit()

    def run_migration(self) -> None:
        oidc_store.migrate_settings(backup=False)

    def trip_throttle(self, client: Any) -> None:
        # As many failed runs at the provider from this sender as the brake lets pass (every TestClient is the
        # sender "testclient"): the next start, return and linking wait.
        key = "oidc:" + normal_address("testclient")
        for _ in range(Brake.FREE + 1):
            brake.failed(key)

    def operator_unlink(self, client: Any, account_id: int, provider_id: int, password: str) -> httpx.Response:
        # nexlore's acts on another account carry the operator's password as ``current_password``.
        path = self.path("operator_unlink", account=account_id, provider=provider_id)
        return client.request("DELETE", path, json={"current_password": password})
