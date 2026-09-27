"""Everyday use (M6): daily notes, templates, the calendar and the task overview.

**Daily notes** are ``JJJJ-MM-TT.md`` in a folder each space sets for itself (``Space.options``), made from a
template if the space names one. **Templates** are the notes in the space's template folder; their placeholders are
filled the way Obsidian's core plugin fills them (``templates.py``), nothing in them is ever run.

**Tasks** live in the index (``Task``), one row per line with a checkbox. Ticking one off from the overview changes
that one line in the file and nothing else, byte for byte; the file is written through ``vault.save`` against the
state it was read in, so a change from outside in between ends in a conflict copy, never lost. Every question is asked
for the spaces the account may read only; a space it may not read answers like one that does not exist.
"""

from __future__ import annotations

import os
import posixpath
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..models import File, Space, Task
from . import index, paths, tasks, templates, vault
from .spaceopts import DATE, daily_path, is_daily, options_of
from .vault import Actor, VaultError

MONTH = re.compile(r"^\d{4}-\d{2}$")
_LINE_END = re.compile(rb"\r\n|\n|\r")
BOM = b"\xef\xbb\xbf"


def valid_date(value: str) -> str:
    if not DATE.match(value):
        raise VaultError("invalid_input", "not a date")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise VaultError("invalid_input", "not a date") from exc
    return value


# --- Options of a space --------------------------------------------------------------------------------------------


def _clean_folder(value: str) -> str:
    value = value.strip().strip("/")
    if not value:
        return ""
    parts = value.split("/")
    try:
        return "/".join(paths.check_name(part) for part in parts)
    except paths.PathError as exc:
        raise VaultError(exc.code, str(exc)) from exc


def set_options(space_name: str, values: dict[str, str]) -> dict[str, str]:
    """Store what the managers of a space chose. Folders are relative to the space; the template is a note in it."""
    clean: dict[str, str] = {}
    for key in ("daily_folder", "template_folder"):
        if key in values:
            clean[key] = _clean_folder(values[key])
    if "daily_template" in values:
        template = _clean_folder(values["daily_template"])
        if template and not paths.is_note(template):
            raise VaultError("not_a_note", "a template is a note")
        clean["daily_template"] = template
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == space_name))
        if space is None:
            raise VaultError("not_found", "no such space", 404)
        stored = dict(space.options) if isinstance(space.options, dict) else {}
        stored.update(clean)
        # A new dict: the JSON column only notices a new value, not one changed in place.
        space.options = stored
        db.commit()
        return options_of(space)


def options(space_name: str) -> dict[str, str]:
    with SessionLocal() as db:
        space = db.scalar(select(Space).where(Space.folder == space_name))
        if space is None:
            raise VaultError("not_found", "no such space", 404)
        return options_of(space)


def all_options(db: Session, space_ids: set[int]) -> dict[int, tuple[str, dict[str, str]]]:
    spaces = db.scalars(select(Space).where(Space.id.in_(space_ids)))
    return {space.id: (space.folder, options_of(space)) for space in spaces}


# --- Daily notes ---------------------------------------------------------------------------------------------------


@dataclass
class Daily:
    path: str
    created: bool


def open_daily(space_name: str, day: str, *, actor: Actor, may_write: bool, language: str = "en") -> Daily:
    """The daily note of ``day`` in a space; made (from the space's template) when it is not there and the caller
    may write. Two clicks at once make one note."""
    day = valid_date(day)
    opts = options(space_name)
    rel = daily_path(space_name, opts, day)
    with index.guard:
        with SessionLocal() as db:
            found = vault.live_by_key(db, rel)
            if found is not None:
                return Daily(path=found.path, created=False)
        folder = posixpath.dirname(rel)
        on_disk = _on_disk(folder, f"{day}.md")
        if on_disk is not None:
            # There already, in other letters (2026-09-27.MD) and not read by the index yet: that one is the note.
            return Daily(path=_take_in(on_disk), created=False)
        if not may_write:
            raise VaultError("forbidden", "Your right in this space does not allow this.", 403)
        now = datetime.now().astimezone()
        when = datetime.combine(date.fromisoformat(day), now.time())
        content = ""
        if opts["daily_template"]:
            content = render(f"{space_name}/{opts['daily_template']}", title=day, when=when, language=language)
        paths.resolve(folder).mkdir(parents=True, exist_ok=True)
        file = vault.create_note(folder, day, content.encode("utf-8"), actor=actor)
    return Daily(path=file.path, created=True)


def _on_disk(folder: str, name: str) -> str | None:
    """The file of this name in the folder, compared as Windows and macOS compare (case does not count)."""
    try:
        directory = paths.resolve(folder)
        entries = os.listdir(directory) if directory.is_dir() else []
    except (OSError, paths.PathError):
        return None
    wanted = paths.fold(name)
    for entry in entries:
        if paths.fold(entry) == wanted and (directory / entry).is_file():
            return f"{folder}/{entry}"
    return None


