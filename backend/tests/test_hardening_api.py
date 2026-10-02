"""Security review before 1.0.0: the API for programs refuses what it cannot keep, with a code and never a 500."""

from __future__ import annotations

import pytest

from .test_api_tokens import World, api, code, world  # noqa: F401  (the fixture is used by name)

EMOJI = "\U0001f600"  # four bytes in UTF-8, one character


@pytest.mark.parametrize("day", ["2026-13-40", "2026-02-30", "0000-00-00", "2026-00-10"])
def test_an_impossible_date_is_a_400_on_the_dashboard_and_the_tasks(world: World, day: str) -> None:  # noqa: F811
    token = world.token("read")
    for url in ("/api/v1/dashboard", "/api/v1/tasks"):
        assert code(api(token, "GET", url, params={"today": day})) == (400, "bad_date"), url


def test_five_megabytes_are_counted_in_bytes_on_every_way_in(world: World) -> None:  # noqa: F811
    token = world.token("write")
    big = EMOJI * 1_400_000  # 1.4 million characters, 5.6 MB
    made = api(token, "POST", "/api/v1/notes", json={"folder": "Garden", "title": "Big", "content": big})
    assert code(made) == (413, "too_large")
    small = api(token, "POST", "/api/v1/notes", json={"folder": "Garden", "title": "Small", "content": "x"})
    assert small.status_code == 201
    path = small.json()["path"]
    grown = api(token, "POST", "/api/v1/note/append", json={"path": path, "text": big})
    assert code(grown) == (413, "too_large")
    assert (world.vault / "Garden" / "Small.md").stat().st_size < 1000


def test_a_note_just_under_five_megabytes_is_still_written(world: World) -> None:  # noqa: F811
    token = world.token("write")
    content = "x" * (5 * 1024 * 1024 - 10)
    made = api(token, "POST", "/api/v1/notes", json={"folder": "Garden", "title": "Large", "content": content})
    assert made.status_code == 201, made.text
