"""Everyday use (M6) over HTTP: tasks in the index and the overview, ticking one off line by line, daily notes, the
calendar, templates, the options of a space; and the rights of M4 in all of it.

The world: ``anna`` made ``Private`` (only she) and ``Shared``, where ``bob`` may read and ``carl`` may write.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.main import app
from app.models import Account, File, GraphNode, Setting, Task
from app.services import everyday, graphstore, index

from .conftest import make_account, sign_in

TODAY = "2026-09-27"


def person(account: Account, tab: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{tab:0<8}"})
    sign_in(client, account)
    return client


class World:
    def __init__(self) -> None:
        self.anna = person(make_account("anna"), "anna")
        self.bob = person(make_account("bob"), "bob")
        self.carl = person(make_account("carl"), "carl")


@pytest.fixture
def world(client: TestClient, account: Account, vault: Path) -> World:
    w = World()
    assert w.anna.post("/api/spaces", json={"name": "Private"}).status_code == 201
    assert w.anna.post("/api/spaces", json={"name": "Shared"}).status_code == 201
    assert w.anna.put("/api/spaces/Shared/members/bob", json={"role": "read"}).status_code == 200
    assert w.anna.put("/api/spaces/Shared/members/carl", json={"role": "write"}).status_code == 200
    return w


def put(vault: Path, rel: str, content: str | bytes) -> Path:
    path = vault.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


def tasks_of(client: TestClient, **query: str) -> dict:
    answer = client.get("/api/tasks", params={"today": TODAY, **query})
    assert answer.status_code == 200, answer.text
    return answer.json()


# --- Tasks in the index and the overview ---------------------------------------------------------------------------


def test_tasks_of_a_note_are_indexed_outside_code_and_follow_every_change(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", "# Plan\n- [ ] one 📅 2026-09-20\n```\n- [ ] in code\n```\n- [x] two ✅ 2026-09-26\n")
    index.scan()
    found = tasks_of(world.anna, status="all")
    assert [(item["text"], item["line"], item["status"]) for item in found["items"]] == [
        ("one", 2, "open"), ("two", 6, "done")]
    # Changed from outside: the rows follow; moved into the trash: they go.
    put(vault, "Private/Plan.md", "- [ ] three #home\n")
    index.scan()
    assert [item["text"] for item in tasks_of(world.anna, status="all")["items"]] == ["three #home"]
    assert world.anna.request("DELETE", "/api/files", params={"path": "Private/Plan.md"}).status_code == 200
    assert tasks_of(world.anna, status="all")["total"] == 0


def test_the_overview_filters_and_counts(world: World, vault: Path) -> None:
    lines = (
        "- [ ] late 📅 2026-09-20",
        "- [ ] now 📅 2026-09-27 ⏫",
        "- [ ] planned ⏳ 2026-09-27",
        "- [ ] soon 📅 2026-09-30 #garden",
        "- [ ] later 📅 2026-10-20",
        "- [ ] someday #garden/beds",
        "- [x] finished ✅ 2026-09-26",
        "- [-] dropped",
    )
    put(vault, "Private/A.md", "".join(line + "\n" for line in lines))
    index.scan()
    found = tasks_of(world.anna)
    assert found["counts"] == {"open": 6, "done": 2, "overdue": 1, "today": 2, "week": 1, "later": 1, "none": 1}
    # Open ones by date, the undated last; on the same day the higher priority first.
    assert [item["text"] for item in found["items"]] == [
        "late", "now", "planned", "soon #garden", "later", "someday #garden/beds"]
    assert [item["text"] for item in tasks_of(world.anna, when="today")["items"]] == ["now", "planned"]
    assert [item["text"] for item in tasks_of(world.anna, when="overdue")["items"]] == ["late"]
    assert [item["text"] for item in tasks_of(world.anna, when="none")["items"]] == ["someday #garden/beds"]
    assert [item["text"] for item in tasks_of(world.anna, status="done")["items"]] == ["finished", "dropped"]
    assert [item["text"] for item in tasks_of(world.anna, on="2026-09-27")["items"]] == ["now", "planned"]
    # A tag finds itself, not its children and not a longer name; case does not count.
    assert [item["text"] for item in tasks_of(world.anna, tag="#Garden")["items"]] == ["soon #garden"]
    assert [item["text"] for item in tasks_of(world.anna, q="late")["items"]] == ["late", "later"]
    assert tasks_of(world.anna, q="100%")["total"] == 0
    assert found["items"][1]["priority"] == 4 and found["items"][0]["due"] == "2026-09-20"
    assert {item["mark"] for item in found["items"]} == {" "}


def test_a_task_in_progress_is_open_and_says_so(world: World, vault: Path) -> None:
    put(vault, "Private/Work.md", "- [/] half done\n")
    index.scan()
    [item] = tasks_of(world.anna)["items"]
    assert (item["status"], item["mark"]) == ("open", "/")


def test_the_overview_shows_only_spaces_one_may_read(world: World, vault: Path) -> None:
    put(vault, "Private/Secret.md", "- [ ] classified pineapple\n")
    put(vault, "Shared/Common.md", "- [ ] shared chore\n")
    index.scan()
    assert [item["text"] for item in tasks_of(world.bob)["items"]] == ["shared chore"]
    assert [item["text"] for item in tasks_of(world.anna)["items"]] == ["classified pineapple", "shared chore"]
    assert tasks_of(world.anna, space="Private")["total"] == 1
    # Another's space answers like a missing one.
    other = world.bob.get("/api/tasks", params={"today": TODAY, "space": "Private"})
    missing = world.bob.get("/api/tasks", params={"today": TODAY, "space": "Nowhere"})
    assert other.status_code == missing.status_code == 404
    assert other.json() == missing.json()
    month = world.bob.get("/api/calendar", params={"month": "2026-09", "today": TODAY, "space": "Private"})
    assert month.status_code == 404 and month.json() == missing.json()
    assert world.bob.get("/api/tasks", params={"today": "2026-13-01"}).status_code == 400


# --- Ticking off, line by line -------------------------------------------------------------------------------------


def toggle(client: TestClient, path: str, line: int, raw: str, done: bool = True) -> object:
    return client.post("/api/tasks/toggle", json={"path": path, "line": line, "raw": raw, "done": done, "today": TODAY})


def test_ticking_off_changes_that_one_line_byte_for_byte(world: World, vault: Path) -> None:
    before = b"\xef\xbb\xbf# Plan\r\n- [ ] Buy ink  \r\n  * [ ] other\ttask\r\n- [ ] last line without end"
    path = put(vault, "Private/Plan.md", before)
    index.scan()
    answer = toggle(world.anna, "Private/Plan.md", 2, "- [ ] Buy ink  ")
    assert answer.status_code == 200, answer.text
    after = path.read_bytes()
    assert after == "\ufeff# Plan\r\n- [x] Buy ink ✅ 2026-09-27\r\n  * [ ] other\ttask\r\n- [ ] last line without end".encode()
    assert answer.json()["hash"] == hashlib.sha256(after).hexdigest()
    assert toggle(world.anna, "Private/Plan.md", 4, "- [ ] last line without end").status_code == 200
    assert path.read_bytes().endswith(b"\r\n- [x] last line without end \xe2\x9c\x85 2026-09-27")
    # Opened again: the done date goes, nothing else changes.
    assert toggle(world.anna, "Private/Plan.md", 2, "- [x] Buy ink ✅ 2026-09-27", done=False).status_code == 200
    assert path.read_bytes().startswith(b"\xef\xbb\xbf# Plan\r\n- [ ] Buy ink\r\n  * [ ] other\ttask\r\n")
    # The index knows at once.
    assert [item["status"] for item in tasks_of(world.anna, status="all")["items"]] == ["open", "open", "done"]


def test_a_task_that_moved_is_found_by_its_text_and_an_unclear_one_is_left_alone(world: World, vault: Path) -> None:
    path = put(vault, "Private/Plan.md", "- [ ] a\n- [ ] b\n")
    index.scan()
    path.write_bytes(b"new first line\n- [ ] a\n- [ ] b\n- [ ] b\n")
    index.scan()
    # Line 1 is no longer "- [ ] a"; it is found on line 2.
    assert toggle(world.anna, "Private/Plan.md", 1, "- [ ] a").status_code == 200
    assert path.read_bytes() == "new first line\n- [x] a ✅ 2026-09-27\n- [ ] b\n- [ ] b\n".encode()
    # "- [ ] b" stands twice and not where the caller saw it: nothing is written.
    answer = toggle(world.anna, "Private/Plan.md", 1, "- [ ] b")
    assert answer.status_code == 409 and answer.json()["detail"]["code"] == "task_changed"
    assert toggle(world.anna, "Private/Plan.md", 1, "- [ ] gone").status_code == 409
    assert path.read_bytes() == "new first line\n- [x] a ✅ 2026-09-27\n- [ ] b\n- [ ] b\n".encode()


def test_a_change_from_outside_meanwhile_ends_in_a_conflict_copy(
    world: World, vault: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = put(vault, "Private/Plan.md", "- [ ] a\n")
    index.scan()
    real = everyday.vault.read

    def read_then_outside_change(rel: str):
        found = real(rel)
        path.write_bytes(b"- [ ] a\nwritten in Obsidian meanwhile\n")
        return found

    monkeypatch.setattr(everyday.vault, "read", read_then_outside_change)
    answer = toggle(world.anna, "Private/Plan.md", 1, "- [ ] a")
    assert answer.status_code == 200
    assert answer.json()["conflict"]
    assert path.read_bytes() == b"- [ ] a\nwritten in Obsidian meanwhile\n"
    copy = vault / answer.json()["conflict"]
    assert copy.read_bytes() == "- [x] a ✅ 2026-09-27\n".encode()


def test_a_recurring_task_gets_its_next_occurrence_above_it(world: World, vault: Path) -> None:
    path = put(vault, "Private/Plan.md", "# Chores\n- [ ] water plants 🔁 every week ⏳ 2026-09-25 📅 2026-09-27 ^w1\nend\n")
    index.scan()
    answer = toggle(world.anna, "Private/Plan.md", 2, "- [ ] water plants 🔁 every week ⏳ 2026-09-25 📅 2026-09-27 ^w1")
    assert answer.status_code == 200
    assert answer.json()["line"] == 3
    assert path.read_text(encoding="utf-8") == (
        "# Chores\n"
        "- [ ] water plants 🔁 every week ⏳ 2026-10-02 📅 2026-10-04\n"
        "- [x] water plants 🔁 every week ⏳ 2026-09-25 📅 2026-09-27 ✅ 2026-09-27 ^w1\n"
        "end\n"
    )


def test_ticking_off_needs_the_right_to_write_and_nobody_else_editing(world: World, vault: Path) -> None:
    put(vault, "Shared/Common.md", "- [ ] shared chore\n")
    put(vault, "Private/Secret.md", "- [ ] classified\n")
    index.scan()
    assert toggle(world.bob, "Shared/Common.md", 1, "- [ ] shared chore").status_code == 403
    foreign = toggle(world.bob, "Private/Secret.md", 1, "- [ ] classified")
    missing = toggle(world.bob, "Nowhere/Secret.md", 1, "- [ ] classified")
    assert foreign.status_code == missing.status_code == 404 and foreign.json() == missing.json()
    assert world.anna.post("/api/locks", json={"path": "Shared/Common.md"}).status_code == 200
    locked = toggle(world.carl, "Shared/Common.md", 1, "- [ ] shared chore")
    assert locked.status_code == 423
    assert (vault / "Shared" / "Common.md").read_bytes() == b"- [ ] shared chore\n"


# --- Daily notes, templates, options -------------------------------------------------------------------------------


def test_the_daily_note_is_made_once_in_the_daily_folder_from_the_template(world: World, vault: Path) -> None:
    put(vault, "Shared/Templates/Day.md", "# {{title}}\n\n{{date:dddd}}\n<% tp.date.now() %>\n- [ ] \n")
    index.scan()
    assert world.anna.put("/api/spaces/Shared/options", json={"daily_template": "Templates/Day.md"}).status_code == 200
    # Reading may open a daily note, not make one.
    denied = world.bob.post("/api/daily", json={"space": "Shared", "date": "2026-09-07"})
    assert denied.status_code == 403
    made = world.carl.post("/api/daily", json={"space": "Shared", "date": "2026-09-07"})
    assert made.status_code == 200 and made.json() == {"path": "Shared/Daily/2026-09-07.md", "created": True}
    text = (vault / "Shared" / "Daily" / "2026-09-07.md").read_text(encoding="utf-8")
    assert text == "# 2026-09-07\n\nMonday\n<% tp.date.now() %>\n- [ ] \n"
    again = world.bob.post("/api/daily", json={"space": "Shared", "date": "2026-09-07"})
    assert again.json() == {"path": "Shared/Daily/2026-09-07.md", "created": False}
    assert world.anna.post("/api/daily", json={"space": "Private", "date": "2026-02-30"}).status_code == 400
    foreign = world.bob.post("/api/daily", json={"space": "Private", "date": "2026-09-07"})
    assert foreign.status_code == 404


def test_folders_of_a_space_one_may_not_read_are_never_found(world: World, vault: Path) -> None:
    put(vault, "Private/Salary/2026.md", "secret")
    put(vault, "Shared/Salary talk/Notes.md", "open")
    index.scan()

    def find(who, q: str) -> list[str]:
        return [hit["path"] for hit in who.get("/api/folders/find", params={"q": q}).json()]

    assert find(world.anna, "salary") == ["Private/Salary", "Shared/Salary talk"]
    assert find(world.bob, "salary") == ["Shared/Salary talk"]
    assert find(world.bob, "private") == []
    assert [hit["path"] for hit in world.bob.get("/api/folders/find").json()] == ["Shared"]


def test_a_space_whose_folder_is_gone_is_not_offered_after_a_slash(world: World, vault: Path) -> None:
    def offered() -> list[str]:
        return [hit["path"] for hit in world.anna.get("/api/folders/find").json()]

    listed = [space["name"] for space in world.anna.get("/api/spaces").json()]
    assert offered() == listed == ["Private", "Shared"]
    # Taken away on the disk: the list of spaces leaves it out, so must the quick switcher.
    (vault / "Private").rmdir()
    assert [space["name"] for space in world.anna.get("/api/spaces").json()] == ["Shared"]
    assert offered() == ["Shared"]


def test_the_options_of_a_space_belong_to_its_managers(world: World) -> None:
    assert world.bob.get("/api/spaces/Shared/options").json() == {
        "daily_folder": "Daily", "daily_template": "", "template_folder": "Templates", "theme": ""}
    assert world.carl.put("/api/spaces/Shared/options", json={"daily_folder": "Journal"}).status_code == 403
    assert world.bob.get("/api/spaces/Private/options").status_code == 404
    changed = world.anna.put("/api/spaces/Shared/options", json={"daily_folder": "/Journal/2026/", "template_folder": ""})
    assert changed.json() == {"daily_folder": "Journal/2026", "daily_template": "", "template_folder": "", "theme": ""}
    # The list of spaces says it too: the sidebar marks the two folders with it.
    shared = next(space for space in world.bob.get("/api/spaces").json() if space["name"] == "Shared")
    assert (shared["daily_folder"], shared["template_folder"]) == ("Journal/2026", "")
    assert world.anna.put("/api/spaces/Shared/options", json={"daily_folder": "../out"}).status_code == 400
    assert world.anna.put("/api/spaces/Shared/options", json={"daily_template": "Templates/x.png"}).status_code == 400
    made = world.anna.post("/api/daily", json={"space": "Shared", "date": "2026-09-08"})
    assert made.json()["path"] == "Shared/Journal/2026/2026-09-08.md"


def test_templates_fill_a_new_note_and_stay_in_their_space(world: World, vault: Path) -> None:
    put(vault, "Shared/Templates/Meeting.md", "---\ndate: {{date}}\n---\n# {{title}}\n<%* tR += 1 %>\n")
    put(vault, "Shared/Templates/Sub/Deep.md", "deep")
    put(vault, "Private/Templates/Mine.md", "# mine {{title}}")
    index.scan()
    assert [item["path"] for item in world.bob.get("/api/templates", params={"space": "Shared"}).json()] == [
        "Shared/Templates/Meeting.md", "Shared/Templates/Sub/Deep.md"]
    assert world.bob.get("/api/templates", params={"space": "Private"}).status_code == 404
    preview = world.bob.get("/api/templates/preview", params={"path": "Shared/Templates/Meeting.md", "title": "Kick-off"})
    assert "# Kick-off\n<%* tR += 1 %>" in preview.json()["content"]
    made = world.carl.post("/api/notes", json={"folder": "Shared", "title": "Kick-off",
                                               "template": "Shared/Templates/Meeting.md"})
    assert made.status_code == 201, made.text
    text = (vault / "Shared" / "Kick-off.md").read_text(encoding="utf-8")
    assert text.startswith("---\ndate: 20") and text.endswith("# Kick-off\n<%* tR += 1 %>\n")
    # A template of another space: not even from a space the caller manages.
    across = world.anna.post("/api/notes", json={"folder": "Shared", "title": "X", "template": "Private/Templates/Mine.md"})
    assert across.status_code == 404
    foreign = world.carl.post("/api/notes", json={"folder": "Shared", "title": "Y", "template": "Private/Templates/Mine.md"})
    assert foreign.status_code == 404
    assert not (vault / "Shared" / "X.md").exists() and not (vault / "Shared" / "Y.md").exists()


# --- The calendar and the graph ------------------------------------------------------------------------------------


def test_the_calendar_shows_daily_notes_and_task_counts_per_day(world: World, vault: Path) -> None:
    put(vault, "Shared/Daily/2026-09-07.md", "- [ ] in the daily note 📅 2026-09-08\n")
    put(vault, "Shared/Elsewhere/2026-09-09.md", "named like a date, not in the daily folder")
    put(vault, "Shared/Daily/2026-10-01.md", "next month")
    put(vault, "Shared/Jobs.md", "- [ ] late 📅 2026-09-03\n- [x] done ✅ 2026-09-03 📅 2026-09-03\n- [ ] planned ⏳ 2026-09-30\n")
    put(vault, "Private/Daily/2026-09-07.md", "- [ ] classified 📅 2026-09-07\n")
    index.scan()
    month = world.bob.get("/api/calendar", params={"month": "2026-09", "today": TODAY}).json()
    assert month["days"] == {
        "2026-09-07": {"daily": ["Shared/Daily/2026-09-07.md"], "open": 0, "done": 0, "overdue": 0},
        "2026-09-08": {"daily": [], "open": 1, "done": 0, "overdue": 1},
        "2026-09-03": {"daily": [], "open": 1, "done": 1, "overdue": 1},
        "2026-09-30": {"daily": [], "open": 1, "done": 0, "overdue": 0},
    }
    mine = world.anna.get("/api/calendar", params={"month": "2026-09", "today": TODAY, "space": "Private"}).json()
    assert mine["days"] == {"2026-09-07": {"daily": ["Private/Daily/2026-09-07.md"], "open": 1, "done": 0, "overdue": 1}}
    assert world.anna.get("/api/calendar", params={"month": "2026-9", "today": TODAY}).status_code == 422


def test_the_graph_counts_daily_notes_by_the_space_s_folder(world: World, vault: Path) -> None:
    put(vault, "Shared/Daily/2026-09-07.md", "a")
    put(vault, "Shared/Other/2026-09-08.md", "b")
    index.scan()
    with SessionLocal() as db:
        space_id = db.scalar(select(File.space_id).where(File.path == "Shared/Daily/2026-09-07.md"))
    graphstore.build(space_id, "folders")

    def daily() -> set[str]:
        with SessionLocal() as db:
            return set(db.scalars(
                select(File.path).join(GraphNode, GraphNode.file_id == File.id)
                .where(GraphNode.cloud == "folders", GraphNode.daily.is_(True))
            ))

    assert daily() == {"Shared/Daily/2026-09-07.md"}
    world.anna.put("/api/spaces/Shared/options", json={"daily_folder": ""})
    graphstore.build(space_id, "folders")
    assert daily() == {"Shared/Daily/2026-09-07.md", "Shared/Other/2026-09-08.md"}


def test_a_database_indexed_before_tasks_gets_them_filled_in_once(world: World, vault: Path) -> None:
    put(vault, "Private/Plan.md", "- [ ] one\n- [ ] two\n")
    put(vault, "Private/Plain.md", "no tasks here")
    index.scan()
    with SessionLocal() as db:
        db.execute(delete(Task))
        db.execute(delete(Setting).where(Setting.key == index.TASKS_FILLED))
        db.commit()
    assert index.fill_tasks() == 1
    assert [item["text"] for item in tasks_of(world.anna)["items"]] == ["one", "two"]
    # Once: a second start leaves everything as it is, even when the table were empty again.
    assert index.fill_tasks() == 0
    assert tasks_of(world.anna)["total"] == 2
    with SessionLocal() as db:
        db.execute(delete(Task))
        db.commit()
    assert index.fill_tasks() == 0


def test_filling_in_goes_on_although_one_note_has_its_tasks_already(world: World, vault: Path) -> None:
    # A note saved before the filling ran (or a restart halfway) must not end it for the rest of the vault.
    for number in range(3):
        put(vault, f"Private/n{number}.md", f"- [ ] task {number}\n")
    index.scan()
    with SessionLocal() as db:
        keep = db.scalar(select(File.id).where(File.path == "Private/n0.md"))
        db.execute(delete(Task).where(Task.file_id != keep))
        db.execute(delete(Setting).where(Setting.key == index.TASKS_FILLED))
        db.commit()
    assert index.fill_tasks() == 2
    assert tasks_of(world.anna)["total"] == 3


def test_a_very_long_task_line_can_be_ticked_off(world: World, vault: Path) -> None:
    line = "- [ ] " + "w" * 4100
    path = put(vault, "Private/Long.md", line + "\n")
    index.scan()
    [task] = tasks_of(world.anna)["items"]
    assert task["raw"] == line
    assert toggle(world.anna, "Private/Long.md", 1, task["raw"]).status_code == 200
    assert path.read_text(encoding="utf-8") == "- [x] " + "w" * 4100 + " ✅ 2026-09-27\n"


def test_a_recurring_task_with_an_impossible_date_is_ticked_off_without_a_next_one(world: World, vault: Path) -> None:
    path = put(vault, "Private/Odd.md", "- [ ] odd 🔁 every month 📅 2026-02-30\n")
    index.scan()
    answer = toggle(world.anna, "Private/Odd.md", 1, "- [ ] odd 🔁 every month 📅 2026-02-30")
    assert answer.status_code == 200 and answer.json()["added"] is None
    assert path.read_text(encoding="utf-8") == "- [x] odd 🔁 every month 📅 2026-02-30 ✅ 2026-09-27\n"


def test_a_daily_note_on_disk_in_other_letters_is_taken_not_made_again(world: World, vault: Path) -> None:
    # Written by Obsidian or a sync a moment ago, not read by the index yet.
    put(vault, "Shared/Daily/2026-09-07.MD", "from outside\n")
    made = world.carl.post("/api/daily", json={"space": "Shared", "date": "2026-09-07"})
    assert made.json() == {"path": "Shared/Daily/2026-09-07.MD", "created": False}
    assert sorted(entry.name for entry in (vault / "Shared" / "Daily").iterdir()) == ["2026-09-07.MD"]
    assert world.carl.get("/api/note", params={"path": "Shared/Daily/2026-09-07.MD"}).json()["content"] == "from outside\n"


def test_a_move_whose_new_row_is_gone_meanwhile_is_no_move(world: World, vault: Path) -> None:
    put(vault, "Private/Old.md", "same")
    index.scan()
    with SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == "Private/Old.md"))
        assert index._merge_move(db, file, "Private/Nowhere.md") is False
        assert file.path == "Private/Old.md"


def test_only_notes_are_previewed_as_templates(world: World, vault: Path) -> None:
    put(vault, "Shared/Templates/picture.png", "\x89PNG")
    index.scan()
    answer = world.bob.get("/api/templates/preview", params={"path": "Shared/Templates/picture.png"})
    assert answer.status_code == 400 and answer.json()["detail"]["code"] == "not_a_note"
