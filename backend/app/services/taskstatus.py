"""What the character between a task's brackets means, space by space (Issue #14).

nexlore knows a few on its own: a space is open, ``x`` and ``X`` done, ``-`` cancelled, ``/`` in progress. A space can
say more in two ways, and the later one wins for a character:

1. **The Tasks plugin's own settings**, when the space is an Obsidian vault that uses the plugin with custom statuses:
   ``.obsidian/plugins/obsidian-tasks-plugin/data.json``, ``statusSettings.coreStatuses`` and ``customStatuses``,
   each with ``symbol``, ``name`` and ``type``. Only read, never written, read again when the file changes.
2. **A list the space's managers keep in nexlore** (``Space.options["task_statuses"]``), for spaces without Obsidian
   or to set a character differently.

A kind is one of the plugin's types: to do, in progress, on hold (all three open), done, cancelled, and not a task
(the line is left out of every list and count). A character nobody names stays open, as in the plugin.

The ``tasks.status`` column keeps what nexlore's own characters say. Whatever a space adds is applied when the tasks
are asked for (``Meaning``): a changed setting holds at once, without reading a single note again.
"""

from __future__ import annotations

import json
import os
import unicodedata
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, false, or_, select, true
from sqlalchemy.orm import Session

from ..models import Space, Task
from . import paths
from . import tasks as tasks_service

TODO, IN_PROGRESS, ON_HOLD = "todo", "in_progress", "on_hold"
DONE, CANCELLED, NON_TASK = "done", "cancelled", "non_task"
KINDS = (TODO, IN_PROGRESS, ON_HOLD, DONE, CANCELLED, NON_TASK)
#: What each kind counts as in the overview. ``none``: no task at all.
NOT_A_TASK = "none"
STATUS_OF = {
    TODO: tasks_service.OPEN, IN_PROGRESS: tasks_service.OPEN, ON_HOLD: tasks_service.OPEN,
    DONE: tasks_service.DONE_STATUS, CANCELLED: tasks_service.CANCELLED_STATUS, NON_TASK: NOT_A_TASK,
}
#: The plugin's types, as its settings file writes them. ``EMPTY`` is its own placeholder line: left as to do.
PLUGIN_TYPES = {
    "TODO": TODO, "IN_PROGRESS": IN_PROGRESS, "ON_HOLD": ON_HOLD, "DONE": DONE, "CANCELLED": CANCELLED,
    "NON_TASK": NON_TASK, "EMPTY": TODO,
}

BUILT_IN = "built_in"
PLUGIN = "plugin"
OWN = "own"

PLUGIN_FILE = (".obsidian", "plugins", "obsidian-tasks-plugin", "data.json")
#: The plugin's settings file is small; a larger one is not read.
MAX_PLUGIN_BYTES = 2 * 1024 * 1024
MAX_STATUSES = 60
MAX_NAME = 60


@dataclass(frozen=True, slots=True)
class Status:
    mark: str
    kind: str
    #: What the plugin or the managers call it; empty for nexlore's own (the app names those in its language).
    name: str = ""
    source: str = BUILT_IN

    @property
    def status(self) -> str:
        return STATUS_OF[self.kind]

    def out(self) -> dict[str, str]:
        return {"mark": self.mark, "kind": self.kind, "name": self.name, "source": self.source}


DEFAULTS: dict[str, Status] = {
    " ": Status(" ", TODO), "x": Status("x", DONE), "X": Status("X", DONE), "-": Status("-", CANCELLED),
    "/": Status("/", IN_PROGRESS),
}
_UNNAMED = Status(" ", TODO)


def mark_ok(mark: object) -> bool:
    """One character that can stand between brackets: no line break, no control character, no bracket."""
    return (
        isinstance(mark, str) and len(mark) == 1 and mark not in "[]"
        and unicodedata.category(mark)[0] not in ("C", "Z") or mark == " "
    )


def _name(value: object) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = "".join(char for char in value if unicodedata.category(char)[0] != "C")
    return " ".join(cleaned.split())[:MAX_NAME]


# --- The Tasks plugin's settings -------------------------------------------------------------------------------------

#: Read once per state of the file (path, size, time, file number).
_read: dict[str, tuple[tuple[int, int, int], tuple[list[Status], bool]]] = {}


def forget() -> None:
    _read.clear()


def plugin_statuses(space_folder: str) -> tuple[list[Status], bool] | None:
    """The statuses the space's Tasks plugin settings name, and whether the file could not be read in full. None when
    the space has no such file. Links are not followed, a file too large or broken gives nothing."""
    try:
        path = paths.resolve("/".join((space_folder, *PLUGIN_FILE)))
        found = os.stat(path)
    except (paths.PathError, OSError):
        return None
    if not os.path.isfile(path):
        return None
    key = str(path)
    stamp = (found.st_size, found.st_mtime_ns, found.st_ino)
    cached = _read.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    result = _parse_plugin(path, found.st_size)
    if len(_read) > 1000:
        _read.clear()
    _read[key] = (stamp, result)
    return result


def _parse_plugin(path: os.PathLike[str] | str, size: int) -> tuple[list[Status], bool]:
    if size > MAX_PLUGIN_BYTES:
        return [], True
    try:
        with open(path, "rb") as handle:
            data = json.loads(handle.read(MAX_PLUGIN_BYTES + 1).decode("utf-8-sig"))
    except (OSError, ValueError, RecursionError):
        return [], True
    settings = data.get("statusSettings") if isinstance(data, dict) else None
    if not isinstance(settings, dict):
        return [], False
    found: dict[str, Status] = {}
    broken = False
    for group in ("coreStatuses", "customStatuses"):
        entries = settings.get(group)
        if entries is None:
            continue
        if not isinstance(entries, list):
            broken = True
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                broken = True
                continue
            mark, kind = entry.get("symbol"), PLUGIN_TYPES.get(str(entry.get("type", "")).upper())
            if not mark_ok(mark) or kind is None:
                # An empty row of the plugin's own settings (every field blank) is no mistake.
                broken = broken or bool(mark or entry.get("type"))
                continue
            # The plugin takes the first status with a character, so does nexlore.
            if mark not in found and len(found) < MAX_STATUSES:
                found[mark] = Status(mark, kind, _name(entry.get("name")), PLUGIN)
    return list(found.values()), broken


