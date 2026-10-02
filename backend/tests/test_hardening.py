"""The security review before 1.0.0 with nexlore on the internet in mind: each finding as a test that failed before."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.models import Account
from app.services import bases, mdparse, prepare

# --- What one note can do to the server -----------------------------------------------------------------------------


def test_many_templater_openings_without_an_end_take_linear_time() -> None:
    # Before: every "<%" looked for its "%>" to the end of the note; 40 KB took 15 s under the index lock.
    started = time.perf_counter()
    analysed = prepare.analyse("x.md", ("<%" * 100_000).encode())
    assert time.perf_counter() - started < 2
    assert not (analysed.features or {}).get("templater")


@pytest.mark.parametrize(("text", "count"), [
    ("<% tp.date.now() %>", 1),
    ("<%* tR += 'x' -%> and <%_ x _%>", 2),
    ("<%%>", 1),
    ("<%> x %>", 1),
    ("<% a %> <% b", 1),
    ("%> <% a %>", 1),
    ("no code", 0),
])
def test_templater_blocks_are_counted_as_before(text: str, count: int) -> None:
    assert mdparse.parse(text).features.get("templater", 0) == count


ALIAS_BOMB = "---\na0: &a0 [x, x, x, x, x, x, x, x, x]\n" + "".join(
    f"a{n}: &a{n} [" + ", ".join([f"*a{n - 1}"] * 9) + "]\n" for n in range(1, 9)
) + "---\nText\n"


def test_yaml_aliases_that_unfold_to_millions_are_a_front_matter_error() -> None:
    started = time.perf_counter()
    analysed = prepare.analyse("x.md", ALIAS_BOMB.encode())
    assert time.perf_counter() - started < 2
    assert analysed.front is None
    assert (analysed.features or {}).get("front_matter_errors") == 1


def test_a_yaml_alias_that_points_at_itself_is_a_front_matter_error() -> None:
    parsed = mdparse.parse("---\nloop: &me [*me]\n---\nText\n")
    assert parsed.front is None
    assert parsed.front_error


def test_front_matter_nested_deeper_than_the_limit_is_an_error_but_ordinary_aliases_still_work() -> None:
    deep = "---\nv: " + "[" * 40 + "]" * 40 + "\n---\n"
    assert mdparse.parse(deep).front_error
    plain = mdparse.parse("---\nbase: &b [one, two]\nalso: *b\ntags: [a]\n---\n")
    assert plain.front == {"base": ["one", "two"], "also": ["one", "two"], "tags": ["a"]}


def test_a_view_whose_yaml_unfolds_too_far_is_refused() -> None:
    with pytest.raises(bases.BaseError):
        bases.read(ALIAS_BOMB.split("---\n")[1])


def test_saving_an_alias_bomb_answers_and_the_note_stays_readable(client: TestClient, account: Account) -> None:
    client.post("/api/spaces", json={"name": "Bomb"})
    started = time.perf_counter()
    made = client.post("/api/notes", json={"folder": "Bomb", "title": "Laughs", "content": ALIAS_BOMB})
    assert made.status_code == 201
    assert time.perf_counter() - started < 5
    read = client.get("/api/note", params={"path": "Bomb/Laughs.md"})
    assert read.status_code == 200


@pytest.mark.parametrize("line", ["# a" + " " * 200_000 + "b", "# a" + " #" * 100_000 + "b"], ids=["blanks", "hashes"])
def test_a_heading_line_full_of_blanks_takes_linear_time(line: str) -> None:
    # Before: 8,000 characters took 0.8 s, growing with the square of the line.
    started = time.perf_counter()
    mdparse.parse(line)
    assert time.perf_counter() - started < 2


@pytest.mark.parametrize(("line", "words"), [
    ("# Title", "Title"), ("## Title ##", "Title"), ("# Title#", "Title#"), ("# C# and F#", "C# and F#"),
    ("# a  #b", "a  #b"), ("   ### Three   ", "Three"), ("# Tabs\t#\t", "Tabs"), ("# ###", ""),
])
def test_headings_read_as_commonmark_reads_them(line: str, words: str) -> None:
    assert mdparse.parse(line).headings == [(len(line.strip().split()[0]), words)]


def test_a_front_matter_list_item_full_of_blanks_takes_linear_time() -> None:
    from app.services import tagrename

    started = time.perf_counter()
    assert tagrename._item("- plans" + " " * 200_000) == ("- ", "plans", " " * 200_000)
    assert time.perf_counter() - started < 1
