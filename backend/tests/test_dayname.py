"""How a space names its daily notes (review before 1.0.0, P5.22)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.models import Account
from app.services import dayname

from .test_pruefgang import _garden


@pytest.mark.parametrize(
    ("pattern", "name"),
    [
        ("", "2026-10-02"),
        ("YYYY-MM-DD", "2026-10-02"),
        ("DD.MM.YYYY", "02.10.2026"),
        ("D.M.YY", "2.10.26"),
        ("YYYY/MM/YYYY-MM-DD", "2026/10/2026-10-02"),
        ("[Day] YYYYMMDD", "Day 20261002"),
    ],
)
def test_a_pattern_names_a_day_and_reads_the_name_back(pattern: str, name: str) -> None:
    assert dayname.name(pattern, "2026-10-02") == name
    assert dayname.day_of(pattern, name) == "2026-10-02"


def test_a_name_that_is_no_day_of_the_pattern_is_none() -> None:
    assert dayname.day_of("DD.MM.YYYY", "2026-10-02") is None
    assert dayname.day_of("DD.MM.YYYY", "31.02.2026") is None
    assert dayname.day_of("YYYY-MM-DD", "Shopping list") is None
    # A part named twice says the same both times.
    assert dayname.day_of("YYYY/MM/YYYY-MM-DD", "2026/11/2026-10-02") is None


@pytest.mark.parametrize(
    "pattern",
    ["dddd YYYY-MM-DD", "DD MMMM YYYY", "DDD YYYY-MM", "MMMM YYYY", "YYYY-MM", "/YYYY-MM-DD", "YYYY//MM-DD", "Q YYYY-MM-DD", "x" * 61],
)
def test_a_pattern_that_cannot_name_every_day_the_same_way_is_refused(pattern: str) -> None:
    with pytest.raises(dayname.FormatError):
        dayname.check(pattern)


def test_an_empty_pattern_is_the_default() -> None:
    assert dayname.check("  ") == "YYYY-MM-DD"
    assert dayname.check(" DD.MM.YYYY ") == "DD.MM.YYYY"


# --- In a space ----------------------------------------------------------------------------------------------------


def test_a_space_names_its_daily_notes_its_own_way_and_the_calendar_finds_them(
    client: TestClient, account: Account, vault: Path
) -> None:
    _garden(vault, {"Plan.md": b"x\n"})
    refused = client.put("/api/spaces/Garden/options", json={"daily_format": "DD MMMM YYYY"})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "bad_day_format"
    assert client.put("/api/spaces/Garden/options", json={"daily_format": "DD.MM.YYYY"}).status_code == 200
    made = client.post("/api/daily", json={"space": "Garden", "date": "2026-11-15"})
    assert made.status_code == 200, made.text
    assert made.json()["path"] == "Garden/Daily/15.11.2026.md"
    assert client.post("/api/daily", json={"space": "Garden", "date": "2026-11-15"}).json()["created"] is False
    month = client.get("/api/calendar", params={"month": "2026-11", "today": "2026-11-01", "space": "Garden"}).json()
    assert month["days"]["2026-11-15"]["daily"] == ["Garden/Daily/15.11.2026.md"]
    assert [space["daily_format"] for space in client.get("/api/spaces").json() if space["name"] == "Garden"] == [
        "DD.MM.YYYY"
    ]


def test_daily_notes_in_another_folder_and_pattern_are_offered(client: TestClient, account: Account, vault: Path) -> None:
    _garden(vault, {f"Journal/{day:02d}.09.2026.md": b"x\n" for day in (1, 2, 3, 4)})
    guess = client.get("/api/spaces/Garden/daily-guess")
    assert guess.status_code == 200
    assert guess.json() == {"daily_folder": "Journal", "daily_format": "DD.MM.YYYY", "count": 4}
    assert client.put("/api/spaces/Garden/options", json=guess.json()).status_code == 200
    # Taken over, nothing is missed any more.
    assert client.get("/api/spaces/Garden/daily-guess").json() is None
    month = client.get("/api/calendar", params={"month": "2026-09", "today": "2026-09-01", "space": "Garden"}).json()
    assert sorted(day for day, entry in month["days"].items() if entry["daily"]) == [
        "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"
    ]