def _take_in(rel: str) -> str:
    """A file the index has not read yet, read now (under ``guard``, as the caller holds it; never a scan, which
    would wait for a scan that waits for this lock)."""
    full = paths.resolve(rel)
    data = full.read_bytes()
    with SessionLocal() as db:
        file = index.record(db, rel, data, full.stat(), source=index.EXTERNAL)
        index.reresolve(db, file.space_id, [file.name_key])
        db.commit()
    return rel


# --- Templates -----------------------------------------------------------------------------------------------------


def template_list(space_name: str) -> list[dict[str, str]]:
    opts = options(space_name)
    folder = opts["template_folder"]
    if not folder:
        return []
    prefix = f"{space_name}/{folder}/"
    with SessionLocal() as db:
        rows = db.execute(
            select(File.path, File.title).where(
                File.deleted_at.is_(None), File.is_note.is_(True), File.path_key > paths.fold(prefix),
                File.path_key < paths.fold(prefix[:-1]) + "0",
            )
        ).all()
    found = [{"path": path, "title": title or paths.stem(path)} for path, title in rows]
    return sorted(found, key=lambda item: paths.fold(item["path"]))


def render(template_rel: str, *, title: str, when: datetime, language: str = "en") -> str:
    """The template's text with its placeholders filled. Templater code stays as it was."""
    _file, data = vault.read(template_rel)
    return templates.fill(data.decode("utf-8-sig", errors="replace"), title=title, when=when, language=language)


# --- Tasks ---------------------------------------------------------------------------------------------------------


OPEN = tasks.OPEN
WHEN = ("overdue", "today", "week", "later", "none")


def _when(today: str) -> dict[str, Any]:
    week_end = (date.fromisoformat(today) + timedelta(days=6)).isoformat()
    moment = func.coalesce(Task.due, Task.scheduled)
    return {
        "overdue": moment < today,
        "today": moment == today,
        "week": and_(moment > today, moment <= week_end),
        "later": moment > week_end,
        "none": moment.is_(None),
    }


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def task_query(
    space_ids: set[int], *, status: str, when: str | None, today: str, on: str | None, tag: str | None, q: str | None,
    space_id: int | None, between: tuple[str, str] | None = None,
) -> Any:
    conditions: list[Any] = [Task.space_id.in_(space_ids)]
    if space_id is not None:
        conditions.append(Task.space_id == space_id)
    if status == "open":
        conditions.append(Task.status == OPEN)
    elif status == "done":
        conditions.append(Task.status != OPEN)
    if when:
        conditions.append(_when(today)[when])
    if on:
        conditions.append(or_(Task.due == on, Task.scheduled == on))
    if between:
        moment = func.coalesce(Task.due, Task.scheduled)
        conditions.append(and_(moment >= between[0], moment <= between[1]))
    if tag:
        key = paths.fold(tag.lstrip("#"))
        conditions.append(Task.tag_keys.like(f"% {_like(key)} %", escape="\\"))
    if q:
        conditions.append(Task.text.like(f"%{_like(q)}%", escape="\\"))
    return and_(*conditions)


def list_tasks(
    space_ids: set[int], *, status: str = "open", when: str | None = None, today: str, on: str | None = None,
    tag: str | None = None, q: str | None = None, space_id: int | None = None, offset: int = 0, limit: int = 200,
    between: tuple[str, str] | None = None,
) -> dict[str, Any]:
    today = valid_date(today)
    if on:
        on = valid_date(on)
    if between:
        between = (valid_date(between[0]), valid_date(between[1]))
    if not space_ids:
        return {"total": 0, "counts": dict.fromkeys(("open", "done", *WHEN), 0), "items": []}
    where = task_query(
        space_ids, status=status, when=when, today=today, on=on, tag=tag, q=q, space_id=space_id, between=between
    )
    moment = func.coalesce(Task.due, Task.scheduled)
    if status == "done":
        order = [Task.completed.desc(), File.path, Task.line]
    else:
        # Open ones first, by date, the undated last, on one day the higher priority first.
        order = [Task.status != OPEN, moment.is_(None), moment, Task.priority.desc(), File.path, Task.line]
    with SessionLocal() as db:
        total = db.scalar(select(func.count()).select_from(Task).where(where)) or 0
        rows = db.execute(
            select(Task, File.path, File.title).join(File, File.id == Task.file_id).where(where)
            .order_by(*order).offset(offset).limit(limit)
        ).all()
        # The chips: every count for the same spaces, tag and words, whatever the chosen status and time.
        base = task_query(
            space_ids, status="all", when=None, today=today, on=on, tag=tag, q=q, space_id=space_id, between=between
        )
        conditions = _when(today)
        is_open = Task.status == OPEN
        sums = [func.sum(case((is_open, 1), else_=0)), func.sum(case((~is_open, 1), else_=0))]
        sums += [func.sum(case((and_(is_open, conditions[key]), 1), else_=0)) for key in WHEN]
        counted = db.execute(select(*sums).where(base)).one()
    counts = dict(zip(("open", "done", *WHEN), (int(value or 0) for value in counted), strict=True))
    items = [
        {
            "id": task.id, "path": path, "title": title or paths.stem(path), "line": task.line, "raw": task.raw,
            "status": task.status, "text": task.text, "due": task.due, "scheduled": task.scheduled, "start": task.start,
            "completed": task.completed, "priority": task.priority, "recurrence": task.recurrence,
            "tags": task.tags.split() if task.tags else [],
        }
        for task, path, title in rows
    ]
    return {"total": total, "counts": counts, "items": items}


