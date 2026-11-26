"""nexsprachen contract tests: nexlore's adapter (copied once from the module's template, now nexlore's file).

The contract tests in ``backend/tests/nexsprachen/`` run the module inside nexlore: its configuration
(``services/locales.py``: the folder ``<data_dir>/locales`` or ``NEXLORE_LOCALES_DIR`` of before, German and English
built in), its routes under ``/api/locales`` (readable without signing in, as before; adding and removing for the
operator, ``deps.require_operator``) and nexlore's form of a refusal (``{"detail": {"code", "message", …}}``). The
page makes the template from its English texts, so the server hands none out. Each start gets a folder of its own.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any, ClassVar

from sprachen_contract import StandardAdapter

TAB = {"X-Nexlore-Client": "tab-tests000"}
FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"


class Adapter(StandardAdapter):
    package = "app.vendor.nexsprachen"
    prefix = "/api/locales"
    also: tuple[str, ...] = ()
    built_in: ClassVar[dict[str, str]] = {"de": "Deutsch", "en": "English"}
    public_read = True
    has_template = False
    # The names nexlore's routes had before (routers/locales.py). nexlore publishes its description under
    # /api/openapi.json only with NEXLORE_API_DOCS (off in the tests): the contract tests read app.openapi() instead
    # (description), nothing is opened for them.
    openapi_path = "/api/openapi.json"
    # Written out, not taken from the router: a change there must turn the contract test red.
    operation_ids: ClassVar[dict[str, str]] = {
        "list": "list_locales_api_locales_get",
        "read": "read_locale_api_locales__code__get",
        "upload": "upload_locale_api_locales__code__put",
        "remove": "delete_locale_api_locales__code__delete",
    }
    summaries: ClassVar[dict[str, str]] = {
        "list": "Languages the operator added",
        "read": "The texts of one added language",
        "upload": "Add or replace a language (operator)",
        "remove": "Remove an added language (operator)",
    }
    schema_names: ClassVar[dict[str, str]] = {"LanguageEntry": "LocaleEntry", "LocaleEntry": "LocaleEntry"}

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

    def restart(self) -> None:
        """nexlore started again on the same folder, as in production: the app's lifespan (``locales.start``:
        ``configure``, then ``tidy_at_start``)."""
        from fastapi.testclient import TestClient

        from app.main import app

        with TestClient(app, base_url="http://testserver", headers=TAB):
            pass

    def description(self) -> dict[str, Any]:
        """nexlore's own description of its interface, as ``/api/openapi.json`` would give it with NEXLORE_API_DOCS."""
        from app.main import app

        found: dict[str, Any] = app.openapi()
        return found

    def offered_template(self) -> dict[str, Any]:
        """The template as the page offers it (sprachen 1.0.2): ``en`` of ``frontend/src/i18n/index.ts``, nexlore's own
        English with the words of the modules oidc, konten and post laid over it in that order, through the module's
        rule (``textsOnly`` on the page, ``texts_only`` here), with ``_meta``. ``oidcWording`` with
        ``singleAccount: false, invitations: true`` only drops the groups ``single`` and ``noInvitations``."""
        from app.vendor import nexsprachen

        def read(path: str) -> dict[str, Any]:
            found: dict[str, Any] = json.loads((FRONTEND / path).read_text(encoding="utf-8"))
            return found

        oidc = read("vendor/nexoidc/oidc.en.json")
        if isinstance(oidc.get("oidc"), dict):
            oidc["oidc"] = {key: value for key, value in oidc["oidc"].items() if key not in ("single", "noInvitations")}
        english = {
            **read("i18n/en.json"),
            **oidc,
            **read("vendor/nexkonten/konten.en.json"),
            **read("vendor/nexpost/post.en.json"),
        }
        return {
            "_meta": {"name": "Name of the language in itself, for example Nederlands"},
            **nexsprachen.texts_only(english),
        }

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
