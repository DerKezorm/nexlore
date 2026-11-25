"""What a database of 1.16.0 needs for the shared account module beyond new columns and tables, at every start after
``db.init_db`` made those (with a backup before, ``db._add_missing_columns``). Only adding, never renaming or deleting;
a second start finds nothing to do.

- Every session of 1.16.0 gets the id the list "Signed-in devices" names it by.
- Usernames are unique without regard to case in the database too, as the module asks (two changes at the same moment
  never both get through). 1.16.0 always wrote them in lower case, so the index fits every database it made; should a
  database hold two names that differ only in case anyway, the index is left out with a warning and the start goes on.
- Addresses get an index without regard to case, **not** a unique one: 1.16.0 could leave one address at two accounts,
  and such a pair signs in by name only (the module, rule 3 of the draft).
- Once (``SETTING``): an address the account confirmed itself through its link (``email_source`` ``own``) is
  **proven**; every address counts already (the column's default). And the names an account deleted for good left in
  the history (versions, uploads, comments, moves, decisions, plugins, notices) are reserved for ever, like every
  former name from now on: nobody inherits another person's history, uploads or mentions (draft, "Alte
  Benutzernamen").
"""

from __future__ import annotations

import json
import logging
import secrets

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger("nexlore.db")

#: The setting that says the one-time steps ran (their version).
SETTING = "konten_migrated"
VERSION = 1

#: Where 1.16.0 keeps a username as text: (table, column).
NAME_COLUMNS = (
    ("versions", "author"),
    ("files", "owner"),
    ("files", "deleted_by"),
    ("move_jobs", "author"),
    ("comments", "author"),
    ("comments", "resolved_by"),
    ("proposals", "decided_by"),
    ("plugins", "installed_by"),
    ("space_notices", "actor"),
)


def _columns(connection: Connection, table: str) -> set[str]:
    # Table names from the constant above, never input.
    return {row[1] for row in connection.execute(text(f'PRAGMA table_info("{table}")'))}


def history_names(connection: Connection) -> set[str]:
    """Every username the history keeps as text, in lower case."""
    found: set[str] = set()
    for table, column in NAME_COLUMNS:
        if column not in _columns(connection, table):
            continue
        rows = connection.execute(text(f'SELECT DISTINCT "{column}" FROM "{table}" WHERE "{column}" <> \'\''))  # noqa: S608
        found.update(str(row[0]).strip().lower() for row in rows if row[0] and str(row[0]).strip())
    return found


def _once(connection: Connection) -> None:
    done = connection.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": SETTING}).first()
    if done is not None:
        return
    proven = connection.execute(
        text("UPDATE accounts SET email_proven = 1 WHERE email <> '' AND email_source = 'own'")
    ).rowcount
    accounts = {str(row[0]).lower() for row in connection.execute(text("SELECT name FROM accounts"))}
    known = {str(row[0]).lower() for row in connection.execute(text("SELECT name FROM former_names"))}
    gone = sorted(history_names(connection) - accounts - known)
    for name in gone:
        connection.execute(
            text("INSERT INTO former_names (account_id, name, created_at) VALUES (NULL, :name, CURRENT_TIMESTAMP)"),
            {"name": name[:64]},
        )
    connection.execute(text("INSERT INTO settings (key, value) VALUES (:key, :value)"),
                       {"key": SETTING, "value": json.dumps(VERSION)})
    logger.info("Accounts of an older version taken over: proven addresses=%s, names of deleted accounts reserved=%s",
                proven or 0, len(gone))


def run(engine: Engine) -> None:
    with engine.begin() as connection:
        missing = [row[0] for row in connection.execute(text("SELECT id FROM auth_sessions WHERE uid IS NULL"))]
        for session_id in missing:
            connection.execute(text("UPDATE auth_sessions SET uid = :uid WHERE id = :id"),
                               {"uid": secrets.token_hex(12), "id": session_id})
        if missing:
            logger.info("Sessions of an older version named for the session list count=%s", len(missing))

        doubles = connection.execute(
            text("SELECT lower(name) FROM accounts GROUP BY lower(name) HAVING count(*) > 1")
        ).first()
        if doubles is None:
            connection.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_name_lower ON accounts (lower(name))")
            )
        else:
            logger.warning("Two accounts have names that differ only in case; the unique index waits until one is "
                           "renamed")
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_accounts_email_lower ON accounts (lower(email))"))
        # Expression indexes here, not in the model: SQLAlchemy cannot read them back and would make them twice.
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_former_names_lower ON former_names (lower(name))"))
        for table, column in (("versions", "author"), ("files", "owner"), ("comments", "author")):
            # The rename carries the name along in these (``konten_store.set_username``): an index each, so that it
            # does not read the whole history under the write lock.
            connection.execute(text(f'CREATE INDEX IF NOT EXISTS "ix_{table}_{column}_name" ON "{table}" ("{column}")'))
        _once(connection)
