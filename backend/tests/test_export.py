"""A note or a folder as PDF: set by Typst on the server, with the rights of the reader. Nothing a note says may run
as Typst code, nothing from a space the reader may not read reaches the paper, and links lead inside the PDF only
to notes that are in it."""

from __future__ import annotations

import base64
import io
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader

from app.services import typeset

from .conftest import join, make_account, sign_in
from .test_lore import note


@pytest.fixture(autouse=True)
def inline() -> Iterator[None]:
    typeset.INLINE = True
    yield
    typeset.INLINE = False


def person(name: str) -> TestClient:
    from app.main import app

    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name}0000"})
    sign_in(client, make_account(name))
    return client


class World:
    def __init__(self) -> None:
        self.anna = person("anna")
        self.bob = person("bob")


@pytest.fixture
def world(client: TestClient, account: object, vault: Path) -> World:
    w = World()
    for name in ("Wissen", "Privat"):
        assert w.anna.post("/api/spaces", json={"name": name}).status_code == 201
    assert w.anna.post("/api/folders", json={"parent": "Wissen", "name": "Homelab"}).status_code == 201
    note(w.anna, "Wissen/Homelab", "Backup-Strategie", STRATEGY)
    note(w.anna, "Wissen/Homelab", "ZFS-Pool", "# ZFS-Pool\n\nZwei Spiegel aus je zwei Platten.\n\n## Snapshots\n\nStündlich.\n")
    note(w.anna, "Privat", "Gehalt", "Das Gehalt steht hier: 4711 Euro.\n")
    join(w.anna, "Wissen", "bob", "read")
    return w


STRATEGY = """---
tags: [backup, homelab]
status: in Betrieb
---
Alles Wichtige gibt es dreimal. Die Regel steht im [Handbuch](https://backup.example.com/regel).

> [!tip] Das eine, was man sich merken muss
> Ein Backup ohne Restore ist eine Hoffnung.

## Wo die Platten stecken

Siehe [[ZFS-Pool]] und ==markiert== und %%geheime Randnotiz%% und $a^2 + b^2$.

![[ZFS-Pool#Snapshots]]

![[Privat/Gehalt]]

- [x] Bericht prüfen
- [ ] Restore testen

| Was | Wohin |
|:---|---:|
| VMs | ZFS |

```python
print("hallo")
```

Eine Fußnote[^1].

[^1]: Steht unten.
"""


def pdf(client: TestClient, **body: object) -> bytes:
    answer = client.post("/api/export/pdf", json=body)
    assert answer.status_code == 200, answer.text
    assert answer.headers["content-type"] == "application/pdf"
    assert answer.content.startswith(b"%PDF")
    return answer.content


def text_of(data: bytes) -> str:
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages)


def flat(text: str) -> str:
    return " ".join(text.split())


def test_a_note_comes_as_a_pdf_with_its_title_text_properties_and_page_numbers(world: World) -> None:
    data = pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md", options={"language": "de"})
    text = flat(text_of(data))
    assert "Backup-Strategie" in text
    assert "Alles Wichtige gibt es dreimal." in text
    assert "in Betrieb" in text  # the properties box
    assert "Das eine, was man sich merken muss" in text  # the callout's title
    assert "Ein Backup ohne Restore ist eine Hoffnung." in text
    assert "Seite 1 von" in text
    assert "Wissen › Homelab" in text  # the header
    assert "geheime Randnotiz" not in text  # %%comments%% stay at home
    assert "Steht unten." in text  # the footnote
    assert 'print("hallo")' in text


def test_the_download_is_named_after_the_note(world: World) -> None:
    answer = world.anna.post("/api/export/pdf", json={"path": "Wissen/Homelab/Backup-Strategie.md"})
    assert "filename*=UTF-8''Backup-Strategie.pdf" in answer.headers["content-disposition"]


def test_nothing_a_note_says_runs_as_typst_code(world: World) -> None:
    hostile = (
        '#read("/etc/passwd") #import "@preview/x:1.0.0": * ] ) " \\ #{panic("x")} '
        '`#eval("1")` $#panic("y")$ [[#"q"]] <label> @ref *a*\n\n```\n"#panic()\n```\n'
    )
    note(world.anna, "Wissen", "Feindlich", hostile)
    text = flat(text_of(pdf(world.anna, path="Wissen/Feindlich.md")))
    assert '#read("/etc/passwd")' in text
    assert '#{panic("x")}' in text
    assert "@ref" in text


