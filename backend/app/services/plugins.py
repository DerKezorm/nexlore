"""Plugins (M7): locked up in the browser, installed and let out by the operator, switched on by each person.

**Where they come from.** The catalog in the repository (``app/catalog/``): every plugin there has its SHA-256 pinned
in ``catalog.json``, so a changed file is refused at install (and by a test before it gets that far). A file of
one's own only when the operator opened ``plugin_upload_allowed``; it runs just as locked up, but nobody checked it.

**How they run.** Each plugin gets a frame of its own (``frame``): a sandboxed document without an origin of its own
(``sandbox allow-scripts``, so no cookie, no storage of the app, no way to navigate it), whose policy allows no
connection, no picture, no font from anywhere and runs only the two scripts it was built with (by their hashes). A
plugin can do nothing but ask the page it sits in, through ``postMessage``; the page answers only what the manifest
lists under ``permissions`` (``frontend/src/plugins/host.ts``), and the server checks the right to write again.

**Where they appear** (``place``): a panel beside the note (``panel``), a code block of their language in the
reading view (``block``), or instead of the reading view for notes with a key in their front matter (``view``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Plugin, PluginUser, utcnow

logger = logging.getLogger("nexlore.plugins")

CATALOG_DIR = Path(__file__).resolve().parent.parent / "catalog"
PERMISSIONS = ("note:read", "note:write", "vault:read")
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
LANGUAGE_KEY = re.compile(r"^[a-z]{2,3}(-[A-Z]{2})?$")
BLOCK_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
#: Code blocks that mean something already: a plugin does not take them over.
RESERVED_BLOCKS = {"dataview", "dataviewjs", "tasks", "mermaid", "math", "latex", "query-results"}
MAX_CODE = 512 * 1024
MAX_MANIFEST = 64 * 1024


class PluginError(Exception):
    def __init__(self, code: str, text: str, status: int = 400) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def integrity(data: bytes) -> str:
    """``sha256-<base64>``, the way Subresource Integrity writes a hash (and the way ``catalog.json`` pins them)."""
    return "sha256-" + base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def _texts(value: Any, name: str, limit: int) -> dict[str, str]:
    if isinstance(value, str):
        value = {"en": value}
    if not isinstance(value, dict) or "en" not in value:
        raise PluginError("plugin_invalid", f"The manifest needs '{name}' with an English text.")
    out = {}
    for language, text in value.items():
        if not isinstance(language, str) or not LANGUAGE_KEY.match(language) or not isinstance(text, str):
            raise PluginError("plugin_invalid", f"'{name}' holds something that is not a text per language.")
        out[language] = text[:limit]
    return out


def check_manifest(raw: Any) -> dict[str, Any]:
    """The manifest as nexlore keeps it, or ``PluginError``: only what is known, only texts where texts belong."""
    if not isinstance(raw, dict):
        raise PluginError("plugin_invalid", "The manifest is not an object.")
    plugin_id = raw.get("id")
    if not isinstance(plugin_id, str) or not ID_PATTERN.match(plugin_id):
        raise PluginError("plugin_invalid", "The plugin's id is lower case letters, digits and '-', 2 to 32 long.")
    version = raw.get("version")
    if not isinstance(version, str) or not re.match(r"^\d{1,4}\.\d{1,4}\.\d{1,4}$", version):
        raise PluginError("plugin_invalid", "The version looks like 1.0.0.")
    permissions = raw.get("permissions", [])
    if not isinstance(permissions, list) or any(item not in PERMISSIONS for item in permissions):
        raise PluginError("plugin_invalid", "Unknown permission; known are " + ", ".join(PERMISSIONS) + ".")
    place = raw.get("place")
    if not isinstance(place, dict) or len(place) != 1:
        raise PluginError("plugin_invalid", "'place' names exactly one of panel, block or view.")
    kept_place: dict[str, Any]
    if place.get("panel") is True:
        kept_place = {"panel": True}
    elif isinstance(place.get("block"), str):
        language = place["block"]
        if not BLOCK_PATTERN.match(language) or language in RESERVED_BLOCKS:
            raise PluginError("plugin_invalid", "This code block language cannot be taken.")
        kept_place = {"block": language}
    elif isinstance(place.get("view"), dict) and isinstance(place["view"].get("frontmatter"), str):
        key = place["view"]["frontmatter"]
        if not re.match(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$", key):
            raise PluginError("plugin_invalid", "The front matter key of a view is a plain name.")
        kept_place = {"view": {"frontmatter": key}}
    else:
        raise PluginError("plugin_invalid", "'place' names exactly one of panel, block or view.")
    strings = raw.get("strings", {})
    if not isinstance(strings, dict):
        raise PluginError("plugin_invalid", "'strings' is an object per language.")
    kept_strings: dict[str, dict[str, str]] = {}
    for language, table in strings.items():
        if not isinstance(language, str) or not LANGUAGE_KEY.match(language) or not isinstance(table, dict):
            raise PluginError("plugin_invalid", "'strings' is an object per language.")
        kept_strings[language] = {
            str(key)[:64]: str(text)[:1000] for key, text in table.items() if isinstance(text, str)
        }
    kept = {
        "id": plugin_id,
        "version": version,
        "author": str(raw.get("author", ""))[:100],
        "name": _texts(raw.get("name"), "name", 100),
        "description": _texts(raw["description"], "description", 1000) if raw.get("description") else {"en": ""},
        "permissions": sorted(set(permissions)),
        "place": kept_place,
        "strings": kept_strings,
    }
    if len(json.dumps(kept, ensure_ascii=False).encode()) > MAX_MANIFEST:
        raise PluginError("plugin_invalid", "The manifest is larger than 64 KB.", 413)
    return kept


def check_code(code: bytes) -> str:
    if len(code) > MAX_CODE:
        raise PluginError("plugin_invalid", "The plugin's code is larger than 512 KB.", 413)
    try:
        text = code.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PluginError("plugin_invalid", "The plugin's code is not UTF-8.") from exc
    # Inline in its frame: a closing script tag would cut it off (and its hash would no longer match).
    if re.search(r"</script", text, re.IGNORECASE):
        raise PluginError("plugin_invalid", "The plugin's code must not contain '</script'.")
    return text


# --- The catalog ------------------------------------------------------------------------------------------------------


@dataclass
class Entry:
    manifest: dict[str, Any]
    code: str
    code_hash: str


def catalog() -> list[Entry]:
    """The plugins of the catalog whose files still have the hashes pinned in ``catalog.json``; any other is left out
    (and named in the log)."""
    listed = json.loads((CATALOG_DIR / "catalog.json").read_text(encoding="utf-8"))
    entries = []
    for item in listed["plugins"]:
        folder = CATALOG_DIR / item["id"]
        manifest_bytes = (folder / "manifest.json").read_bytes()
        code_bytes = (folder / "main.js").read_bytes()
        if integrity(manifest_bytes) != item["manifest"] or integrity(code_bytes) != item["main"]:
            logger.error("Catalog plugin does not match its pinned hash, left out plugin=%s", item["id"])
            continue
        manifest = check_manifest(json.loads(manifest_bytes.decode("utf-8")))
        entries.append(Entry(manifest=manifest, code=check_code(code_bytes), code_hash=sha256(code_bytes)))
    return entries


def from_catalog(plugin_id: str) -> Entry:
    for entry in catalog():
        if entry.manifest["id"] == plugin_id:
            return entry
    raise PluginError("not_found", "Not found.", 404)


def install(db: Session, entry: Entry, *, source: str, by: str) -> Plugin:
    """Install (or update) a plugin. A new one is not let out; an update keeps whether it was."""
    row = db.get(Plugin, entry.manifest["id"])
    if row is not None and row.source != source:
        raise PluginError("exists", "A plugin of this id is there already, from elsewhere.", 409)
    if row is None:
        row = Plugin(id=entry.manifest["id"], source=source, approved=False)
        db.add(row)
    row.version = entry.manifest["version"]
    row.manifest = entry.manifest
    row.code = entry.code
    row.code_hash = entry.code_hash
    row.installed_at = utcnow()
    row.installed_by = by
    db.commit()
    db.refresh(row)
    logger.info("Plugin installed plugin=%s version=%s source=%s", row.id, row.version, source)
    return row


def enabled_for(db: Session, plugin_id: str, account_id: int) -> Plugin | None:
    """The plugin, when it is let out and switched on by this account; else None."""
    row = db.get(Plugin, plugin_id)
    if row is None or not row.approved:
        return None
    choice = db.get(PluginUser, (plugin_id, account_id))
    return row if choice is not None and choice.enabled else None


def approved(db: Session) -> list[Plugin]:
    return list(db.scalars(select(Plugin).where(Plugin.approved.is_(True)).order_by(Plugin.id)))


# --- The frame --------------------------------------------------------------------------------------------------------

SDK = (CATALOG_DIR / "sdk.js").read_text(encoding="utf-8")
BASE_CSS = """
:root { color-scheme: dark light; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg, #e6e6ec); }
.muted { color: var(--muted, #9a9aa8); } .small { font-size: 12px; } .warn { color: var(--warn, #e0a030); }
ul { margin: 0; padding-left: 18px; } ul.plain { list-style: none; padding: 0; } li { margin: 2px 0; }
button.link { background: none; border: 0; padding: 2px 0; color: var(--accent, #2bd4bd); cursor: pointer;
  font: inherit; text-align: left; }
button.link:hover { text-decoration: underline; }
button.pill { margin-top: 8px; border: 1px solid var(--border, #33333d); background: none; color: var(--fg, #e6e6ec);
  border-radius: 999px; padding: 3px 12px; font: inherit; font-size: 12px; cursor: pointer; }
table { border-collapse: collapse; width: 100%; } th { text-align: left; font-weight: 500; font-size: 12px;
  color: var(--muted, #9a9aa8); } td, th { padding: 4px 8px 4px 0; border-top: 1px solid var(--border, #33333d); }
.board { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; }
.lane { flex: 0 0 240px; border: 1px solid var(--border, #33333d); border-radius: 14px;
  background: var(--card, #17171d);
  padding: 8px; } .lane h3 { margin: 2px 4px 8px; font-size: 14px; }
.card { display: flex; gap: 8px; align-items: flex-start; border: 1px solid var(--border, #33333d); border-radius: 10px;
  padding: 6px 8px; margin: 6px 0; background: var(--bg, #101014); cursor: grab; }
.card.done span { text-decoration: line-through; color: var(--muted, #9a9aa8); }
.card span { flex: 1; } .moves button { background: none; border: 0; color: var(--muted, #9a9aa8); cursor: pointer; }
.lane input:not([type]) { width: 100%; box-sizing: border-box; background: none;
  border: 1px dashed var(--border, #33333d);
  border-radius: 10px; color: var(--fg, #e6e6ec); padding: 6px 8px; font: inherit; }
"""


def _hash_source(text: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii") + "'"


def frame(row: Plugin) -> tuple[str, str]:
    """The frame's document and its policy. Scripts run only by their hashes; nothing may be loaded from anywhere."""
    html = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<style>{BASE_CSS}</style></head><body><div id=\"app\"></div>"
        f"<script>{SDK}</script><script>{row.code}</script></body></html>"
    )
    policy = (
        "sandbox allow-scripts; default-src 'none'; "
        f"script-src {_hash_source(SDK)} {_hash_source(row.code)}; style-src 'unsafe-inline'; "
        "img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; "
        "frame-ancestors 'self'"
    )
    return html, policy