# --- The managers' own list ----------------------------------------------------------------------------------------


def own_statuses(space: Space) -> list[Status]:
    stored = space.options.get("task_statuses") if isinstance(space.options, dict) else None
    if not isinstance(stored, list):
        return []
    out: dict[str, Status] = {}
    for entry in stored:
        if isinstance(entry, dict) and mark_ok(entry.get("mark")) and entry.get("kind") in KINDS:
            out.setdefault(entry["mark"], Status(entry["mark"], entry["kind"], _name(entry.get("name")), OWN))
    return list(out.values())


class StatusError(ValueError):
    pass


def clean_own(entries: list[dict[str, Any]]) -> list[dict[str, str]]:
    """The list as it is stored: each character once, a known kind, a short name."""
    if len(entries) > MAX_STATUSES:
        raise StatusError("too many statuses")
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in entries:
        mark, kind = entry.get("mark"), entry.get("kind")
        if not mark_ok(mark):
            raise StatusError("a status is one character, not a bracket or a line break")
        if kind not in KINDS:
            raise StatusError("unknown kind of status")
        if mark in seen:
            raise StatusError("a character stands for one status only")
        seen.add(mark)
        out.append({"mark": mark, "kind": kind, "name": _name(entry.get("name"))})
    return out


# --- Together ------------------------------------------------------------------------------------------------------


def statuses_of(space: Space) -> dict[str, Status]:
    """Every character the space names, nexlore's own first, then the plugin's, then the managers'. A plugin entry
    that says what nexlore says anyway stays nexlore's (so the app names it in the reader's language)."""
    merged = dict(DEFAULTS)
    read = plugin_statuses(space.folder)
    for status in read[0] if read else []:
        known = DEFAULTS.get(status.mark)
        if known is None or known.kind != status.kind:
            merged[status.mark] = status
    for status in own_statuses(space):
        merged[status.mark] = status
    return merged


def overview(space: Space) -> dict[str, Any]:
    read = plugin_statuses(space.folder)
    return {
        "built_in": [status.out() for status in DEFAULTS.values()],
        "plugin": [status.out() for status in read[0]] if read is not None else None,
        "plugin_unreadable": bool(read and read[1]),
        "own": [status.out() for status in own_statuses(space)],
        "statuses": [status.out() for status in statuses_of(space).values()],
    }


def _differs(table: dict[str, Status]) -> bool:
    """Whether the space reads any character otherwise than the ``tasks.status`` column already says."""
    for mark, status in table.items():
        if status.status != tasks_service.status_of(mark):
            return True
    return False


class Meaning:
    """The characters of some spaces, for questions about their tasks: as SQL, and for a single row."""

    def __init__(self, tables: dict[int, dict[str, Status]]) -> None:
        self.tables = tables
        #: Spaces that read the characters as the stored column does: the column answers for them (and its index).
        self.plain = {space for space, table in tables.items() if not _differs(table)}
        groups: dict[tuple[tuple[str, str], ...], list[int]] = {}
        for space, table in tables.items():
            if space not in self.plain:
                signature = tuple(sorted((mark, status.status) for mark, status in table.items()))
                groups.setdefault(signature, []).append(space)
        #: The other spaces, grouped by what their characters mean: for each, the characters of each status.
        self.groups = [
            (ids, {status: {mark for mark, said in signature if said == status} for status in set(STATUS_OF.values())})
            for signature, ids in groups.items()
        ]

    def table(self, space_id: int) -> dict[str, Status]:
        return self.tables.get(space_id, DEFAULTS)

    def of(self, space_id: int, mark: str) -> Status:
        table = self.table(space_id)
        found = table.get(mark)
        if found is not None:
            return found
        return Status(mark, TODO, "", BUILT_IN) if mark != " " else _UNNAMED

    def status(self, space_id: int, mark: str) -> str:
        return self.of(space_id, mark).status

    def where(self, status: str) -> Any:
        """The rows that count as ``status`` (open, done, cancelled, or ``task``: any but no task)."""
        if not self.groups:
            return Task.status == status if status != "task" else true()
        parts = []
        if self.plain:
            if status == "task":
                parts.append(Task.space_id.in_(self.plain))
            else:
                parts.append(and_(Task.space_id.in_(self.plain), Task.status == status))
        for ids, marks in self.groups:
            inside = Task.space_id.in_(ids)
            if status == "task":
                parts.append(and_(inside, Task.mark.not_in(marks[NOT_A_TASK]) if marks[NOT_A_TASK] else inside))
            elif status == tasks_service.OPEN:
                # Open is every character the space does not give another meaning: unknown ones too.
                closed = set().union(*(found for said, found in marks.items() if said != tasks_service.OPEN))
                parts.append(and_(inside, Task.mark.not_in(closed)) if closed else inside)
            else:
                parts.append(and_(inside, Task.mark.in_(marks[status])) if marks[status] else false())
        return or_(*parts)


def meaning(db: Session, space_ids: set[int] | list[int]) -> Meaning:
    spaces = db.scalars(select(Space).where(Space.id.in_(set(space_ids)))).all() if space_ids else []
    return Meaning({space.id: statuses_of(space) for space in spaces})
