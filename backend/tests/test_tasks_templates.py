"""Task lines as the Obsidian Tasks plugin writes them, and template placeholders as Obsidian's core plugin fills
them. Pure functions: every case is a line or a template and what comes out."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.services import mdparse, tasks, templates


def test_a_task_line_gives_status_dates_priority_recurrence_and_tags() -> None:
    line = "- [ ] Call the harbour ⏫ 🔁 every week 🛫 2026-09-20 ⏳ 2026-09-26 📅 2026-09-28 #errand/boat ^abc-1"
    task = tasks.parse_line(line, 7)
    assert task is not None
    assert task.line == 7 and task.status == tasks.OPEN and task.mark == " "
    assert (task.start, task.scheduled, task.due, task.completed) == ("2026-09-20", "2026-09-26", "2026-09-28", None)
    assert task.priority == 4
    assert task.recurrence == "every week"
    assert task.text == "Call the harbour #errand/boat"
    assert task.tags == ["errand/boat"]


@pytest.mark.parametrize(
    ("line", "status"),
    [
        ("- [x] done ✅ 2026-09-26", tasks.DONE_STATUS),
        ("- [X] done", tasks.DONE_STATUS),
        ("- [-] cancelled", tasks.CANCELLED_STATUS),
        ("- [/] in progress", tasks.OPEN),
        ("* [ ] star bullet", tasks.OPEN),
        ("1. [ ] numbered", tasks.OPEN),
        ("> - [ ] in a quote", tasks.OPEN),
        ("\t- [ ] indented", tasks.OPEN),
        ("- [ ]", tasks.OPEN),
    ],
)
def test_every_kind_of_task_line_is_read(line: str, status: str) -> None:
    task = tasks.parse_line(line, 1)
    assert task is not None and task.status == status


@pytest.mark.parametrize("line", ["- [] no status", "-[ ] no space", "text - [ ] later", "- [ ]x glued", "[ ] bare"])
def test_what_is_no_task_is_not_read_as_one(line: str) -> None:
    assert tasks.parse_line(line, 1) is None


def test_priorities_and_dates_with_the_variation_selector() -> None:
    assert tasks.parse_line("- [ ] a 🔺", 1).priority == 5  # type: ignore[union-attr]
    assert tasks.parse_line("- [ ] a 🔼", 1).priority == 3  # type: ignore[union-attr]
    assert tasks.parse_line("- [ ] a 🔽", 1).priority == 1  # type: ignore[union-attr]
    assert tasks.parse_line("- [ ] a ⏬", 1).priority == 0  # type: ignore[union-attr]
    assert tasks.parse_line("- [ ] a", 1).priority == tasks.NORMAL  # type: ignore[union-attr]
    task = tasks.parse_line("- [ ] a ⏳\ufe0f 2026-01-02 📅\ufe0f2026-01-03", 1)
    assert task is not None and (task.scheduled, task.due) == ("2026-01-02", "2026-01-03") and task.text == "a"


@pytest.mark.parametrize(
    ("before", "done", "after"),
    [
        ("- [ ] Buy ink", True, "- [x] Buy ink ✅ 2026-09-27"),
        ("- [ ] Buy ink 📅 2026-09-30", True, "- [x] Buy ink 📅 2026-09-30 ✅ 2026-09-27"),
        ("- [ ] Buy ink ^id-1", True, "- [x] Buy ink ✅ 2026-09-27 ^id-1"),
        ("  * [ ] Buy ink  ", True, "  * [x] Buy ink ✅ 2026-09-27"),
        ("- [ ]", True, "- [x] ✅ 2026-09-27"),
        ("- [x] Buy ink ✅ 2026-09-26", False, "- [ ] Buy ink"),
        ("- [x] Buy ink ✅ 2026-09-26 ^id-1", False, "- [ ] Buy ink ^id-1"),
        ("- [X] Buy ink", False, "- [ ] Buy ink"),
        ("> 3) [/] Buy ink", True, "> 3) [x] Buy ink ✅ 2026-09-27"),
    ],
)
def test_ticking_changes_the_status_and_the_done_date_and_nothing_else(before: str, done: bool, after: str) -> None:
    assert tasks.toggle_line(before, done, "2026-09-27") == after


def test_ticking_twice_keeps_the_first_done_date() -> None:
    once = tasks.toggle_line("- [ ] a", True, "2026-09-27")
    assert tasks.toggle_line(once, True, "2026-09-28") == "- [x] a ✅ 2026-09-27"


def test_ticking_a_line_that_is_no_task_fails() -> None:
    with pytest.raises(ValueError):
        tasks.toggle_line("just text", True, "2026-09-27")


def test_the_parser_finds_task_lines_outside_code_and_comments_with_their_numbers() -> None:
    text = (
        "---\ntags: [x]\n---\n"  # lines 1-3
        "- [ ] first\r\n"  # 4
        "```\n- [ ] in code\n```\n"  # 5-7
        "%% - [ ] in a comment %%\n"  # 8
        "text\n"  # 9
        "    - [x] indented deeper ✅ 2026-09-01\n"  # 10, code by indentation? no: a list continues here
        "1. [ ] numbered\n"  # 11
    )
    parsed = mdparse.parse(text)
    numbers = [number for number, _line in parsed.task_lines]
    assert 4 in numbers and 11 in numbers
    assert 5 not in numbers and 6 not in numbers and 8 not in numbers
    assert dict(parsed.task_lines)[4] == "- [ ] first"


WHEN = datetime(2026, 9, 7, 14, 5, 9, tzinfo=UTC)


@pytest.mark.parametrize(
    ("template", "language", "result"),
    [
        ("# {{title}}", "en", "# Plan"),
        ("{{date}} {{time}}", "en", "2026-09-07 14:05"),
        ("{{date:DD.MM.YYYY}}", "de", "07.09.2026"),
        ("{{date:dddd, D. MMMM YYYY}}", "de", "Montag, 7. September 2026"),
        ("{{date:dddd, MMMM Do}}", "en", "Monday, September 7th"),
        ("{{time:HH:mm:ss}} {{time:h A}}", "en", "14:05:09 2 PM"),
        ("{{date:[Week] ww, YY}}", "en", "Week 37, 26"),
        ("{{ DATE }} {{Title}}", "en", "2026-09-07 Plan"),
        ("{{unknown}} {{date:}}", "en", "{{unknown}} {{date:}}"),
    ],
)
def test_placeholders_are_filled_the_obsidian_way(template: str, language: str, result: str) -> None:
    assert templates.fill(template, title="Plan", when=WHEN, language=language) == result


def test_templater_code_is_never_run_and_stays_as_written() -> None:
    template = "<%* tR += tp.date.now() %>\n<% tp.file.title %> {{title}}"
    assert templates.fill(template, title="Plan", when=WHEN) == "<%* tR += tp.date.now() %>\n<% tp.file.title %> Plan"


@pytest.mark.parametrize(
    ("rule", "reference", "following"),
    [
        ("every day", "2026-09-27", "2026-09-28"),
        ("every 3 days", "2026-09-27", "2026-09-30"),
        ("every week", "2026-09-27", "2026-10-04"),
        ("every 2 weeks", "2026-09-27", "2026-10-11"),
        ("every month", "2026-01-31", "2026-02-28"),
        ("every 2 months", "2026-11-30", "2027-01-30"),
        ("every year", "2028-02-29", "2029-02-28"),
        ("every weekday", "2026-09-25", "2026-09-28"),
        ("every weekday", "2026-09-28", "2026-09-29"),
        ("Every week on Monday, Friday", "2026-09-28", "2026-10-02"),
        ("every week on friday and monday", "2026-10-02", "2026-10-05"),
        ("every 2 weeks on monday", "2026-09-28", "2026-10-12"),
        ("every month when done", "2026-09-27", "2026-10-27"),
    ],
)
def test_the_next_date_of_a_rule(rule: str, reference: str, following: str) -> None:
    from datetime import date

    assert tasks.next_date(rule, date.fromisoformat(reference)) == date.fromisoformat(following)


@pytest.mark.parametrize("rule", ["every blue moon", "every 0 days", "every month on the 3rd", "every week on funday"])
def test_a_rule_it_does_not_know_repeats_nothing(rule: str) -> None:
    from datetime import date

    assert tasks.next_date(rule, date(2026, 9, 27)) is None


def test_the_next_occurrence_moves_every_date_by_as_much_as_the_reference_moved() -> None:
    line = "- [ ] water 🔁 every week 🛫 2026-09-20 ⏳ 2026-09-25 📅 2026-09-27 ➕ 2026-09-01 ^w1"
    assert tasks.next_occurrence(line, "2026-09-27") == (
        "- [ ] water 🔁 every week 🛫 2026-09-27 ⏳ 2026-10-02 📅 2026-10-04 ➕ 2026-09-27")
    # "when done": from the day it was ticked off, not from the due date.
    late = "- [ ] water 🔁 every week when done 📅 2026-09-01"
    assert tasks.next_occurrence(late, "2026-09-27") == "- [ ] water 🔁 every week when done 📅 2026-10-04"
    # Only scheduled: that is the reference.
    assert tasks.next_occurrence("* [ ] a 🔁 every day ⏳ 2026-09-27", "2026-09-27") == "* [ ] a 🔁 every day ⏳ 2026-09-28"


@pytest.mark.parametrize(
    "line",
    ["- [ ] no rule 📅 2026-09-27", "- [ ] no date 🔁 every day", "- [ ] odd 🔁 every blue moon 📅 2026-09-27", "text"],
)
def test_no_next_occurrence_without_rule_date_or_known_rule(line: str) -> None:
    assert tasks.next_occurrence(line, "2026-09-27") is None


@pytest.mark.parametrize(
    ("day", "english", "german", "iso"),
    [
        # moment.js: English weeks start on Sunday and week 1 holds 1 January; German ones follow ISO (Monday, 4 January).
        ((2026, 1, 4), "02", "01", "1"),
        ((2025, 12, 28), "01", "52", "52"),
        ((2021, 1, 3), "02", "53", "53"),
        ((2026, 9, 7), "37", "37", "37"),
    ],
)
def test_week_numbers_as_moment_counts_them(day: tuple[int, int, int], english: str, german: str, iso: str) -> None:
    when = datetime(*day, 12, tzinfo=UTC)
    assert templates.format_moment(when, "ww", "en") == english
    assert templates.format_moment(when, "ww", "de") == german
    assert templates.format_moment(when, "W", "en") == iso


def test_a_recurring_task_with_an_impossible_date_is_only_ticked_off() -> None:
    assert tasks.next_occurrence("- [ ] x 🔁 every month 📅 2026-02-30", "2026-09-27") is None
    assert tasks.next_occurrence("- [ ] x 🔁 every month 📅 2026-02-01 ⏳ 2026-13-01", "2026-09-27") is None


def test_the_next_occurrence_is_created_today() -> None:
    line = "- [ ] a ➕ 2026-01-01 📅 2026-09-27 🔁 every week"
    assert tasks.next_occurrence(line, "2026-09-27") == "- [ ] a ➕ 2026-09-27 📅 2026-10-04 🔁 every week"


def test_quarter_epoch_and_offset_are_written_as_moment_writes_them() -> None:
    """Review before 1.0.0, P5.24: Q, X, x, Z stood in the note as written."""
    from datetime import timedelta, timezone

    from app.services.templates import format_moment

    when = datetime(2026, 10, 1, 6, 50, tzinfo=timezone(timedelta(hours=2)))
    assert format_moment(when, "Q/GGGG") == "4/2026"
    assert format_moment(when, "X") == str(int(when.timestamp()))
    assert format_moment(when, "x") == str(int(when.timestamp()) * 1000)
    assert format_moment(when, "Z ZZ") == "+02:00 +0200"
    assert format_moment(when.astimezone(timezone(timedelta(hours=-3, minutes=-30))), "Z") == "-03:30"
