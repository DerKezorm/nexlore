"""Tasks as the Obsidian Tasks plugin writes them, one line each.

    - [ ] Call the harbour master ⏫ 🔁 every week 🛫 2026-09-20 ⏳ 2026-09-26 📅 2026-09-28 #errand ^abc123
    - [x] Buy ink ✅ 2026-09-26

The status sits between the brackets: a space is open, ``x`` done, ``-`` cancelled; anything else (``/`` in progress,
``>`` moved, the plugin's own) counts as open. The fields are emoji followed by a date, the priority an emoji of its
own. What stays is the description, with its tags.

Ticking a task off changes that one line and nothing else: the status, and a ``✅`` date added (or taken away) the
way the plugin does it. Everything else in the line stays byte for byte, the line ending too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta

#: A list item with a checkbox, in a quote or not, bullet or number. Group 1 is everything up to the status,
#: group 2 the status, group 3 the rest of the line.
LINE = re.compile(r"^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)(.)(\](?:[ \t]+|$))(.*)$")
_VS = "\ufe0f?"  # the variation selector some keyboards add after an emoji
_DATE = r"(\d{4}-\d{2}-\d{2})"
DUE = re.compile("(?:📅|📆|🗓)" + _VS + r"[ \t]*" + _DATE)
SCHEDULED = re.compile("⏳" + _VS + r"[ \t]*" + _DATE)
START = re.compile("🛫" + _VS + r"[ \t]*" + _DATE)
DONE = re.compile("✅" + _VS + r"[ \t]*" + _DATE)
CREATED = re.compile("➕" + _VS + r"[ \t]*" + _DATE)
CANCELLED = re.compile("❌" + _VS + r"[ \t]*" + _DATE)
RECURRENCE = re.compile("🔁" + _VS + r"[ \t]*([^📅📆🗓⏳🛫✅➕❌⏫🔼🔽🔺⏬#^]*)")
PRIORITIES = {"🔺": 5, "⏫": 4, "🔼": 3, "🔽": 1, "⏬": 0}
NORMAL = 2
PRIORITY = re.compile("(" + "|".join(PRIORITIES) + ")" + _VS)
BLOCK_ID = re.compile(r"[ \t]+\^[A-Za-z0-9-]+[ \t]*$")
TAG = re.compile(r"(?:(?<=\s)|^)#([\w/-]+)")
#: A done date as the plugin appends it: one space before the emoji.
_DONE_APPENDED = re.compile(r"[ \t]*✅" + _VS + r"[ \t]*\d{4}-\d{2}-\d{2}")

OPEN = "open"
DONE_STATUS = "done"
CANCELLED_STATUS = "cancelled"

MAX_TEXT = 1000


@dataclass(slots=True)
class Task:
    line: int
    status: str
    mark: str
    text: str
    due: str | None = None
    scheduled: str | None = None
    start: str | None = None
    completed: str | None = None
    priority: int = NORMAL
    recurrence: str | None = None
    tags: list[str] = field(default_factory=list)
    #: The line as written, without its end.
    raw: str = ""


def status_of(mark: str) -> str:
    if mark in "xX":
        return DONE_STATUS
    if mark == "-":
        return CANCELLED_STATUS
    return OPEN


def _date(pattern: re.Pattern[str], rest: str) -> str | None:
    found = pattern.search(rest)
    return found.group(1) if found else None


def parse_line(line: str, number: int) -> Task | None:
    """The task on one line (without its line ending), or None when the line is no task."""
    match = LINE.match(line)
    if not match:
        return None
    mark, rest = match.group(2), match.group(4)
    task = Task(line=number, status=status_of(mark), mark=mark, text="", raw=line)
    task.due = _date(DUE, rest)
    task.scheduled = _date(SCHEDULED, rest)
    task.start = _date(START, rest)
    task.completed = _date(DONE, rest)
    recurrence = RECURRENCE.search(rest)
    if recurrence and recurrence.group(1).strip():
        task.recurrence = recurrence.group(1).strip()[:200]
    priority = PRIORITY.search(rest)
    if priority:
        task.priority = PRIORITIES[priority.group(1)]
    text = rest
    for pattern in (DUE, SCHEDULED, START, DONE, CREATED, CANCELLED, RECURRENCE, PRIORITY):
        text = pattern.sub(" ", text)
    text = BLOCK_ID.sub("", text)
    text = re.sub(r"[ \t]+", " ", text).strip()
    task.text = text[:MAX_TEXT]
    seen: set[str] = set()
    for found in TAG.finditer(text):
        tag = found.group(1).rstrip("/")
        if tag and not tag.replace("/", "").isdigit() and tag.casefold() not in seen:
            seen.add(tag.casefold())
            task.tags.append(tag)
    return task


_WEEKDAYS = {
    name: number
    for number, names in enumerate((
        ("monday", "mon"), ("tuesday", "tue"), ("wednesday", "wed"), ("thursday", "thu"), ("friday", "fri"),
        ("saturday", "sat"), ("sunday", "sun"),
    ))
    for name in names
}
_EVERY = re.compile(r"^every(?:\s+(\d{1,4}))?\s+(day|week|month|year)s?(?:\s+on\s+(.+?))?$")


def _add_months(day: date, months: int) -> date:
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))


def next_date(rule: str, reference: date) -> date | None:
    """The next date after ``reference`` by a rule as the Tasks plugin writes it, the common ones: ``every day``,
    ``every 3 weeks``, ``every month``, ``every year``, ``every weekday``, ``every week on Monday, Friday``.
    None for a rule it does not know: then nothing is repeated, the task is only ticked off."""
    rule = re.sub(r"\s+", " ", rule.strip().lower())
    rule = re.sub(r"\s*when done$", "", rule)
    if rule == "every weekday":
        step = reference + timedelta(days=1)
        while step.weekday() >= 5:
            step += timedelta(days=1)
        return step
    match = _EVERY.match(rule)
    if not match:
        return None
    count = int(match.group(1) or 1)
    unit = match.group(2)
    if count < 1:
        return None
    if unit == "week" and match.group(3):
        days = set()
        for part in re.split(r"\s*(?:,|and)\s*", match.group(3)):
            if part not in _WEEKDAYS:
                return None
            days.add(_WEEKDAYS[part])
        step = reference + timedelta(days=1)
        monday = reference - timedelta(days=reference.weekday())
        # The next of those weekdays; with "every 2 weeks on …" the week after that pattern repeats.
        for _ in range(7 * count + 7):
            weeks_apart = ((step - timedelta(days=step.weekday())) - monday).days // 7
            if step.weekday() in days and (weeks_apart % count == 0):
                return step
            step += timedelta(days=1)
        return None
    if match.group(3):
        return None
    if unit == "day":
        return reference + timedelta(days=count)
    if unit == "week":
        return reference + timedelta(weeks=count)
    if unit == "month":
        return _add_months(reference, count)
    return _add_months(reference, 12 * count)


def next_occurrence(line: str, today: str) -> str | None:
    """The line of the next occurrence of a recurring task, as the Tasks plugin writes it above the one ticked off:
    open, without a done date, every date moved by as much as the reference date moved (due, else scheduled, else
    start; with "when done", from today). None when the task does not recur, has no date, or its rule is unknown."""
    task = parse_line(line, 0)
    if task is None or not task.recurrence:
        return None
    reference_text = task.due or task.scheduled or task.start
    if reference_text is None:
        return None
    when_done = task.recurrence.strip().lower().endswith("when done")
    reference = date.fromisoformat(reference_text)
    base = date.fromisoformat(today) if when_done else reference
    following = next_date(task.recurrence, base)
    if following is None:
        return None
    shift = following - reference
    match = LINE.match(line)
    assert match is not None
    rest = _DONE_APPENDED.sub("", match.group(4), count=1)
    rest = CANCELLED.sub("", rest)

    def moved(found: re.Match[str]) -> str:
        old = found.group(1)
        return found.group(0).replace(old, (date.fromisoformat(old) + shift).isoformat())

    for pattern in (DUE, SCHEDULED, START):
        rest = pattern.sub(moved, rest)
    rest = re.sub(r"[ \t]+\^[A-Za-z0-9-]+[ \t]*$", "", rest)  # a block id belongs to the line it was on
    return f"{match.group(1)} {match.group(3)}{rest}"


def toggle_line(line: str, done: bool, today: str) -> str:
    """``line`` ticked off (``done``) or opened again. Ticked: status ``x`` and ``✅ today`` at the end (before a
    block id), as the plugin writes it. Opened: status a space and the done date gone. The rest stays as it was."""
    match = LINE.match(line)
    if not match:
        raise ValueError("not a task")
    head, _mark, close, rest = match.group(1), match.group(2), match.group(3), match.group(4)
    if done:
        if not DONE.search(rest):
            block = BLOCK_ID.search(rest)
            stripped = rest.rstrip(" \t")
            if block:
                body = rest[: block.start()].rstrip(" \t")
                rest = f"{body} ✅ {today}{rest[block.start():]}" if body else f"✅ {today}{rest[block.start():]}"
            elif stripped:
                rest = f"{stripped} ✅ {today}"
            else:
                rest = f"✅ {today}" if close != "]" else f" ✅ {today}"
        return f"{head}x{close}{rest}"
    rest = _DONE_APPENDED.sub("", rest, count=1)
    return f"{head} {close}{rest}"
