"""Views over notes as Obsidian's Bases: the expressions, a .base file and a code block, cells written back."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Space
from app.services import baseexpr, bases, index
from app.services.frontedit import set_property

from .conftest import make_account, sign_in

RECIPES = """filters:
  and:
    - file.inFolder("Recipes")
    - file.hasTag("recipe")
formulas:
  each: "minutes / servings"
  quick: "if(minutes <= 30, \\"yes\\", \\"no\\")"
properties:
  note.minutes:
    displayName: Minutes
views:
  - type: table
    name: All
    order:
      - file.name
      - minutes
      - status
      - formula.each
    sort:
      - property: minutes
        direction: ASC
  - type: board
    name: By status
    groupBy:
      property: status
    order:
      - file.name
      - status
  - type: cards
    name: Quick ones
    filters: 'formula.quick == "yes"'
    order:
      - file.name
"""


def put(root: Path, rel: str, content: str) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode())


@pytest.fixture
def kitchen(vault: Path, account: str) -> Path:
    put(vault, "Kitchen/Recipes/Bread.md", "---\ntags: [recipe]\nminutes: 720\nservings: 4\nstatus: tried\n---\n# Bread\n")
    put(vault, "Kitchen/Recipes/Soup.md", "---\ntags: [recipe]\nminutes: 45\nservings: 3\nstatus: tried\n---\n# Soup\n")
    put(vault, "Kitchen/Recipes/Shakshuka.md", "---\ntags: [recipe, breakfast]\nminutes: 25\nservings: 2\nstatus: planned\n---\n")
    put(vault, "Kitchen/Recipes/Notes on flour.md", "No recipe here. #flour\n")
    put(vault, "Kitchen/Other/Pie.md", "---\ntags: [recipe]\nminutes: 90\n---\n")
    put(vault, "Kitchen/Recipes.base", RECIPES)
    index.scan()
    return vault


def rows(answer: dict) -> list[str]:
    return [row["title"] for group in answer["groups"] for row in group["rows"]]


def test_a_base_file_filters_sorts_and_works_out_formulas(client: TestClient, kitchen: Path) -> None:
    answer = client.get("/api/bases/view", params={"path": "Kitchen/Recipes.base"}).json()
    assert [view["name"] for view in answer["views"]] == ["All", "By status", "Quick ones"]
    assert [(column["key"], column["label"]) for column in answer["columns"]] == [
        ("file.name", "name"), ("note.minutes", "Minutes"), ("note.status", "status"), ("formula.each", "each"),
    ]
    assert rows(answer) == ["Shakshuka", "Soup", "Bread"]
    cells = answer["groups"][0]["rows"][2]["cells"]
    assert cells["formula.each"] == 180 and cells["note.minutes"] == 720
    board = client.get("/api/bases/view", params={"path": "Kitchen/Recipes.base", "view": 1}).json()
    assert board["kind"] == "board" and [group["value"] for group in board["groups"]] == ["planned", "tried"]
    quick = client.get("/api/bases/view", params={"path": "Kitchen/Recipes.base", "view": 2}).json()
    assert quick["kind"] == "cards" and rows(quick) == ["Shakshuka"]


def test_a_code_block_looks_at_the_space_of_its_note(client: TestClient, kitchen: Path) -> None:
    text = 'filters: \'file.hasTag("recipe") && minutes > 60\'\nviews:\n  - type: list\n    order: [file.name]\n'
    answer = client.post("/api/bases/block", json={"source": "Kitchen/Recipes/Bread.md", "text": text}).json()
    assert answer["kind"] == "list" and sorted(rows(answer)) == ["Bread", "Pie"]
    assert client.post("/api/bases/block", json={"source": "Kitchen/Recipes/Bread.md", "text": "- no"}).status_code == 422


def test_a_folder_filter_reads_only_that_folder_and_still_finds_all_of_it(client: TestClient, kitchen: Path) -> None:
    put(kitchen, "Kitchen/Recipes/Cakes/Plum.md", "---\ntags: [recipe]\n---\nGoes with [[Soup]].\n")
    put(kitchen, "Kitchen/Recipes old/Stew.md", "not in Recipes, though its folder starts alike\n")
    put(kitchen, "Kitchen/100%_done/Tart.md", "odd folder name\n")
    put(kitchen, "Kitchen/1000_done/Flan.md", "what _ and % would match as wildcards\n")
    index.scan()

    def names(filters: str, extra: str = "") -> list[str]:
        text = f"filters:\n{filters}\n{extra}views:\n  - type: list\n    order: [file.name]\n"
        answer = client.post("/api/bases/block", json={"source": "Kitchen/Recipes/Bread.md", "text": text})
        assert answer.status_code == 200, answer.text
        return rows(answer.json())

    recipes = ["Bread", "Notes on flour", "Plum", "Shakshuka", "Soup"]
    # Case as the filter compares it, folders below, no neighbour that merely starts alike.
    assert names('  and:\n    - file.inFolder("recipes")') == recipes
    assert names('  and:\n    - file.inFolder("/Recipes/")\n    - \'file.name != "Soup"\'') == [n for n in recipes if n != "Soup"]
    assert names('  and:\n    - file.inFolder("Recipes/Cakes")') == ["Plum"]
    # % and _ are letters of the name.
    assert names('  and:\n    - file.inFolder("100%_done")') == ["Tart"]
    # Either of two folders: nothing may be left unread.
    assert names('  or:\n    - file.inFolder("Other")\n    - file.inFolder("Recipes old")') == ["Pie", "Stew"]
    assert names('  not:\n    - file.inFolder("Recipes")') == ["Flan", "Pie", "Stew", "Tart"]
    assert names('  and:\n    - file.inFolder("Recipes")\n    - file.hasLink("Soup")') == ["Plum"]
    # Tags and links still count when only a formula names them.
    assert names('  and:\n    - file.inFolder("Recipes")\n    - "formula.tagged"', '''formulas:\n  tagged: 'file.hasTag("breakfast")'\n''') == ["Shakshuka"]


def test_the_folder_limit_reads_exactly_the_notes_below_the_folder(kitchen: Path) -> None:
    put(kitchen, "Kitchen/Recipes/Cakes/Plum.md", "cake")
    put(kitchen, "Kitchen/Recipes old/Stew.md", "a neighbour")
    put(kitchen, "Kitchen/100%_done/Tart.md", "odd")
    put(kitchen, "Kitchen/1000_done/Flan.md", "what wildcards would take")
    put(kitchen, "Kitchen/Übung/Tee.md", "an umlaut, which SQLite's LIKE does not fold")
    index.scan()
    with SessionLocal() as db:
        space = db.scalar(select(Space.id).where(Space.folder == "Kitchen"))

        def read(folder: str) -> list[str]:
            return sorted(file.path for file, _ in bases._rows(db, space, "Kitchen", {}, folder=folder))

        assert read("recipes") == [
            "Kitchen/Recipes/Bread.md", "Kitchen/Recipes/Cakes/Plum.md", "Kitchen/Recipes/Notes on flour.md",
            "Kitchen/Recipes/Shakshuka.md", "Kitchen/Recipes/Soup.md",
        ]
        assert read("100%_done") == ["Kitchen/100%_done/Tart.md"]
        assert read("ÜBUNG") == ["Kitchen/Übung/Tee.md"]


def test_a_cell_writes_the_property_and_keeps_the_rest(client: TestClient, kitchen: Path) -> None:
    changed = client.put("/api/bases/cell", json={"path": "Kitchen/Recipes/Soup.md", "key": "note.status", "value": "favourite"})
    assert changed.status_code == 200, changed.text
    assert (kitchen / "Kitchen/Recipes/Soup.md").read_bytes() == b"---\ntags: [recipe]\nminutes: 45\nservings: 3\nstatus: favourite\n---\n# Soup\n"
    assert client.put("/api/bases/cell", json={"path": "Kitchen/Recipes/Soup.md", "key": "formula.each", "value": 1}).status_code == 422
    assert client.put("/api/bases/cell", json={"path": "Kitchen/Recipes/Soup.md", "key": "x", "value": {"a": 1}}).status_code == 422


def test_views_answer_only_who_may_read_and_change_only_who_may_write(client: TestClient, kitchen: Path) -> None:
    stranger = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-stranger"})
    sign_in(stranger, make_account("stranger"))
    assert stranger.get("/api/bases/view", params={"path": "Kitchen/Recipes.base"}).status_code == 404
    assert stranger.post("/api/bases/block", json={"source": "Kitchen/Recipes/Bread.md", "text": "{}"}).status_code == 404
    assert stranger.put("/api/bases/cell", json={"path": "Kitchen/Recipes/Soup.md", "key": "status", "value": "x"}).status_code == 404


def test_a_new_view_is_made_and_its_yaml_saved_against_what_was_read(client: TestClient, kitchen: Path) -> None:
    made = client.post("/api/bases", json={"folder": "Kitchen/Recipes", "name": "Mine"})
    assert made.status_code == 201, made.text
    first = client.get("/api/bases/view", params={"path": "Kitchen/Recipes/Mine.base"}).json()
    assert sorted(rows(first)) == ["Bread", "Notes on flour", "Shakshuka", "Soup"]
    text = first["text"].replace("type: table", "type: cards")
    saved = client.put("/api/bases/file", json={"path": "Kitchen/Recipes/Mine.base", "text": text, "base_hash": first["hash"]})
    assert saved.status_code == 200
    assert client.put("/api/bases/file", json={"path": "Kitchen/Recipes/Mine.base", "text": text, "base_hash": first["hash"]}).status_code == 409
    assert client.put("/api/bases/file", json={"path": "Kitchen/Recipes/Mine.base", "text": "[", "base_hash": saved.json()["hash"]}).status_code == 422
    assert client.post("/api/bases", json={"folder": "Kitchen/Recipes", "name": "Mine"}).status_code == 409


# --- The expressions --------------------------------------------------------------------------------------------


def row(**front: object) -> baseexpr.Row:
    return baseexpr.Row(
        name="Plan", path="Work/Plan.md", folder="Work", size=10, mtime=datetime(2026, 9, 1, tzinfo=UTC),
        tags=["project/garden"], links=["Ideas/Garden"], front=dict(front),
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('file.inFolder("Work")', True),
        ('file.inFolder("work/")', True),
        ('file.inFolder("Wo")', False),
        ('file.hasTag("project")', True),
        ('file.hasTag("#project/garden", "x")', True),
        ('file.hasLink("Garden")', True),
        ('file.hasProperty("status")', True),
        ('status == "Open" && !(minutes > 60)', True),
        ("minutes * 2 + 1", 91),
        ("minutes / 0", None),
        ('tags.contains("Home")', True),
        ('"a" + minutes', "a45"),
        ('file.mtime < date("2026-09-02")', True),
        ('file.mtime > now() - "7d"', False),
        ('due > "2026-01-01"', True),
        ('if(minutes > 30, "long", "short")', "long"),
        ('file.name.lower().startsWith("pl")', True),
        ("[1, 2].contains(2)", True),
        ("missing == null", True),
        ("title.length", 4),
    ],
)
def test_expressions_read_as_obsidian_writes_them(text: str, expected: object) -> None:
    from datetime import date

    here = row(status="open", minutes=45, tags=["home"], due=baseexpr.as_date(date(2026, 3, 1)), title="Plan")
    assert baseexpr.evaluate(baseexpr.parse(text), here) == expected


@pytest.mark.parametrize(
    "text",
    ["__import__('os')", "a(", "1 +", ")", "x" * 1001, "(" * 50 + "1" + ")" * 50, "open('x')", "a; b"],
)
def test_nothing_else_is_read_or_run(text: str) -> None:
    with pytest.raises(baseexpr.ExprError):
        baseexpr.evaluate(baseexpr.parse(text), row())


def test_python_s_own_names_are_just_empty() -> None:
    for text in ["file.__class__", "file.__dict__", "note.__init__", "status.__class__"]:
        assert baseexpr.evaluate(baseexpr.parse(text), row(status="x")) is None


def test_a_formula_that_names_itself_ends() -> None:
    here = row()
    here.formulas = {"a": baseexpr.parse("formula.a + 1")}
    assert baseexpr.evaluate(baseexpr.parse("formula.a"), here) is None


@pytest.mark.parametrize(
    ("before", "key", "value", "after"),
    [
        ("---\na: 1\nstatus: old\nb: 2\n---\nText\n", "status", "new", "---\na: 1\nstatus: new\nb: 2\n---\nText\n"),
        ("---\ntags:\n  - a\n  - b\nc: 1\n---\n", "tags", ["x", "y"], "---\ntags: [x, y]\nc: 1\n---\n"),
        ("---\na: 1\n---\nText", "n", 3, "---\na: 1\nn: 3\n---\nText"),
        ("Text only\n", "status", "draft", "---\nstatus: draft\n---\nText only\n"),
        ("---\r\na: 1\r\n---\r\nT\r\n", "a", True, "---\r\na: true\r\n---\r\nT\r\n"),
        ("---\na: 1\n---\n", "a", "yes: no", "---\na: 'yes: no'\n---\n"),
        ("---\na: 1\n---\n", "a", None, "---\na:\n---\n"),
    ],
)
def test_one_property_changes_and_every_other_byte_stays(before: str, key: str, value: object, after: str) -> None:
    assert set_property(before, key, value) == after
