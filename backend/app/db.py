"""SQLite connection and the addition of new columns at start.

There is no Alembic. New tables come from ``create_all``, new columns from ``_add_missing_columns``.
Renaming or dropping never happens automatically.
"""

from __future__ import annotations

import logging
import unicodedata
from collections.abc import Iterator
from enum import Enum
from typing import Any

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from .config import get_settings
from .models import FTS_CREATE, Base

logger = logging.getLogger("nexlore.db")

_settings = get_settings()
_settings.data_dir.mkdir(parents=True, exist_ok=True)

#: How long a write waits for another one to finish. Every writer keeps its transactions short (a scan too, see
#: ``services/index.py``); this is the margin for a slow disk, not a wait anybody should see.
BUSY_SECONDS = 15

# No pool with an upper bound: with the default pool the sixteenth concurrent request would block the event
# loop waiting for a connection. Opening a SQLite connection costs a fraction of a millisecond.
engine = create_engine(
    f"sqlite:///{_settings.database_path}",
    connect_args={"check_same_thread": False, "timeout": BUSY_SECONDS},
    poolclass=NullPool,
    # A failed statement names its values in the exception, and exceptions reach the log: never note texts or hashes.
    hide_parameters=True,
)


@event.listens_for(engine, "connect")
def _pragmas(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute(f"PRAGMA busy_timeout={BUSY_SECONDS * 1000}")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()
    # SQLite's own lower() and LIKE fold only ASCII: "Ä" never met "ä". This folds like ``paths.fold``.
    dbapi_connection.create_function("nx_fold", 1, _fold, deterministic=True)


def _fold(value: Any) -> str | None:
    return None if value is None else unicodedata.normalize("NFC", str(value)).casefold()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


def init_db() -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns()
    with engine.begin() as connection:
        connection.execute(text(FTS_CREATE))
    # create_all makes the indexes of new tables only; one added to an existing table comes here.
    for table in Base.metadata.sorted_tables:
        for table_index in table.indexes:
            table_index.create(engine, checkfirst=True)


def _sql_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, Enum):
        value = value.value
    return "'" + str(value).replace("'", "''") + "'"


def _add_missing_columns() -> None:
    inspector = inspect(engine)
    missing = [
        column
        for table in Base.metadata.sorted_tables
        if inspector.has_table(table.name)
        for column in table.columns
        if column.name not in {existing["name"] for existing in inspector.get_columns(table.name)}
    ]
    if missing:
        # A schema change is the moment a backup is worth most: the way back if the new version goes wrong.
        from .services import backups

        backups.create(kind=backups.UPDATE, note="before adding columns")
    with engine.begin() as connection:
        for table in Base.metadata.sorted_tables:
            existing = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                default = None
                if column.default is not None and not callable(column.default.arg):
                    default = column.default.arg
                if not column.nullable and default is None:
                    raise RuntimeError(
                        f"Column {table.name}.{column.name} is required but has no default. "
                        "Give it a default before starting."
                    )
                column_type = column.type.compile(dialect=engine.dialect)
                statement = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column_type}'
                if default is not None:
                    statement += f" DEFAULT {_sql_literal(default)}"
                connection.execute(text(statement))
                logger.info("Added column %s.%s", table.name, column.name)
