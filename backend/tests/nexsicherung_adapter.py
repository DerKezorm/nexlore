"""nexsicherung contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexsicherung/`` run the module against nexlore's real hooks
(``app/services/backup_hooks.py``), its routes (``/api/server/storage`` and the old ``/api/backups``) and its data: the
vault's files, the database, the trash. The database and data folder are the ones of the test session
(``tests/conftest.py`` empties the database and the vault before every test).
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sicherung_contract import StandardAdapter

TAB = {"X-Nexlore-Client": "tab-tests000"}


class Adapter(StandardAdapter):
    package = "app.vendor.nexsicherung"
    prefix = "/api/server/storage"
    legacy_prefix = "/api/backups"
    legacy_header = "x-nexlore-password"

    def start(self) -> None:
        from fastapi.testclient import TestClient

        from app.main import app
        from app.models import MEMBER, OPERATOR
        from app.services import backups
        from tests.conftest import make_account

        shutil.rmtree(backups.folder(), ignore_errors=True)
        self._password = secrets.token_urlsafe(12)
        self._operator = make_account("olli", OPERATOR, password=self._password)
        self._member = make_account("mika", MEMBER, password=secrets.token_urlsafe(12))
        self._clients: list[Any] = []
        self._main = TestClient(app, base_url="http://testserver", headers=TAB)
        self._main.__enter__()

    def stop(self) -> None:
        from app.services import backups

        for client in self._clients:
            client.close()
        self._main.__exit__(None, None, None)
        shutil.rmtree(backups.folder(), ignore_errors=True)

    @property
    def password(self) -> str:
        return self._password

    def _client(self, account: Any) -> Any:
        from fastapi.testclient import TestClient

        from app.main import app
        from tests.conftest import sign_in

        client = TestClient(app, base_url="http://testserver", headers=TAB)
        sign_in(client, account)
        self._clients.append(client)
        return client

    def operator(self) -> Any:
        return self._client(self._operator)

    def member(self) -> Any:
        return self._client(self._member)

    def restart(self) -> None:
        """The next start: the database closed, the staged restore swapped in, the database opened and checked."""
        from app.db import engine, init_db
        from app.services import backups

        engine.dispose()
        backups.configure()
        backups.tidy_at_start()
        backups.apply_pending()
        init_db()

    def add_content(self, label: str) -> None:
        """A note in a space of the vault and a picture beside it, as nexlore keeps them: files on the disk, indexed."""
        from app.services import index, paths

        folder = paths.vault_root() / "Garden"
        (folder / "Attachments").mkdir(parents=True, exist_ok=True)
        stem = secrets.token_hex(6)
        (folder / f"{stem}.md").write_text(f"# {label}\n\nWritten for the backup.\n", encoding="utf-8")
        (folder / "Attachments" / f"{stem}.bin").write_bytes(label.encode() * 50)
        index.scan()

    def content(self) -> Any:
        from app.services import backup_hooks, paths
        from app.vendor.nexsicherung import tools

        return sorted((rel, tools.sha256_file(full)) for rel, full in backup_hooks._vault_files(paths.vault_root()))

    def legacy_archive(self) -> tuple[Path, Any]:
        """A backup as nexlore 1.16.0 made it (``services/backups.create`` before the module): the same members and
        manifest (its dataclass with every field, in this order), version 1.16.0, the old name."""
        self.add_content("from the old version")
        held = self.content()
        from app.services import backup_hooks, backups

        folder = backups.folder()
        folder.mkdir(parents=True, exist_ok=True)
        moment = datetime(2026, 10, 1, 3, 0, 0, tzinfo=UTC)
        target = folder / f"nexlore-{moment.strftime('%Y-%m-%d-%H%M%S')}.zip"
        backup_hooks.write_archive(target, {"version": "1.16.0", "created": moment.isoformat(timespec="seconds"),
                                            "kind": "scheduled", "note": ""})
        with zipfile.ZipFile(target) as archive:
            manifest = json.loads(archive.read(backup_hooks.MANIFEST))
            members = [(info, archive.read(info)) for info in archive.infolist() if info.filename != backup_hooks.MANIFEST]
        fields = ("version", "created", "kind", "note", "notes", "files", "bytes", "vault", "trash")
        old = {key: manifest[key] for key in fields}
        os.remove(target)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for info, data in members:
                archive.writestr(info, data)
            archive.writestr(backup_hooks.MANIFEST, json.dumps(old, ensure_ascii=False))
        return target, held

    def settings_schedule(self) -> tuple[str, int]:
        found = self.operator().get("/api/settings").json()
        return found["backup_schedule"], found["backup_keep"]
