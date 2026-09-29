"""The search page: every note that fits a search with operators (``services/searchquery``), best first, each with the
lines it was found in. Only readable spaces; nothing of the search text reaches SQL or FTS5 as syntax.
"""

from __future__ import annotations

import time
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import and_, column, exists, func, select, table, text

from ..db import SessionLocal
from ..deps import Account, readable_spaces
from ..models import FTS_TABLE, File, Space, Tag, Task
from ..services import index, paths, snippets, tagrename
from ..services.searchquery import Query as SearchQuery
from ..services.searchquery import fold, parse
from ..services.tasks import OPEN

router = APIRouter(prefix="/api", tags=["search"])

#: The full-text table, for joining; what it may match is always bound, never written into the statement.
FTS = table(FTS_TABLE, column("rowid"))
MAX_LINES = 5
LINE_CHARS = 240
TASK_LINE = ("- [", "* [", "+ [")


class Line(BaseModel):
    line: int
    text: str


class Found(BaseModel):
    path: str
    title: str
    lines: list[Line]


class Page(BaseModel):
    notes: list[Found]
    more: bool
    ms: int


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _filters(query: SearchQuery, account: Any) -> list[Any]:
    where: list[Any] = [File.is_note.is_(True), File.deleted_at.is_(None), File.space_id.in_(readable_spaces(account))]
    if query.spaces:
        wanted = [paths.fold(name) for name in query.spaces]
        where.append(File.space_id.in_(select(Space.id).where(func.nx_fold(Space.folder).in_(wanted))))
    for part in query.paths:
        where.append(func.nx_fold(File.path).like(_like(paths.fold(part)), escape="\\"))
    for part in query.files:
        where.append(File.name_key.like(_like(paths.fold(part)), escape="\\"))
    for tag in query.tags:
        where.append(exists().where(Tag.file_id == File.id, tagrename.with_tag(paths.fold(tag))))
    for number, (name, value) in enumerate(query.properties):
        # One property of the front matter by its name, and part of its value (in a list: any item).
        # Only numbers go into the text of the statement; names and values are bound.
        condition = (
            f"EXISTS (SELECT 1 FROM json_each(files.front) AS p WHERE nx_fold(p.key) = :pk{number}"  # noqa: S608
            + (
                f" AND (nx_fold(p.value) LIKE :pv{number} ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each("  # noqa: S608
                f"CASE WHEN p.type = 'array' THEN p.value ELSE '[]' END) AS q"
                f" WHERE nx_fold(q.value) LIKE :pv{number} ESCAPE '\\'))"
                if value
                else ""
            )
            + ")"
        )
        values = {f"pk{number}": paths.fold(name)}
        if value:
            values[f"pv{number}"] = _like(paths.fold(value))
        where.append(text(condition).bindparams(**values))
    if query.tasks:
        where.append(exists().where(Task.file_id == File.id, Task.status == OPEN))
    if query.changed:
        where.append(File.mtime_ns >= int((time.time() - query.changed) * 1e9))
    return where


def _mark(line: str, terms: list[str]) -> str | None:
    """The line with the terms marked (control characters, as the quick switcher's snippets), or None without one."""
    folded = fold(line)
    if not any(term in folded for term in terms):
        return None
    if len(folded) != len(line):
        # Folding changed the length (a letter with its accent apart): the line without marks.
        return line
    spans: list[tuple[int, int]] = []
    for term in terms:
        start = folded.find(term)
        while start >= 0 and term:
            spans.append((start, start + len(term)))
            start = folded.find(term, start + len(term))
    out, position = [], 0
    for start, end in sorted(spans):
        if start < position:
            continue
        out.append(line[position:start] + "\x02" + line[start:end] + "\x03")
        position = end
    out.append(line[position:])
    return "".join(out)


def _lines(path: str, query: SearchQuery) -> list[Line]:
    """Where in the note it was found: the lines with a search word (with open tasks: the task lines)."""
    try:
        content = index.decode(paths.vault_root().joinpath(*path.split("/")).read_bytes())
    except OSError:
        return []
    terms = query.terms()
    found: list[Line] = []
    for number, raw in enumerate(content.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped == "---":
            continue
        if query.tasks and not stripped.startswith(TASK_LINE):
            continue
        marked = _mark(stripped, terms) if terms else stripped
        if marked is None:
            continue
        found.append(Line(line=number, text=snippets.plain(marked[:LINE_CHARS])))
        if len(found) >= MAX_LINES:
            break
    return found


@router.get("/search/notes", response_model=Page, summary="Notes that fit a search with operators, with their lines")
def search_notes(
    account: Account,
    q: Annotated[str, Query(max_length=500)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> Page:
    started = time.monotonic()
    query = parse(q)
    if query.empty:
        return Page(notes=[], more=False, ms=0)
    statement = select(File.id, File.path, File.title).where(and_(*_filters(query, account)))
    fts = query.fts()
    if fts:
        statement = (
            statement.join(FTS, FTS.c.rowid == File.id)
            .where(text(f"{FTS_TABLE} MATCH :fts").bindparams(fts=fts))
            .order_by(text(f"bm25({FTS_TABLE}, 10.0, 1.0)"))
        )
    else:
        without = query.fts_without()
        if without:
            left_out = select(FTS.c.rowid).where(
                text(f"{FTS_TABLE} MATCH :no").bindparams(no=without)
            )
            statement = statement.where(~File.id.in_(left_out))
        statement = statement.order_by(File.mtime_ns.desc())
    with SessionLocal() as db:
        rows = db.execute(statement.offset(offset).limit(limit + 1)).all()
    notes = [Found(path=row.path, title=row.title, lines=_lines(row.path, query)) for row in rows[:limit]]
    return Page(notes=notes, more=len(rows) > limit, ms=round((time.monotonic() - started) * 1000))

