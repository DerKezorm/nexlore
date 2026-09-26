"""Every test run gets its own empty data directory; nothing touches ``data/`` of the project."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

_DATA = tempfile.mkdtemp(prefix="nexlore-tests-")
os.environ["NEXLORE_DATA_DIR"] = _DATA
os.environ["NEXLORE_DISABLE_BACKGROUND"] = "1"
os.environ["NEXLORE_FRONTEND_DIST"] = os.path.join(_DATA, "no-frontend")
# Set, not removed: a value in the environment wins over a .env file in the project, a removed one does not. The
# locales fixture empties its directory, and that must never be a real one from somebody's .env.
os.environ["NEXLORE_VAULT_DIR"] = os.path.join(_DATA, "vault")
os.environ["NEXLORE_LOCALES_DIR"] = os.path.join(_DATA, "locales")
os.environ["NEXLORE_LOG_LEVEL"] = ""
os.environ["NEXLORE_API_DOCS"] = "false"

import shutil  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, text  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.deps import require_account, require_operator  # noqa: E402
from app.main import app  # noqa: E402
from app.models import FTS_TABLE, Base, Setting  # noqa: E402

DATA_DIR = _DATA
VAULT = Path(_DATA) / "vault"


def _empty_vault() -> None:
    # Only ever the test run's own folder, never one a .env might name.
    assert VAULT.resolve().is_relative_to(Path(_DATA).resolve())
    if VAULT.exists():
        shutil.rmtree(VAULT)
    VAULT.mkdir(parents=True)


@pytest.fixture(scope="session", autouse=True)
def schema() -> None:
    init_db()


@pytest.fixture(autouse=True)
def clean_db(schema: None) -> Iterator[None]:
    with SessionLocal() as db:
        for table in reversed(Base.metadata.sorted_tables):
            db.execute(delete(table))
        db.execute(text(f"DELETE FROM {FTS_TABLE}"))  # noqa: S608
        db.execute(delete(Setting))
        db.commit()
    _empty_vault()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def vault() -> Path:
    """The test run's vault folder, empty."""
    return VAULT


@pytest.fixture
def account(client: TestClient) -> str:
    """Stands in for a signed-in account until accounts exist (M4)."""
    app.dependency_overrides[require_account] = lambda: "tester"
    return "tester"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, base_url="http://testserver") as test_client:
        yield test_client


@pytest.fixture
def operator(client: TestClient) -> str:
    """Stands in for the operator until accounts exist (M4)."""
    app.dependency_overrides[require_operator] = lambda: "admin"
    return "admin"
