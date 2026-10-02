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
# The guide space only where a test asks for it (test_guide.py): an empty vault at the setup would get one.
os.environ["NEXLORE_WELCOME_GUIDE"] = "0"
# Argon2 as cheap as it goes: the tests make hundreds of accounts. The strength itself is Argon2's business.
os.environ["NEXLORE_ARGON2_TIME"] = "1"
os.environ["NEXLORE_ARGON2_MEMORY_KIB"] = "1024"
os.environ["NEXLORE_ARGON2_PARALLELISM"] = "1"
# Never GitHub from a test: port 9 refuses at once, and the update tests put their own answer in place.
os.environ["NEXLORE_UPDATE_URL"] = "http://127.0.0.1:9/releases/latest"
os.environ["NEXLORE_SECRET_KEY"] = "test-secret-key-for-the-test-run-only"
# The code the first account brings (otherwise one made at start and written to the log).
SETUP_CODE = "test-setup-code"
os.environ["NEXLORE_SETUP_TOKEN"] = SETUP_CODE

import shutil  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, text  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import FTS_TABLE, MEMBER, OPERATOR, TRI_TABLE, Account, Base, Setting  # noqa: E402
from app.security import SESSION_COOKIE, brake, hash_password, start_session  # noqa: E402
from app.services import apitokens, graphstore, mcp, notify, totp, updates  # noqa: E402

# Notifications go out at once in the tests, so that a test sees them (block Z2).
notify.INLINE = True

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
        db.execute(text(f"INSERT INTO {TRI_TABLE}({TRI_TABLE}) VALUES ('delete-all')"))  # noqa: S608
        db.execute(delete(Setting))
        db.commit()
    _empty_vault()
    # The trash folder too: ids are handed out again after a clean database, and a file of an earlier test would
    # count as the trash of this one.
    shutil.rmtree(Path(_DATA) / "trash", ignore_errors=True)
    brake.forget()
    notify.forget()
    graphstore.forget()
    mcp.forget()
    apitokens.forget()
    totp.forget()
    updates.forget()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def vault() -> Path:
    """The test run's vault folder, empty."""
    return VAULT


PASSWORD = "correct horse battery"


def make_account(name: str, role: str = MEMBER, password: str = PASSWORD) -> Account:
    """An account with a password, straight into the database."""
    with SessionLocal() as db:
        row = Account(name=name, role=role, password_hash=hash_password(password))
        db.add(row)
        db.commit()
        db.expunge(row)
    return row


def sign_in(client: TestClient, account: Account) -> None:
    """The client carries a session of ``account`` from now on (a real one, as after signing in)."""
    with SessionLocal() as db:
        row = db.get(Account, account.id)
        assert row is not None
        token = start_session(db, row, "127.0.0.1", "tests")
    client.cookies.set(SESSION_COOKIE, token)


def join(manager: TestClient, space: str, name: str, role: str) -> None:
    """``name`` gets ``role`` in ``space``: a member's right changes at once; anybody else is invited by the manager
    and says yes, as in the interface (an invitation by name is answered under "New")."""
    from app.models import SpaceNotice
    from app.services import notices

    answer = manager.put(f"/api/spaces/{space}/members/{name}", json={"role": role})
    assert answer.status_code in (200, 202), answer.text
    if answer.status_code == 202:
        with SessionLocal() as db:
            person = db.query(Account).filter_by(name=name).one()
            notice = db.query(SpaceNotice).filter_by(account_id=person.id, kind="invite", done_at=None).order_by(
                SpaceNotice.id.desc()).first()
            assert notice is not None
            notices.answer(db, person, notice.id, accept=True)


def _operator(client: TestClient) -> Account:
    with SessionLocal() as db:
        row = db.query(Account).filter_by(name="tester").one_or_none()
        if row is not None:
            db.expunge(row)
    if row is None:
        row = make_account("tester", OPERATOR)
    sign_in(client, row)
    return row


@pytest.fixture
def account(client: TestClient) -> Account:
    """The signed-in operator ``tester``: spaces that came from the disk have no members and are the operator's."""
    return _operator(client)


@pytest.fixture
def client() -> Iterator[TestClient]:
    # As the interface does: every request names its tab (changes are refused without it).
    with TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-tests000"}) as test_client:
        yield test_client


@pytest.fixture
def operator(client: TestClient) -> Account:
    """The signed-in operator; the same account as ``account``."""
    return _operator(client)
