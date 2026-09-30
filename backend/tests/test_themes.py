"""Colour themes per account, the gallery, a space's theme, and own CSS behind the operator's switch.

The world: ``anna`` manages ``Kitchen``, ``bob`` reads it, ``carl`` has nothing to do with either.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import csscheck, themes

from .conftest import make_account, sign_in

DARK = {"bg": "#101010", "text": "#f0f0f0", "accent": "#ff8800", "on-accent": "#000000"}


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> dict[str, TestClient]:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.post("/api/spaces", json={"name": "Kitchen"}).status_code == 201
    assert anna.put("/api/spaces/Kitchen/members/bob", json={"role": "read"}).status_code == 200
    return {"operator": client, "anna": anna, "bob": bob, "carl": carl}


def test_the_themes_that_come_along_are_readable_everywhere() -> None:
    assert len(themes.BUILT_IN) == 7
    for key, colours in themes.BUILT_IN.items():
        assert set(colours["dark"]) == set(themes.TOKENS) == set(colours["light"]), key
        assert themes.weak_spots(colours) == [], key


def test_an_own_theme_is_kept_changed_shared_and_seen_by_others_only_when_shared(people: dict[str, TestClient]) -> None:
    anna, carl = people["anna"], people["carl"]
    made = anna.post("/api/themes", json={"name": "Dusk", "colours": {"dark": DARK}})
    assert made.status_code == 201, made.text
    ref = made.json()["ref"]
    assert made.json()["weak"] == []
    assert carl.get(f"/api/themes/{ref}").status_code == 404
    assert [row["ref"] for row in carl.get("/api/themes").json()["shared"]] == []
    # Nobody but the owner changes it; a stranger's change answers like a missing theme.
    theme_id = made.json()["id"]
    assert carl.put(f"/api/themes/{theme_id}", json={"shared": True}).status_code == 404
    assert anna.put(f"/api/themes/{theme_id}", json={"shared": True, "name": "Dusk two"}).status_code == 200
    gallery = carl.get("/api/themes").json()["shared"]
    assert [(row["ref"], row["name"], row["owner"]) for row in gallery] == [(ref, "Dusk two", "anna")]
    # Chosen by carl: his look carries its colours; taken back out of the gallery: nexlore's own again.
    assert carl.put("/api/me/appearance", json={"theme": ref}).status_code == 200
    assert carl.get("/api/auth/me").json()["theme_colours"] == {"dark": DARK}
    assert anna.put(f"/api/themes/{theme_id}", json={"shared": False}).status_code == 200
    assert carl.get("/api/auth/me").json()["theme_colours"] is None
    assert anna.delete(f"/api/themes/{theme_id}").status_code == 204
    assert anna.get("/api/themes").json()["mine"] == []


@pytest.mark.parametrize(
    "colours",
    [
        {"dark": {"bg": "red"}},
        {"dark": {"bg": "#12345"}},
        {"dark": {"glow": "#123456"}},
        {"sepia": {}},
        {"dark": ["#123456"]},
        {"dark": {"bg": "url(https://example.com)"}},
        {"callouts": ["recipe"]},
        {"callouts": {"Recipe": {}}},
        {"callouts": {"recipe": {"dark": "orange"}}},
        {"callouts": {"recipe": {"glow": "#123456"}}},
        {"callouts": {"recipe": {"icon": "url(x)"}}},
        {"callouts": {f"kind-{n}": {} for n in range(31)}},
    ],
)
def test_colours_that_are_no_theme_are_refused_in_words(people: dict[str, TestClient], colours: dict) -> None:
    answer = people["anna"].post("/api/themes", json={"name": "Bad", "colours": colours})
    assert answer.status_code == 422
    assert answer.json()["detail"]["code"] == "bad_theme"


def test_a_weak_theme_is_kept_and_told_where_it_is_weak(people: dict[str, TestClient]) -> None:
    weak = people["anna"].post("/api/themes", json={"name": "Grey", "colours": {"dark": {"bg": "#777777", "text": "#888888"}}})
    assert weak.status_code == 201
    assert weak.json()["weak"] == [{"mode": "dark", "token": "text", "ratio": 1.26}]


def test_a_look_names_a_theme_by_one_of_the_three_forms(people: dict[str, TestClient]) -> None:
    carl = people["carl"]
    for good in ["nexlore", "plum", "t:12"]:
        assert carl.put("/api/me/appearance", json={"theme": good}).status_code == 200, good
    for bad in ["", "Plum ", "t:", "t:x", "../x", "a" * 50]:
        assert carl.put("/api/me/appearance", json={"theme": bad}).status_code == 422, bad
    assert carl.put("/api/me/appearance", json={"theme": "plum"}).status_code == 200
    assert carl.get("/api/auth/me").json()["theme_colours"] == themes.BUILT_IN["plum"]


def test_a_space_sets_a_theme_its_readers_may_read_and_only_one_its_manager_may(people: dict[str, TestClient]) -> None:
    anna, bob, carl = people["anna"], people["bob"], people["carl"]
    own = anna.post("/api/themes", json={"name": "Kitchen light", "colours": {"dark": DARK}}).json()["ref"]
    foreign = carl.post("/api/themes", json={"name": "Carl's", "colours": {"dark": DARK}}).json()["ref"]
    assert anna.put("/api/spaces/Kitchen/options", json={"theme": foreign}).status_code == 422
    assert anna.put("/api/spaces/Kitchen/options", json={"theme": "nowhere"}).status_code == 422
    assert anna.put("/api/spaces/Kitchen/options", json={"theme": own}).status_code == 200
    kitchen = next(space for space in bob.get("/api/spaces").json() if space["name"] == "Kitchen")
    assert kitchen["theme"] == own
    # Not shared, yet bob reads its colours: the space he reads sets it. carl does not.
    assert bob.get(f"/api/themes/{own}").json()["colours"] == {"dark": DARK}
    assert carl.get(f"/api/themes/{own}").status_code == 404
    # A reader may not set it.
    assert bob.put("/api/spaces/Kitchen/options", json={"theme": "plum"}).status_code == 403
    assert anna.put("/api/spaces/Kitchen/options", json={"theme": ""}).status_code == 200


def test_own_css_waits_for_the_operator_and_passes_only_what_cannot_leave_the_page(people: dict[str, TestClient]) -> None:
    operator, anna = people["operator"], people["anna"]
    assert anna.get("/api/css-snippets").json() == {"allowed": False, "snippets": []}
    assert anna.post("/api/css-snippets", json={"name": "Wide", "css": ".a{}"}).status_code == 403
    assert operator.put("/api/settings", json={"custom_css_allowed": True}).status_code == 200
    ok = anna.post("/api/css-snippets", json={"name": "Wide", "css": ".nn-prose { font-size: 17px }"})
    assert ok.status_code == 201, ok.text
    off = anna.post("/api/css-snippets", json={"name": "Off", "css": ".b { color: red }", "enabled": False})
    bad = anna.post("/api/css-snippets", json={"name": "Leak", "css": "a {\n  background: url(https://example.com/x)\n}"})
    assert bad.status_code == 422
    assert bad.json()["detail"]["problems"] == [{"line": 2, "what": "url()"}]
    css = "\n".join(anna.get("/api/auth/me").json()["own_css"])
    assert "font-size: 17px" in css and "color: red" not in css
    # Only the own account's pages get it.
    assert people["bob"].get("/api/auth/me").json()["own_css"] == []
    assert people["bob"].put(f"/api/css-snippets/{ok.json()['id']}", json={"enabled": False}).status_code == 404
    assert anna.put(f"/api/css-snippets/{off.json()['id']}", json={"enabled": True}).status_code == 200
    assert any("color: red" in css for css in anna.get("/api/auth/me").json()["own_css"])
    # Closed again: nothing of it reaches a page, and nothing new is taken.
    assert operator.put("/api/settings", json={"custom_css_allowed": False}).status_code == 200
    assert anna.get("/api/auth/me").json()["own_css"] == []
    assert anna.put(f"/api/css-snippets/{off.json()['id']}", json={"css": ".c{}"}).status_code == 403


@pytest.mark.parametrize(
    "css",
    [
        r"body { background: url(https://example.com/x.png) }",
        r"body { background: url('https://example.com/x.png') }",
        r"body { background: \75rl(https://example.com/x) }",
        r"body { background: u\72l('https://example.com/x') }",
        r"@import 'https://example.com/x.css';",
        r"@\69mport 'https://example.com/x.css';",
        r"@font-face { font-family: x; src: local(x) }",
        r"a { background: image-set('x.png' 1x) }",
        r"a { background: image\2d set('x.png' 1x) }",
        r"a { background: -webkit-image-set('x.png' 1x) }",
        r"a { cursor: url(x.cur), auto }",
        r"@media screen { a { background: url(x) } }",
        r".a { .b { background: url(x) } }",
        r"a { b\65havior: url(x.htc) }",
        r"a { -moz-binding: url(x) }",
        r"a { width: expression(alert(1)) }",
        r"</style><script>alert(1)</script>",
        r"@namespace svg url(http://www.w3.org/2000/svg);",
        r"@page { margin: 0 }",
    ],
)
def test_the_css_check_refuses_every_way_out(css: str) -> None:
    assert csscheck.check(css), css


def test_the_css_check_passes_what_only_changes_how_things_look() -> None:
    css = (
        ".nn-prose h1 { font-size: 2em; color: var(--color-accent-500) }\n"
        "@media (max-width: 600px) { .nn-callout { border-radius: 12px } }\n"
        "@supports (display: grid) { .a > .b:hover::after { content: '→'; background: linear-gradient(red, blue) } }\n"
        "input[value^='a'] { outline: 1px solid red }\n"
    )
    assert csscheck.check(css) == []


def test_a_theme_keeps_its_callouts_beside_its_colours(people: dict[str, TestClient]) -> None:
    anna = people["anna"]
    callouts = {"recipe": {"dark": "#FF8800", "light": "#aa5500", "icon": "cooking"}, "warning": {"icon": "star"}, "todo": {}}
    made = anna.post("/api/themes", json={"name": "Kitchen", "colours": {"dark": DARK, "callouts": callouts}})
    assert made.status_code == 201, made.text
    expected = {"recipe": {"dark": "#ff8800", "light": "#aa5500", "icon": "cooking"}, "warning": {"icon": "star"}, "todo": {}}
    assert made.json()["colours"] == {"callouts": expected, "dark": DARK}
    # Thirty kinds are allowed.
    many = {f"kind-{n}": {} for n in range(30)}
    assert anna.put(f"/api/themes/{made.json()['id']}", json={"colours": {"callouts": many}}).status_code == 200