def _lines(data: bytes) -> list[tuple[bytes, bytes]]:
    """The lines of a file with their ends, so that joining them gives the file back byte for byte."""
    out: list[tuple[bytes, bytes]] = []
    position = 0
    for match in _LINE_END.finditer(data):
        out.append((data[position : match.start()], match.group(0)))
        position = match.end()
    out.append((data[position:], b""))
    return out


def toggle(rel: str, line: int, raw: str, *, done: bool, today: str, actor: Actor) -> dict[str, Any]:
    """Tick the task on ``line`` off (or open it again). ``raw`` is the line as the caller saw it; when the file
    changed since, the task is looked for by its text, and when it is not there exactly once, nothing is written."""
    today = valid_date(today)
    file, data = vault.read(rel)
    with SessionLocal() as db:
        lock = vault.lock_state(db, file.id)
        if lock is not None and lock.holder != actor.client:
            raise VaultError("locked", "somebody else is editing this note", 423, holder=lock.holder_name)
    bom = data.startswith(BOM)
    lines = _lines(data[len(BOM) :] if bom else data)

    def text_of(content: bytes) -> str | None:
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            return None

    index_of = line - 1 if 0 < line <= len(lines) and text_of(lines[line - 1][0]) == raw else None
    if index_of is None:
        matches = [number for number, (content, _end) in enumerate(lines) if text_of(content) == raw]
        if len(matches) != 1:
            raise VaultError("task_changed", "the task is no longer where it was", 409)
        index_of = matches[0]
    old = raw
    try:
        new = tasks.toggle_line(old, done, today)
    except ValueError as exc:
        raise VaultError("task_changed", "the line is no task", 409) from exc
    if new == old:
        return {"path": rel, "line": index_of + 1, "raw": old, "hash": index.digest(data), "conflict": None,
                "added": None}
    _content, end = lines[index_of]
    lines[index_of] = (new.encode("utf-8"), end)
    # A recurring task ticked off: its next occurrence goes above it, as the Tasks plugin writes it.
    was_open = tasks.parse_line(old, 0)
    following = tasks.next_occurrence(old, today) if done and was_open and was_open.status == OPEN else None
    if following is not None:
        ending = end or next((found for _part, found in lines if found), b"\n")
        lines.insert(index_of, (following.encode("utf-8"), ending))
        index_of += 1
    changed = (BOM if bom else b"") + b"".join(part + ending for part, ending in lines)
    saved = vault.save(rel, changed, base_hash=index.digest(data), actor=actor)
    return {
        "path": rel, "line": index_of + 1, "raw": new, "hash": index.digest(changed),
        "conflict": saved.conflict, "added": following,
    }


# --- The calendar --------------------------------------------------------------------------------------------------


def calendar(space_ids: set[int], month: str, *, today: str, space_id: int | None = None) -> dict[str, Any]:
    """For each day of a month: the daily notes (per space, as each space names its folder), and how many tasks
    are due or planned, open and done."""
    if not MONTH.match(month):
        raise VaultError("invalid_input", "not a month")
    first = date.fromisoformat(month + "-01")
    last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    wanted = {space_id} & space_ids if space_id is not None else space_ids
    days: dict[str, dict[str, Any]] = {}

    def day_of(key: str) -> dict[str, Any]:
        return days.setdefault(key, {"daily": [], "open": 0, "done": 0, "overdue": 0})

    if not wanted:
        return {"month": month, "days": days}
    with SessionLocal() as db:
        spaces = all_options(db, wanted)
        for space, name in db.execute(
            select(File.space_id, File.path).where(
                File.deleted_at.is_(None), File.is_note.is_(True), File.space_id.in_(wanted),
                File.name_key.like(f"{month}-__"),
            )
        ):
            _folder, opts = spaces[space]
            if is_daily(name, opts) and first.isoformat() <= paths.stem(name) <= last.isoformat():
                day_of(paths.stem(name))["daily"].append(name)
        today = valid_date(today)
        moment = func.coalesce(Task.due, Task.scheduled)
        for when, status, count in db.execute(
            select(moment, Task.status, func.count())
            .where(Task.space_id.in_(wanted), moment >= first.isoformat(), moment <= last.isoformat())
            .group_by(moment, Task.status)
        ):
            entry = day_of(when)
            if status == OPEN:
                entry["open"] += count
                if when < today:
                    entry["overdue"] += count
            else:
                entry["done"] += count
    for entry in days.values():
        entry["daily"].sort()
    return {"month": month, "days": days}
