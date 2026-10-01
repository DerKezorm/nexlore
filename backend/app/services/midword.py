"""
Words found in the middle of a word ("otter" in "Zwergotter", review before 1.0.0, P4.17), behind the hits of the
word index. The text is cut into trigrams in ``notes_tri`` without positions (``detail='none'``) and without a copy of
its own (the word index ``notes_fts`` holds it): that adds about a sixth to the word index, where a full trigram
index doubled the database. Without positions a word cannot be asked for as such, so its trigrams are asked for one
by one, and every note found that way is checked against its text.

An index without a copy must be told what it forgets: before a note's text leaves ``notes_fts``, ``forget`` hands the
old text to ``notes_tri``. When the two ever disagree in their number of rows, ``init_db`` builds it anew.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from ..models import FTS_TABLE, TRI_TABLE


def _trigrams(term: str) -> list[str]:
    # Case does not count: the trigram tokenizer folds it on both sides.
    return sorted({term[i : i + 3] for i in range(len(term) - 2) if '"' not in term[i : i + 3]})


def match(groups: list[list[str]]) -> str | None:
    """The trigram query for groups of terms: every group must be found, of a group one term is enough. None when a
    term is shorter than three letters."""
    if not groups:
        return None
    parts = []
    for group in groups:
        alternatives = [" ".join(f'"{gram}"' for gram in _trigrams(term)) for term in group]
        alternatives = [alternative for alternative in alternatives if alternative]
        if not alternatives:
            return None
        either = "(" + " OR ".join(f"({alternative})" for alternative in alternatives) + ")"
        parts.append(alternatives[0] if len(alternatives) == 1 else either)
    return " AND ".join(parts)


def verify(groups: list[list[str]], fold: Any, column: str = "x") -> tuple[str, dict[str, str]]:
    """The check of a candidate against its text (title and body of ``notes_fts`` as ``column``): SQL and values."""
    conditions = []
    values: dict[str, str] = {}
    for number, group in enumerate(groups):
        options = []
        for index, term in enumerate(group):
            key = f"mw{number}_{index}"
            if term.isascii():
                # SQLite's own LIKE ignores the case of ASCII letters and runs in C: three times faster here than
                # folding every candidate's text in Python (measured with 30.000 notes).
                values[key] = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                options.append(f"({column}.title LIKE :{key} ESCAPE '\\' OR {column}.body LIKE :{key} ESCAPE '\\')")
                continue
            values[key] = "%" + fold(term).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            options.append(f"nx_fold({column}.title || ' ' || {column}.body) LIKE :{key} ESCAPE '\\'")
        conditions.append("(" + " OR ".join(options) + ")")
    return " AND ".join(conditions), values


def add(connection: Any, rows: list[dict[str, Any]]) -> None:
    """New text (rows with ``id``, ``title``, ``body``), right after it went into the word index."""
    if rows:
        connection.execute(text(f"INSERT INTO {TRI_TABLE}(rowid, title, body) VALUES (:id, :title, :body)"), rows)  # noqa: S608


def forget(db: Any, file_id: int) -> None:
    """A note's text before it leaves the word index: the trigram index is told what to take out."""
    row = db.execute(text(f"SELECT title, body FROM {FTS_TABLE} WHERE rowid = :id"), {"id": file_id}).first()  # noqa: S608
    if row is None:
        return
    db.execute(
        text(f"INSERT INTO {TRI_TABLE}({TRI_TABLE}, rowid, title, body) VALUES ('delete', :id, :title, :body)"),  # noqa: S608
        {"id": file_id, "title": row[0], "body": row[1]},
    )


def retitle(db: Any, file_id: int, title: str) -> None:
    """A new title, before the word index takes it: out with the old one, in with the new."""
    row = db.execute(text(f"SELECT title, body FROM {FTS_TABLE} WHERE rowid = :id"), {"id": file_id}).first()  # noqa: S608
    if row is None:
        return
    forget(db, file_id)
    db.execute(
        text(f"INSERT INTO {TRI_TABLE}(rowid, title, body) VALUES (:id, :title, :body)"),  # noqa: S608
        {"id": file_id, "title": title, "body": row[1]},
    )


#: Set once the trigram index of this shape is built (a database from before has none, or a fuller one).
BUILT_KEY = "midword_index"
BUILT = "trigram detail=none v1"


def rebuild_if_needed(connection: Any) -> None:
    """At the start: built from the word index when this shape of it was never built here (an older database). Its
    rows cannot be counted apart from the word index (it reads its text from there), hence the mark."""
    mark = connection.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": BUILT_KEY}).first()
    if mark is not None and BUILT in str(mark[0]):
        return
    # Emptied and filled from the word index ('rebuild' cannot read its text from another full-text table).
    connection.execute(text(f"INSERT INTO {TRI_TABLE}({TRI_TABLE}) VALUES ('delete-all')"))  # noqa: S608
    connection.execute(
        text(f"INSERT INTO {TRI_TABLE}(rowid, title, body) SELECT rowid, title, body FROM {FTS_TABLE}")  # noqa: S608
    )
    connection.execute(text("DELETE FROM settings WHERE key = :key"), {"key": BUILT_KEY})
    connection.execute(
        text("INSERT INTO settings(key, value) VALUES (:key, :value)"), {"key": BUILT_KEY, "value": f'"{BUILT}"'}
    )
