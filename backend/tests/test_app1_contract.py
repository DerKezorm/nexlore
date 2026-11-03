"""The guards over ``/api/app/1``, the surface of the own iPhone app.

The app in the App Store and the servers out there are never updated at the same time. A renamed field nobody notices
in the browser stops every app already on its way.

When a change is really meant, the imprint is made anew: delete ``app1_contract.json`` and run this file. Adding a
field is allowed; taking one away needs ``/api/app/2`` beside it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.main import ROUTERS, app
from app.routers.app1 import PROMISED

IMPRINT = Path(__file__).with_name("app1_contract.json")
PREFIX = "/api/app/1"


def _paths() -> set[str]:
    """Every address the app serves under the prefix, from the routers it includes."""
    return {route.path for module in ROUTERS for route in module.router.routes
            if getattr(route, "path", "").startswith(PREFIX)}


def _fields(schema: dict[str, Any], parts: dict[str, Any], before: str = "", seen: tuple[str, ...] = ()) -> set[str]:
    """Every field name of an answer, nested with a dot."""
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        if name in seen:
            return set()
        return _fields(parts[name], parts, before, (*seen, name))
    for kind in ("anyOf", "oneOf", "allOf"):
        if kind in schema:
            out: set[str] = set()
            for part in schema[kind]:
                out |= _fields(part, parts, before, seen)
            return out
    if schema.get("type") == "array":
        return _fields(schema.get("items", {}), parts, before, seen)
    out = set()
    for name, part in schema.get("properties", {}).items():
        path = f"{before}{name}"
        out.add(path)
        out |= _fields(part, parts, f"{path}.", seen)
    return out


def _fields_per_route() -> dict[str, list[str]]:
    described = app.openapi()
    parts = described.get("components", {}).get("schemas", {})
    out: dict[str, list[str]] = {}
    for path, ways in described["paths"].items():
        if not path.startswith(PREFIX):
            continue
        for method, way in ways.items():
            fields: set[str] = set()
            for status, answer in way.get("responses", {}).items():
                if status.startswith("2"):
                    schema = answer.get("content", {}).get("application/json", {}).get("schema", {})
                    fields |= _fields(schema, parts)
            out[f"{method.upper()} {path}"] = sorted(fields)
    return out


def test_the_surface_is_exactly_the_promised_one() -> None:
    there = _paths()
    promised = set(PROMISED)
    assert there - promised == set(), f"Not in PROMISED: {sorted(there - promised)}"
    assert promised - there == set(), f"Promised but not reachable: {sorted(promised - there)}"


def test_every_promised_address_has_an_answer_shape() -> None:
    """Without one there would be nothing to keep, and the imprint would be empty. Only addresses that answer with a
    status or a file go without."""
    without = {key for key, fields in _fields_per_route().items() if not fields}
    assert without <= {"DELETE /api/app/1/device", "GET /api/app/1/files/{file_id}"}, sorted(without)


def test_the_answer_shape_stays() -> None:
    now = _fields_per_route()
    if not IMPRINT.exists():
        IMPRINT.write_text(json.dumps(now, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    before: dict[str, list[str]] = json.loads(IMPRINT.read_text(encoding="utf-8"))
    vanished: dict[str, list[str]] = {}
    for key, fields in before.items():
        if key not in now:
            vanished[key] = ["(the whole address)"]
            continue
        missing = [field for field in fields if field not in now[key]]
        if missing:
            vanished[key] = missing
    assert not vanished, (
        "Fields vanished from an answer of the app's surface:\n"
        + "\n".join(f"  {key}: {', '.join(fields)}" for key, fields in sorted(vanished.items()))
        + "\n\n/api/app/1 is a promise. The field stays, or it needs /api/app/2."
    )


def test_the_imprint_really_measures_something() -> None:
    """An empty imprint would pass quietly. It must carry the core fields of the contract."""
    before = json.loads(IMPRINT.read_text(encoding="utf-8"))
    assert {"version", "account.username", "device.id", "spaces.role", "features"} <= set(before["GET /api/app/1/me"])
    assert {"key", "account.id", "account.name"} <= set(before["POST /api/app/1/pairing/{pairing_id}/key"])
    assert {"cursor", "more", "spaces.id", "items.id", "items.space", "items.path", "items.kind", "items.hash",
            "items.size", "items.mtime", "items.deleted"} <= set(before["GET /api/app/1/changes"])
    assert {"results.op_id", "results.ok", "results.code", "results.touched", "cursor"} <= set(
        before["POST /api/app/1/batch"])
    assert {"notes.text", "missing"} <= set(before["POST /api/app/1/fetch"])
    assert {"hash", "text"} <= set(before["GET /api/app/1/notes/{file_id}/base"])
    assert len(before) >= len(PROMISED)
