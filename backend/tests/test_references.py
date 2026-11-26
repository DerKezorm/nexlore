"""Plan E39 and E46: what nexlore says about its own settings points at the places and words of today, written as
the plan writes a place: group › area › card, never with arrows or commas between the parts. The area "KI, API und
Plugins" is gone (AI provider, General › Interfaces, Plugins), API tokens are API keys, "Sicherung" is "Speicher und
Sicherung", "Mailserver" is "Mail", "Plugins für mich" is the area "Plugins". Read: the words of the interface, the
guide, the places ("where") of every "What's new", README and the docs. The bodies of older "What's new" entries tell
what happened then and stay as they were."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
OLD = (
    "KI, API und Plugins", "AI, API and plugins", "AI and plugins", "API-Token", "API token",
    "Server → Sicherung", "Server → Backups", "Server, Backups", "Settings, Backups", "Server, Sicherung",
    "Server → Mailserver", "Server → Mail server", "Mein Konto → Plugins für mich", "My account → Plugins for me",
    "/settings/extensions", "Verbindungen › KI in Notizen", "Connections › AI in notes",
)


def _strings(tree: object) -> list[str]:
    if isinstance(tree, dict):
        return [text for value in tree.values() for text in _strings(value)]
    if isinstance(tree, list):
        return [text for value in tree for text in _strings(value)]
    return [tree] if isinstance(tree, str) else []


def _texts() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for language in ("de", "en"):
        words = json.loads((ROOT / "frontend/src/i18n" / f"{language}.json").read_text(encoding="utf-8"))
        found[f"i18n/{language}.json"] = _strings(words)
        news = json.loads((ROOT / "frontend/src/i18n/whatsnew" / f"{language}.json").read_text(encoding="utf-8"))
        found[f"whatsnew/{language}.json (where)"] = [
            section["where"] for entry in news.values() for section in entry.get("sections", [])
        ]
        for note in sorted((ROOT / "backend/app/guide" / language).glob("*.md")):
            found[f"guide/{language}/{note.name}"] = [note.read_text(encoding="utf-8")]
    for name in ("README.md", "docs/api.md", "docs/mcp.md", "docs/plugins.md"):
        found[name] = [(ROOT / name).read_text(encoding="utf-8")]
    return found


def test_the_texts_are_all_there() -> None:
    texts = _texts()
    assert len([name for name in texts if name.startswith("guide/")]) >= 20
    assert all(texts.values())


#: Plan E46: a place is "Mein Konto › Verbindungen › API-Schlüssel", "Server › Allgemein › Schnittstellen".
SEPARATORS = (
    re.compile(r"\S → \S"),
    re.compile(r"(Einstellungen|Settings|Mein Konto|My account|Kontomenü|Account menu|Server), (Server|Mein Konto|My account|"
               r"Allgemein|General|Anmeldung|Sign-in|Konten|Accounts|Verbindungen|Connections|Sicherheit|Security|"
               r"Profil|Profile|Benachrichtigungen|Notifications|Bereiche|Spaces|Plugins|Mail|KI|AI|Speicher|Storage)\b"),
    re.compile(r", (Karte|card) [„“\"]"),
)


@pytest.mark.parametrize("rule", SEPARATORS, ids=["arrow", "comma", "card"])
def test_every_place_is_written_with_the_plans_separator(rule: re.Pattern[str]) -> None:
    hits = [name for name, values in _texts().items() if any(rule.search(value) for value in values)]
    assert hits == [], f"{rule.pattern!r} still in {hits}"


def test_the_places_begin_with_their_group() -> None:
    texts = _texts()
    words = "\n".join(texts["i18n/de.json"] + texts["i18n/en.json"])
    # KI under Mein Konto since the shared module ki 0.1.0 (E61).
    for place in ("Mein Konto › KI", "Server › Allgemein › Schnittstellen", "Server › KI-Anbieter",
                  "My account › AI", "Server › General › Interfaces", "Server › AI provider"):
        assert place in words, place
    assert "Einstellungen › " not in words and "Settings › " not in words


@pytest.mark.parametrize("old", OLD)
def test_no_text_points_to_a_place_or_word_of_before(old: str) -> None:
    hits = [name for name, values in _texts().items() if any(old in value for value in values)]
    assert hits == [], f"{old!r} still in {hits}"


def test_the_new_places_are_named() -> None:
    texts = _texts()
    guide = "\n".join(texts["guide/de/11 KI.md"] + texts["guide/en/11 AI.md"])
    for place in ("Mein Konto › Verbindungen › API-Schlüssel", "My account › Connections › API keys",
                  "Einstellungen › Server › KI-Anbieter", "Settings › Server › AI provider",
                  "Mein Konto › Verbindungen › KI-Werkzeuge (MCP)", "My account › Connections › AI tools (MCP)"):
        assert place in guide, place
    backups = texts["guide/de/12 Sicherung und Umzug.md"][0] + texts["guide/en/12 Backups and moving in.md"][0]
    assert "Server › Speicher und Sicherung" in backups and "Server › Storage and backups" in backups
