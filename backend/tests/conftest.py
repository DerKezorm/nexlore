"""Every test run gets its own empty data directory; nothing touches ``data/`` of the project."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

_DATA = tempfile.mkdtemp(prefix="nexlore-tests-")
os.environ["NEXLORE_DATA_DIR"] = _DATA
os.environ["NEXLORE_DISABLE_BACKGROUND"] = "1"
os.environ["NEXLORE_FRONTEND_DIST"] = os.path.join(_DATA, "no-frontend")
os.environ.pop("NEXLORE_VAULT_DIR", None)
os.environ.pop("NEXLORE_LOCALES_DIR", None)
os.environ.pop("NEXLORE_LOG_LEVEL", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.deps import require_operator  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Setting  # noqa: E402

DATA_DIR = _DATA


@pytest.fixture(autouse=True)
def clean_db() -> Iterator[None]:
    init_db()
    with SessionLocal() as db:
        db.execute(delete(Setting))
        db.commit()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, base_url="http://testserver") as test_client:
        yield test_client


@pytest.fixture
def operator(client: TestClient) -> str:
    """Stands in for the operator until accounts exist (M4)."""
    app.dependency_overrides[require_operator] = lambda: "admin"
    return "admin"
