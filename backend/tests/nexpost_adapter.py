"""nexpost contract tests: nexlore' adapter (copied once from the module's template, now nexlore' file).

The contract tests in ``backend/tests/nexpost/`` run the module against nexlore' real store
(``app.services.post_store``) over the operator's settings and the table ``mail_outbox``. The database is the one of
the test session (``tests/conftest.py`` empties it before every test).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from post_contract import Legacy, StandardAdapter, password


class Adapter(StandardAdapter):
    package = "app.vendor.nexpost"

    def start(self) -> None:
        from app.services import post_store

        post_store.configure()

    def stop(self) -> None:
        from app.vendor import nexpost

        nexpost.use_smtp(None)

    @contextmanager
    def store(self) -> Iterator[Any]:
        from app.db import SessionLocal
        from app.services.post_store import PostStore

        with SessionLocal() as db:
            yield PostStore(db)

    def raw_text(self) -> str:
        from sqlalchemy import text

        from app.db import engine

        parts: list[str] = []
        with engine.connect() as connection:
            for table in ("settings", "mail_outbox"):
                parts += [repr(tuple(row)) for row in connection.execute(text(f"SELECT * FROM {table}"))]  # noqa: S608
        return "\n".join(parts)

    def legacy(self) -> Legacy:
        """The mail server as the settings page of 1.16.0 saved it (``PUT /api/settings``: the keys ``smtp_*``, the
        password sealed with the server's key); 1.16.0 had no outbox."""
        from app.db import SessionLocal
        from app.security import encrypt_secret
        from app.services import settings_service
        from app.vendor.nexpost.model import MailSettings

        secret = password()
        with SessionLocal() as db:
            settings_service.save(db, {
                "smtp_host": "smtp.example.com",
                "smtp_port": 465,
                "smtp_security": "tls",
                "smtp_user": "lore@example.com",
                "smtp_password_enc": encrypt_secret(secret),
                "smtp_from": "lore@example.com",
            })
        return Legacy(
            settings=MailSettings(
                host="smtp.example.com",
                port=465,
                security="tls",
                user="lore@example.com",
                password=secret,
                sender="lore@example.com",
                sender_name="",
            ),
            queued=0,
        )

    def new_sign_in_letter(self, where: str, sender: str) -> Any:
        """A member with a confirmed address signs in through ``POST /api/auth/login`` from a browser it never used
        (User-Agent ``where``, address ``sender``); the letter caught on its way into the outbox."""
        from fastapi.testclient import TestClient

        from app.db import SessionLocal
        from app.main import app
        from app.models import MEMBER, Account
        from app.security import brake, hash_password
        from app.services import settings_service
        from app.vendor.nexpost import testing

        secret = password()
        with SessionLocal() as db:
            settings_service.save(db, {"smtp_host": "smtp.example.com", "smtp_from": "lore@example.com",
                                       "public_url": "https://lore.example.com"})
            db.add(Account(name="kim", display_name="Kim", email="kim@example.com", email_confirmed=True,
                           role=MEMBER, password_hash=hash_password(secret)))
            db.commit()
        brake.forget()
        browser = TestClient(app, base_url="https://lore.example.com", client=(sender, 50000),
                             headers={"X-Nexlore-Client": "tab-contract", "User-Agent": where})
        with testing.catch_mail() as caught:
            answer = browser.post("/api/auth/login", json={"name": "kim", "password": secret})
        assert answer.status_code == 200, answer.text
        found = [letter for letter in caught.letters if letter.kind == "new_sign_in"]
        assert found, "no mail about a new sign-in"
        return found[0]
