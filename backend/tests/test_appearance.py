"""How nexlore looks for an account: stored with it, checked against fixed lists, part of ``/api/auth/me``."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.services import appearance


def test_the_defaults_come_with_me_and_a_change_keeps_the_rest(client: TestClient, account: object) -> None:
    assert client.get("/api/auth/me").json()["appearance"] == appearance.DEFAULTS
    changed = client.put("/api/me/appearance", json={"font_text": "literata", "size": 18})
    assert changed.status_code == 200, changed.text
    assert changed.json() == {**appearance.DEFAULTS, "font_text": "literata", "size": 18}
    client.put("/api/me/appearance", json={"width": "wide", "mode": "system"})
    assert client.get("/api/auth/me").json()["appearance"] == {
        **appearance.DEFAULTS, "font_text": "literata", "size": 18, "width": "wide", "mode": "system",
    }


@pytest.mark.parametrize(
    "bad",
    [
        {"font_text": "Comic Sans"},
        {"font_ui": "url(https://example.com/x.woff)"},
        {"size": 30},
        {"size": True},
        {"size": "16"},
        {"width": "huge"},
        {"mode": "sepia"},
        {"space_themes": "yes"},
        {"theme": ""},
        {"colour": "red"},
        {"start": "calendar"},
        {"start_note": "../outside.md"},
        {"start_note": "/Work/Plan.md"},
        {"start_note": "Work/Plan.txt"},
        {"start_note": 7},
        {"panel": "no"},
        {"panel_tab": "chat"},
        {"sidebar": "hidden"},
    ],
)
def test_only_values_on_the_lists_are_taken(client: TestClient, account: object, bad: dict) -> None:
    answer = client.put("/api/me/appearance", json=bad)
    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "bad_appearance"
    assert client.get("/api/auth/me").json()["appearance"] == appearance.DEFAULTS


def test_a_stored_value_no_longer_offered_falls_back_to_the_default() -> None:
    assert appearance.of({"font_text": "gone", "size": 17, "junk": 1}) == {**appearance.DEFAULTS, "size": 17}
    assert appearance.of(None) == appearance.DEFAULTS


def test_the_start_page_is_one_of_four_and_a_note_there_needs_a_path() -> None:
    assert appearance.change(None, {"start": "note", "start_note": "Work/Ideas/Plan.md"}) == {
        "start": "note", "start_note": "Work/Ideas/Plan.md"}
    assert appearance.of({"start": "daily"})["start"] == "daily"
    # Empty clears the note chosen.
    assert appearance.change({"start": "note", "start_note": "Work/Plan.md"}, {"start": "graph", "start_note": ""}) == {
        "start": "graph", "start_note": ""}
    assert appearance.of({"start": "gone", "start_note": "Work/../x.md"}) == appearance.DEFAULTS


def test_the_column_beside_a_note_and_the_sidebar_are_kept_with_the_account(client: TestClient, account: object) -> None:
    assert {key: appearance.DEFAULTS[key] for key in ("panel", "panel_tab", "sidebar")} == {
        "panel": True, "panel_tab": "links", "sidebar": "open"}
    changed = client.put("/api/me/appearance", json={"panel": False, "panel_tab": "versions", "sidebar": "rail"})
    assert changed.status_code == 200, changed.text
    got = client.get("/api/auth/me").json()["appearance"]
    assert (got["panel"], got["panel_tab"], got["sidebar"]) == (False, "versions", "rail")


def _many(count: int) -> dict:
    combos = [f"{mods}{chr(65 + n)}" for mods in ("Ctrl+Alt+", "Ctrl+Shift+", "Alt+Shift+") for n in range(26)]
    return {f"go.place{n}": {"combo": combos[n], "label": f"Place {n}"} for n in range(count)}


def test_own_keys_are_kept_with_the_account_and_replaced_as_a_whole(client: TestClient, account: object) -> None:
    keys = {
        "go.tasks": {"combo": "Ctrl+Alt+J", "label": "Go to Tasks"},
        "editor.heading1": {"combo": "F8", "label": "Heading 1"},
        "editor.callout:note": {"combo": "Ctrl+Shift+Meta+Period", "label": "Note callout"},
    }
    changed = client.put("/api/me/appearance", json={"keys": keys})
    assert changed.status_code == 200, changed.text
    assert client.get("/api/auth/me").json()["appearance"]["keys"] == keys
    assert client.put("/api/me/appearance", json={"keys": _many(appearance.KEYS_MAX)}).status_code == 200
    assert client.put("/api/me/appearance", json={"keys": {}}).status_code == 200
    assert client.get("/api/auth/me").json()["appearance"]["keys"] == {}


@pytest.mark.parametrize(
    "keys",
    [
        ["go.tasks"],
        {"go.tasks": "Ctrl+Alt+J"},
        {"go.tasks": {"combo": "ctrl+alt+j", "label": "Tasks"}},
        {"go.tasks": {"combo": "Alt+Ctrl+J", "label": "Tasks"}},
        {"go.tasks": {"combo": "Ctrl+Alt+Escape", "label": "Tasks"}},
        {"go.tasks": {"combo": "Ctrl+Alt+J", "label": ""}},
        {"go.tasks": {"combo": "Ctrl+Alt+J", "label": "x" * 81}},
        {"go.tasks": {"combo": "Ctrl+Alt+J", "label": "Tasks", "run": "alert(1)"}},
        {"Go to tasks": {"combo": "Ctrl+Alt+J", "label": "Tasks"}},
        {"tasks": {"combo": "Ctrl+Alt+J", "label": "Tasks"}},
        {"go.tasks": {"combo": "Ctrl+Alt+J", "label": "Tasks"}, "go.files": {"combo": "Ctrl+Alt+J", "label": "Files"}},
        _many(appearance.KEYS_MAX + 1),
    ],
)
def test_own_keys_take_only_known_shapes_and_each_combination_once(client: TestClient, account: object, keys: object) -> None:
    answer = client.put("/api/me/appearance", json={"keys": keys})
    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "bad_appearance"
    assert client.get("/api/auth/me").json()["appearance"]["keys"] == {}