def test_the_reader_s_rights_decide_what_is_embedded(world: World) -> None:
    anna = flat(text_of(pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md")))
    bob = flat(text_of(pdf(world.bob, path="Wissen/Homelab/Backup-Strategie.md")))
    assert "4711" in anna  # her own private space
    assert "4711" not in bob  # bob may not read Privat: the embed is as if there were no such note
    assert "Stündlich." in bob  # a part of a note he may read


def test_a_note_in_a_space_one_may_not_read_answers_like_one_that_does_not_exist(world: World) -> None:
    hidden = world.bob.post("/api/export/pdf", json={"path": "Privat/Gehalt.md"})
    missing = world.bob.post("/api/export/pdf", json={"path": "Privat/Nichts.md"})
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json()["detail"] == missing.json()["detail"]
    folder = world.bob.post("/api/export/pdf", json={"folder": "Privat"})
    assert folder.status_code == 404


def test_embeds_can_stay_names(world: World) -> None:
    text = flat(text_of(pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md", options={"embeds": False})))
    assert "Stündlich." not in text
    assert "4711" not in text


def test_a_web_link_gets_its_address_as_a_footnote_unless_asked_otherwise(world: World) -> None:
    with_note = flat(text_of(pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md")))
    plain = flat(text_of(pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md", options={"links": "text"})))
    assert "https://backup.example.com/regel" in with_note
    assert "https://backup.example.com/regel" not in plain


def inner_links_on(data: bytes, words: str) -> int:
    """How many links inside the PDF stand on the page that holds ``words``."""
    for page in PdfReader(io.BytesIO(data)).pages:
        if words in (page.extract_text() or ""):
            count = 0
            for annotation in page.get("/Annots") or []:
                item = annotation.get_object()
                action = item.get("/A")
                count += action is None or "/URI" not in action
            return count
    raise AssertionError(f"no page holds {words!r}")


def test_a_folder_comes_as_one_pdf_with_contents_and_links_between_its_notes(world: World) -> None:
    data = pdf(world.anna, folder="Wissen/Homelab", options={"language": "de"})
    text = flat(text_of(data))
    assert "Inhalt" in text
    assert text.index("Backup-Strategie") < text.index("ZFS-Pool")
    assert "2 Notizen" in text
    # [[ZFS-Pool]] leads to its page; in the PDF of the note alone it is only words. Footnotes are links inside
    # the PDF too, so the page of the note is counted in both.
    alone = pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md")
    assert inner_links_on(data, "Alles Wichtige") == inner_links_on(alone, "Alles Wichtige") + 1


def test_a_folder_pdf_takes_only_the_notes_ticked(world: World) -> None:
    data = pdf(world.anna, folder="Wissen/Homelab", only=["Wissen/Homelab/ZFS-Pool.md"])
    text = flat(text_of(data))
    assert "Zwei Spiegel" in text
    assert "Alles Wichtige" not in text


def test_a_picture_the_reader_may_see_is_in_the_pdf(world: World) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (80, 40), (13, 148, 136)).save(buffer, "PNG")
    note(world.anna, "Wissen", "Bild", "Hier ein Bild:\n\n![[foto.png]]\n\nUnd aus dem Netz: ![x](https://example.com/a.png)\n")
    up = world.anna.post(
        "/api/attachments", params={"note": "Wissen/Bild.md", "name": "foto.png"}, content=buffer.getvalue()
    )
    assert up.status_code in (200, 201), up.text
    data = pdf(world.anna, path="Wissen/Bild.md")
    images = [image for page in PdfReader(io.BytesIO(data)).pages for image in page.images]
    assert len(images) == 1


def test_the_preview_shows_the_pages_as_pictures(world: World) -> None:
    answer = world.anna.post("/api/export/preview", json={"path": "Wissen/Homelab/Backup-Strategie.md"})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["pages"] and body["more_notes"] == 0
    first = Image.open(io.BytesIO(base64.b64decode(body["pages"][0])))
    assert first.format == "PNG" and first.height > first.width


def test_the_preview_of_a_big_folder_sets_only_the_first_notes(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(typeset, "PREVIEW_NOTES", 1)
    answer = world.anna.post("/api/export/preview", json={"folder": "Wissen/Homelab"})
    assert answer.json()["more_notes"] == 1


def test_too_many_notes_are_refused(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(typeset, "MAX_NOTES", 1)
    answer = world.anna.post("/api/export/pdf", json={"folder": "Wissen/Homelab"})
    assert answer.status_code == 413
    assert answer.json()["detail"]["code"] == "too_many_notes"


def test_a_note_or_a_folder_never_both(world: World) -> None:
    both = world.anna.post("/api/export/pdf", json={"path": "Wissen/Homelab/ZFS-Pool.md", "folder": "Wissen"})
    neither = world.anna.post("/api/export/pdf", json={})
    assert both.status_code == neither.status_code == 422


def test_typst_runs_in_a_process_of_its_own(world: World) -> None:
    typeset.INLINE = False
    data = pdf(world.anna, path="Wissen/Homelab/ZFS-Pool.md")
    assert "Zwei Spiegel" in flat(text_of(data))


def test_typst_reads_nothing_outside_its_folder(tmp_path: Path) -> None:
    (tmp_path / "secret.txt").write_text("geheim", encoding="utf-8")
    root = tmp_path / "root"
    root.mkdir()
    main = root / "main.typ"
    main.write_text('#read("../secret.txt")', encoding="utf-8")
    with pytest.raises(typeset.TypesetFailed):
        typeset.compile_here(main, fonts=typeset.FONTS, packages=typeset.PACKAGES, fmt="pdf", ppi=48)


def test_a_string_for_typst_cannot_end_early() -> None:
    assert typeset.string('a"b\\c\n') == '"a\\"b\\\\c\\n"'
    assert typeset.string("\x00") == '"\\u{0}"'


def test_a_comment_leaves_one_blank_and_its_line_breaks() -> None:
    assert typeset._without_comments("und %%still%% und")[0] == "und und"
    assert typeset._without_comments("eins %%zwei\n\ndrei%% vier")[0] == "eins \n\nvier"


def test_a_folder_pdf_has_a_bare_cover_and_no_title_twice(world: World) -> None:
    data = pdf(world.anna, folder="Wissen/Homelab", options={"language": "de"})
    pages = [page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages]
    assert "Seite" not in pages[0]  # the cover has neither header nor footer
    assert "Seite 2 von" in pages[1]
    # The note "ZFS-Pool" begins with "# ZFS-Pool": the contents name it once.
    assert pages[1].count("ZFS-Pool") == 1


def test_a_footnote_of_one_paragraph_stands_next_to_its_number(world: World) -> None:
    text = text_of(pdf(world.anna, path="Wissen/Homelab/Backup-Strategie.md"))
    assert any(line.strip().endswith("Steht unten.") and len(line.strip()) > len("Steht unten.") for line in text.splitlines())


def test_the_notes_of_a_folder_come_in_the_order_of_the_pdf(world: World) -> None:
    note(world.anna, "Wissen", "Oben", "x")
    answer = world.anna.get("/api/export/notes", params={"folder": "Wissen"})
    assert answer.json()["notes"] == [
        "Wissen/Homelab/Backup-Strategie.md", "Wissen/Homelab/ZFS-Pool.md", "Wissen/Oben.md",
    ]
    assert world.bob.get("/api/export/notes", params={"folder": "Privat"}).status_code == 404


def test_a_pdf_knows_the_pages_its_notes_link(world: World) -> None:
    data = pdf(world.anna, path="Wissen/Homelab/ZFS-Pool.md")
    note(world.anna, "Wissen", "Lesen", "Siehe [[Handbuch.pdf#page=3]] und ![[Handbuch.pdf#page=5&height=300]] und [[Handbuch.pdf]].\n")
    up = world.anna.post("/api/attachments", params={"note": "Wissen/Lesen.md", "name": "Handbuch.pdf"}, content=data)
    assert up.status_code in (200, 201), up.text
    links = world.anna.get("/api/links", params={"path": up.json()["path"]}).json()
    assert sorted(link["subpath"] for link in links["backlinks"]) == ["", "page=3", "page=5&height=300"]


def test_an_embedded_note_shows_its_own_embeds_only_as_names(world: World) -> None:
    note(world.anna, "Wissen", "Mitte", "Die Mitte.\n\n![[Tief]]\n")
    note(world.anna, "Wissen", "Tief", "Ganz unten steht Tiefseetext.\n")
    note(world.anna, "Wissen", "Oben", "Oben.\n\n![[Mitte]]\n")
    text = flat(text_of(pdf(world.anna, path="Wissen/Oben.md")))
    assert "Die Mitte." in text
    # One level deep, like the reading view: the embed inside the embed stays its name.
    assert "Tiefseetext" not in text and "Tief" in text
