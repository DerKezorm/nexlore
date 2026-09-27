"""Templates the way Obsidian's core plugin fills them: ``{{title}}``, ``{{date}}``, ``{{time}}``, and a date or time
in a format of one's own, ``{{date:DD.MM.YYYY}}`` or ``{{time:HH:mm:ss}}`` (moment.js tokens, the common ones).

Nothing else is ever run. Templater's ``<% … %>`` stays in the note as it was written: it is code, and nexlore does
not execute code from notes. The same goes for anything that looks like a placeholder but is not one of these.
"""

from __future__ import annotations

import re
from datetime import date, datetime

PLACEHOLDER = re.compile(r"\{\{\s*(title|date|time)\s*(?::([^{}\r\n]{1,64}))?\s*\}\}", re.IGNORECASE)
DATE_FORMAT = "YYYY-MM-DD"
TIME_FORMAT = "HH:mm"

MONTHS = {
    "en": ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
           "November", "December"),
    "de": ("Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
           "November", "Dezember"),
}
DAYS = {
    "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"),
    "de": ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"),
}
#: Longest first, so that ``MMMM`` is not read as two ``MM``.
_TOKENS = re.compile(r"\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|DDDD|DD|Do|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|WW|W|ww|w|E")
#: How moment counts the weeks of a locale: the first day of the week (0 Sunday) and the January day that always lies
#: in week 1, as ``7 + dow - doy``. English: Sunday, 1 January. German: Monday, 4 January, which is the ISO rule.
_WEEKS = {"en": (0, 6), "de": (1, 4)}
_ISO = (1, 4)


def _first_week_offset(year: int, dow: int, doy: int) -> int:
    fwd = 7 + dow - doy
    weekday = (date(year, 1, fwd).weekday() + 1) % 7  # Sunday 0, as JavaScript counts
    return -((7 + weekday - dow) % 7) + fwd - 1


def _weeks_in_year(year: int, dow: int, doy: int) -> int:
    days = 366 if (year % 4 == 0 and year % 100 != 0) or year % 400 == 0 else 365
    return (days - _first_week_offset(year, dow, doy) + _first_week_offset(year + 1, dow, doy)) // 7


def week_of_year(when: datetime, dow: int, doy: int) -> int:
    """The week number the way moment.js works it out (``weekOfYear``)."""
    offset = _first_week_offset(when.year, dow, doy)
    week = (when.timetuple().tm_yday - offset - 1) // 7 + 1
    if week < 1:
        return week + _weeks_in_year(when.year - 1, dow, doy)
    if week > _weeks_in_year(when.year, dow, doy):
        return week - _weeks_in_year(when.year, dow, doy)
    return week


def format_moment(when: datetime, pattern: str, language: str = "en") -> str:
    """``when`` in a moment.js format. Text in ``[brackets]`` is kept as written."""
    months = MONTHS.get(language, MONTHS["en"])
    days = DAYS.get(language, DAYS["en"])
    week = week_of_year(when, *_WEEKS.get(language, _WEEKS["en"]))
    iso_week = week_of_year(when, *_ISO)

    def one(match: re.Match[str]) -> str:
        token = match.group(0)
        if token.startswith("["):
            return token[1:-1]
        hour12 = when.hour % 12 or 12
        values = {
            "YYYY": f"{when.year:04d}", "YY": f"{when.year % 100:02d}",
            "MMMM": months[when.month - 1], "MMM": months[when.month - 1][:3], "MM": f"{when.month:02d}",
            "M": str(when.month), "DDDD": f"{when.timetuple().tm_yday:03d}", "DD": f"{when.day:02d}",
            "Do": f"{when.day}." if language == "de" else _ordinal(when.day), "D": str(when.day),
            "dddd": days[when.weekday()], "ddd": days[when.weekday()][:3], "dd": days[when.weekday()][:2],
            "d": str((when.weekday() + 1) % 7), "E": str(when.weekday() + 1),
            "HH": f"{when.hour:02d}", "H": str(when.hour), "hh": f"{hour12:02d}", "h": str(hour12),
            "mm": f"{when.minute:02d}", "m": str(when.minute), "ss": f"{when.second:02d}", "s": str(when.second),
            "A": "AM" if when.hour < 12 else "PM", "a": "am" if when.hour < 12 else "pm",
            "ww": f"{week:02d}", "w": str(week), "WW": f"{iso_week:02d}", "W": str(iso_week),
        }
        return values[token]

    return _TOKENS.sub(one, pattern)


def _ordinal(day: int) -> str:
    suffix = "th" if 11 <= day % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{day}{suffix}"


def fill(template: str, *, title: str, when: datetime, language: str = "en") -> str:
    """The template with its placeholders filled in."""

    def one(match: re.Match[str]) -> str:
        name = match.group(1).lower()
        pattern = match.group(2)
        if name == "title":
            return title
        default = DATE_FORMAT if name == "date" else TIME_FORMAT
        return format_moment(when, pattern.strip() if pattern else default, language)

    return PLACEHOLDER.sub(one, template)
