"""What the character between a task's brackets means (Issue #14): the Tasks plugin's own settings in the space, the
managers' list in nexlore above it, and every list and count that follows from it (overview, chips, calendar, search,
ticking off, the API).

The world: ``anna`` made ``Private`` (only she) and ``Shared``, where ``bob`` may read and ``carl`` may write; ``dave``
sees neither.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, Space
from app.services import index, taskstatus

from .conftest import join, make_account
from .test_everyday import TODAY, World, person, put, tasks_of

PLUGIN = "/.obsidian/plugins/obsidian-tasks-plugin/data.json"


def plugin_settings(*custom: tuple[str, str, str]) -> str:
    """A settings file as the Tasks plugin writes it: its two core statuses, its two custom ones, and ``custom``."""
    def row(symbol: str, name: str, kind: str) -> dict[str, object]:
        return {"symbol": symbol, "name": name, "nextStatusSymbol": "x", "availableAsCommand": True, "type": kind}

    return json.dumps({
        "globalFilter": "",
        "statusSettings": {
            "coreStatuses": [row(" ", "Todo", "TODO"), row("x", "Done", "DONE")],
            "customStatuses": [row("/", "In Progress", "IN_PROGRESS"), row("-", "Cancelled", "CANCELLED"),
                               *(row(*entry) for entry in custom)],
        },
    }, indent=2)


ARCHIVE_AND_REVIEW = plugin_settings(("a", "Archived", "CANCELLED"), ("r", "To be reviewed", "TODO"), ("i", "Idea", "NON_TASK"))
NOTE = "- [ ] plain\n- [r] review the draft\n- [a] old plan\n- [i] just a thought\n- [x] finished\n- [/] going\n"


@pytest.fixture
def world(client: TestClient, account: Account, vault: Path) -> World:
    w = World()
    assert w.anna.post("/api/spaces", json={"name": "Private"}).status_code == 201
    assert w.anna.post("/api/spaces", json={"name": "Shared"}).status_code == 201
    join(w.anna, "Shared", "bob", "read")
    join(w.anna, "Shared", "carl", "write")
    return w


@pytest.fixture(autouse=True)
def fresh() -> Iterator[None]:
    taskstatus.forget()
    yield
    taskstatus.forget()


def texts(found: dict) -> list[str]:
    return [item["text"] for item in found["items"]]


def test_without_settings_every_unknown_character_stays_open_as_before(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", NOTE)
    index.scan()
    found = tasks_of(world.anna)
    assert texts(found) == ["plain", "review the draft", "old plan", "just a thought", "going"]
    assert found["counts"]["open"] == 5 and found["counts"]["done"] == 1


def test_the_tasks_plugin_s_settings_say_what_each_character_means(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", NOTE)
    put(vault, "Private" + PLUGIN, ARCHIVE_AND_REVIEW)
    index.scan()
    found = tasks_of(world.anna)
    # [a] set aside is cancelled, [i] is no task at all, [r] to review stays open and shows its name.
    assert texts(found) == ["plain", "review the draft", "going"]
    assert found["counts"] == {"open": 3, "done": 1, "cancelled": 1, "overdue": 0, "today": 0, "week": 0, "later": 0,
                               "none": 3}
    review = found["items"][1]
    assert (review["mark"], review["status"], review["kind"], review["status_name"]) == (
        "r", "open", "todo", "To be reviewed")
    # What nexlore says anyway stays nexlore's own (the app names it in the reader's language).
    assert (found["items"][2]["kind"], found["items"][2]["status_name"]) == ("in_progress", "")
    assert texts(tasks_of(world.anna, status="cancelled")) == ["old plan"]
    assert texts(tasks_of(world.anna, status="done")) == ["finished"]
    assert "just a thought" not in texts(tasks_of(world.anna, status="all"))


def test_the_filter_picks_one_character_and_names_the_characters_there_are(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", NOTE + "- [r] review the budget\n")
    put(vault, "Private" + PLUGIN, ARCHIVE_AND_REVIEW)
    index.scan()
    found = tasks_of(world.anna, mark="r")
    assert texts(found) == ["review the draft", "review the budget"]
    # The chips count within the filter, the list of characters without it: the others stay to choose.
    assert found["counts"]["open"] == 2 and found["counts"]["done"] == 0
    assert [(entry["mark"], entry["status"], entry["count"], entry["name"]) for entry in found["marks"]] == [
        (" ", "open", 1, ""), ("/", "open", 1, ""), ("r", "open", 2, "To be reviewed"), ("x", "done", 1, ""),
        ("a", "cancelled", 1, "Archived")]
    assert texts(tasks_of(world.anna, mark=" ")) == ["plain"]
    assert world.anna.get("/api/tasks", params={"today": TODAY, "mark": "ab"}).status_code == 422


def test_a_changed_settings_file_holds_at_once_without_reading_a_note_again(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", NOTE)
    index.scan()
    assert "old plan" in texts(tasks_of(world.anna))
    put(vault, "Private" + PLUGIN, ARCHIVE_AND_REVIEW)
    assert "old plan" not in texts(tasks_of(world.anna))
    put(vault, "Private" + PLUGIN, plugin_settings(("a", "Archived", "TODO")))
    assert "old plan" in texts(tasks_of(world.anna))
    os.remove(vault / ("Private" + PLUGIN))
    assert texts(tasks_of(world.anna)) == ["plain", "review the draft", "old plan", "just a thought", "going"]


def test_each_space_reads_its_own_characters(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", "- [a] mine set aside\n- [ ] mine open\n")
    put(vault, "Private" + PLUGIN, ARCHIVE_AND_REVIEW)
    put(vault, "Shared/Plan.md", "- [a] ours, open here\n- [-] ours cancelled\n")
    index.scan()
    found = tasks_of(world.anna)
    assert sorted(texts(found)) == ["mine open", "ours, open here"]
    assert found["counts"]["cancelled"] == 2
    assert sorted(texts(tasks_of(world.anna, status="cancelled"))) == ["mine set aside", "ours cancelled"]
    # bob reads Shared only: there [a] has no meaning of its own.
    assert texts(tasks_of(world.bob)) == ["ours, open here"]


def test_the_managers_list_stands_above_the_plugin(world: World, vault: Path) -> None:
    put(vault, "Shared/Plan.md", NOTE)
    put(vault, "Shared" + PLUGIN, ARCHIVE_AND_REVIEW)
    index.scan()
    answer = world.anna.put("/api/spaces/Shared/task-statuses", json={"own": [
        {"mark": "a", "kind": "done", "name": "Filed"}, {"mark": "w", "kind": "on_hold", "name": "Waiting"}]})
    assert answer.status_code == 200, answer.text
    told = answer.json()
    assert [entry["mark"] for entry in told["plugin"]] == [" ", "x", "/", "-", "a", "r", "i"]
    assert {entry["mark"]: (entry["kind"], entry["source"]) for entry in told["statuses"]}["a"] == ("done", "own")
    assert texts(tasks_of(world.bob, status="done")) == ["old plan", "finished"]
    # Read by everybody in the space, set by its managers only.
    shown = world.bob.get("/api/spaces/Shared/task-statuses").json()
    assert shown["own"] == [{"mark": "a", "kind": "done", "name": "Filed", "source": "own"},
                            {"mark": "w", "kind": "on_hold", "name": "Waiting", "source": "own"}]
    assert shown["plugin_unreadable"] is False
    for client in (world.bob, world.carl):
        assert client.put("/api/spaces/Shared/task-statuses", json={"own": []}).status_code == 403
    dave = person(make_account("dave"), "dave")
    assert dave.get("/api/spaces/Shared/task-statuses").status_code == 404
    assert dave.get("/api/spaces/Private/task-statuses").status_code == dave.get(
        "/api/spaces/Nowhere/task-statuses").status_code == 404
    # Empty again: the plugin speaks for [a] once more.
    assert world.anna.put("/api/spaces/Shared/task-statuses", json={"own": []}).status_code == 200
    assert texts(tasks_of(world.bob, status="cancelled")) == ["old plan"]


@pytest.mark.parametrize("own", [
    [{"mark": "ab", "kind": "done"}],
    [{"mark": "]", "kind": "done"}],
    [{"mark": "\n", "kind": "done"}],
    [{"mark": "a", "kind": "finished"}],
    [{"mark": "a", "kind": "done"}, {"mark": "a", "kind": "todo"}],
    [{"mark": chr(65 + n), "kind": "done"} for n in range(61)],
])
def test_a_list_that_cannot_be_read_back_is_refused(world: World, own: list[dict]) -> None:
    answer = world.anna.put("/api/spaces/Private/task-statuses", json={"own": own})
    assert answer.status_code == 422, answer.text
    assert world.anna.get("/api/spaces/Private/task-statuses").json()["own"] == []


def test_a_settings_file_that_cannot_be_read_says_so_and_changes_nothing(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", NOTE)
    put(vault, "Private" + PLUGIN, "{ this is no json")
    index.scan()
    assert len(texts(tasks_of(world.anna))) == 5
    shown = world.anna.get("/api/spaces/Private/task-statuses").json()
    assert (shown["plugin"], shown["plugin_unreadable"]) == ([], True)
    # A row the plugin left blank is no mistake; one with a type it does not know is.
    put(vault, "Private" + PLUGIN, json.dumps({"statusSettings": {"coreStatuses": [], "customStatuses": [
        {"symbol": "", "name": "", "type": ""}, {"symbol": "a", "name": "Archived", "type": "CANCELLED"}]}}))
    shown = world.anna.get("/api/spaces/Private/task-statuses").json()
    assert ([entry["mark"] for entry in shown["plugin"]], shown["plugin_unreadable"]) == (["a"], False)
    put(vault, "Private" + PLUGIN, json.dumps({"statusSettings": {"customStatuses": [
        {"symbol": "a", "name": "Archived", "type": "SOMEDAY"}]}}))
    assert world.anna.get("/api/spaces/Private/task-statuses").json()["plugin_unreadable"] is True


def test_a_settings_file_reached_through_a_link_is_not_read(world: World, vault: Path, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "data.json").write_text(ARCHIVE_AND_REVIEW, encoding="utf-8")
    folder = vault / "Private/.obsidian/plugins"
    folder.mkdir(parents=True)
    try:
        os.symlink(outside, folder / "obsidian-tasks-plugin", target_is_directory=True)
    except OSError:
        # Windows without the right to make symbolic links: a junction leads out just the same.
        if os.name != "nt":
            raise
        import _winapi

        _winapi.CreateJunction(str(outside), str(folder / "obsidian-tasks-plugin"))
    put(vault, "Private/Plan.md", NOTE)
    index.scan()
    assert "old plan" in texts(tasks_of(world.anna))
    assert world.anna.get("/api/spaces/Private/task-statuses").json()["plugin"] is None


def test_the_calendar_and_the_search_count_as_the_space_reads(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", "- [a] set aside 📅 2026-09-20\n- [i] idea 📅 2026-09-20\n- [r] review 📅 2026-09-20\n")
    put(vault, "Private/Old.md", "- [a] only set aside things here\n")
    put(vault, "Private" + PLUGIN, ARCHIVE_AND_REVIEW)
    index.scan()
    month = world.anna.get("/api/calendar", params={"month": "2026-09", "today": TODAY}).json()
    assert month["days"]["2026-09-20"] == {"daily": [], "open": 1, "done": 1, "overdue": 1}
    notes = world.anna.get("/api/search/notes", params={"q": "task:"}).json()["notes"]
    assert [note["path"] for note in notes] == ["Private/Plan.md"]


def test_ticking_off_a_custom_open_character_repeats_it(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", "- [r] review 🔁 every week 📅 2026-09-27\n- [d] filed 🔁 every week 📅 2026-09-27\n")
    put(vault, "Private" + PLUGIN, plugin_settings(("r", "To be reviewed", "TODO"), ("d", "Filed", "DONE")))
    index.scan()
    review = tasks_of(world.anna)["items"][0]
    answer = world.anna.post("/api/tasks/toggle", json={
        "path": review["path"], "line": review["line"], "raw": review["raw"], "done": True, "today": TODAY})
    assert answer.status_code == 200, answer.text
    assert answer.json()["added"] == "- [ ] review 🔁 every week 📅 2026-10-04"
    # A done one opened again does not repeat.
    filed = next(item for item in tasks_of(world.anna, status="done")["items"] if item["text"] == "filed")
    answer = world.anna.post("/api/tasks/toggle", json={
        "path": filed["path"], "line": filed["line"], "raw": filed["raw"], "done": False, "today": TODAY})
    assert answer.json()["added"] is None
    assert (vault / "Private/Plan.md").read_text(encoding="utf-8").splitlines() == [
        "- [ ] review 🔁 every week 📅 2026-10-04", "- [x] review 🔁 every week 📅 2026-09-27 ✅ 2026-09-27",
        "- [ ] filed 🔁 every week 📅 2026-09-27"]


def test_the_api_names_the_kind(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", NOTE)
    put(vault, "Private" + PLUGIN, ARCHIVE_AND_REVIEW)
    index.scan()
    found = tasks_of(world.anna)
    assert [item["kind"] for item in found["items"]] == ["todo", "todo", "in_progress"]


def test_only_spaces_that_read_otherwise_leave_the_stored_column(world: World, vault: Path) -> None:
    """The stored ``tasks.status`` (and its index) answers for every space whose characters mean what nexlore's own
    say; a name alone, or a character that stays open, changes nothing there."""
    put(vault, "Private" + PLUGIN, plugin_settings(("r", "To be reviewed", "TODO"), ("w", "Waiting", "ON_HOLD")))
    put(vault, "Shared" + PLUGIN, ARCHIVE_AND_REVIEW)
    with SessionLocal() as db:
        ids = {space.folder: space.id for space in db.scalars(select(Space))}
        meaning = taskstatus.meaning(db, set(ids.values()))
    assert meaning.plain == {ids["Private"]}
    assert [group[0] for group in meaning.groups] == [[ids["Shared"]]]
    assert meaning.of(ids["Private"], "w").kind == "on_hold"
    assert meaning.of(ids["Private"], "?").kind == "todo"
