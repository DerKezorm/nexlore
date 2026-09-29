"""Search snippets read as text: no stars, brackets or hashes of Markdown, the hit marks stay."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services import index
from app.services.snippets import plain

S, E = "\x02", "\x03"


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        (f"Der Reiter **{S}Graph{E}** zeigt alles", f"Der Reiter {S}Graph{E} zeigt alles"),
        (f"*kursiv* und _auch_ und =={S}hell{E}== und ~~weg~~", f"kursiv und auch und {S}hell{E} und weg"),
        (f"Siehe [[Ordner/{S}Plan{E}.md|den Plan]] und [[Idee#Kopf]]", "Siehe den Plan und Idee › Kopf"),
        (f"Bild ![[foto.png]] und [Seite](https://example.com/{S}x{E})", "Bild foto.png und Seite"),
        (f"# Titel\n> [!note] Hinweis\n- [ ] {S}Aufgabe{E}\n1. eins", f"Titel Hinweis {S}Aufgabe{E} eins"),
        ("`code` und %%leise%%", "code und leise"),
        # Stars that are no emphasis stay: arithmetic, a lone star, snake_case.
        ("a * b = c und 2*3*4 und my_var_name", "a * b = c und 2*3*4 und my_var_name"),
        # Cut in the middle of a construct: what is left is text.
        (f"…](https://example.com) weiter {S}hier{E}", f"…](https://example.com) weiter {S}hier{E}"),
    ],
)
def test_plain_takes_the_marks_of_markdown_away(raw: str, shown: str) -> None:
    assert plain(raw) == shown


def test_the_search_route_answers_with_plain_snippets(client: TestClient, vault: Path, account: str) -> None:
    (vault / "Work").mkdir()
    (vault / "Work" / "Guide.md").write_bytes(b"The tab **Graph** shows [[Map|the map]].")
    index.scan()
    hits = client.get("/api/search", params={"q": "graph"}).json()
    assert [hit["snippet"] for hit in hits] == [f"The tab {S}Graph{E} shows the map."]
