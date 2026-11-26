"""The names of nexlore 1.16.0 in the API's description stay (plan E53): every way of before keeps its operationId,
its summary and the schema of its body and answer, and every schema of before is still there, and every path parameter keeps its type, pattern and length (the backup
names of ``/api/backups/{name}``: pattern and 64), so that a generated client or a snapshot notices nothing. New ways and new schemas may come. ``fixtures/openapi-names-1.16.0.json`` holds
the names of the branch konten (``app.openapi()`` there); the description itself is published only with
NEXLORE_API_DOCS, the test reads ``app.openapi()``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.main import app

BEFORE = json.loads((Path(__file__).parent / "fixtures" / "openapi-names-1.16.0.json").read_text(encoding="utf-8"))

#: Summaries that changed because what the way does changed (E53/1: so they stay, named to the orchestrator).
CHANGED_WITH_THE_BEHAVIOUR = {
    # Deleting keeps the account 30 days to bring it back (konten 1.1.0).
    "DELETE /api/accounts/{account_id}": "Delete an account (30 days to bring it back)",
    # Several operators may be (konten 1.1.0).
    "PUT /api/accounts/{account_id}/role": "Make an account operator or member (several operators may be)",
    # A lock can be lifted again (schluessel 1.0.0), so it is no longer "for good".
    "POST /api/admin/api-tokens/{token_id}/block": "Block a token (operator); its account sees it blocked",
}


def _ref(schema: dict[str, Any] | None) -> str | None:
    if not schema:
        return None
    found = schema.get("$ref") or next((item["$ref"] for item in schema.get("anyOf", []) if "$ref" in item), None)
    if found:
        return str(found).rsplit("/", 1)[-1]
    items = schema.get("items")
    if schema.get("type") == "array" and isinstance(items, dict) and items.get("$ref"):
        return "array of " + str(items["$ref"]).rsplit("/", 1)[-1]
    return None


#: What a path parameter's schema says about the values it takes.
LIMITS = ("type", "pattern", "maxLength", "minLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum")


def _path(operation: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        parameter["name"]: {key: parameter.get("schema", {})[key] for key in LIMITS if key in parameter.get("schema", {})}
        for parameter in operation.get("parameters", [])
        if parameter.get("in") == "path"
    }


def _names() -> dict[str, dict[str, Any]]:
    described = app.openapi()
    names = {}
    for path, methods in described["paths"].items():
        for method, operation in methods.items():
            body = operation.get("requestBody", {}).get("content", {})
            answer = operation.get("responses", {}).get("200", {}).get("content", {}).get("application/json", {})
            names[f"{method.upper()} {path}"] = {
                "operationId": operation.get("operationId"),
                "summary": operation.get("summary"),
                "body": _ref(next(iter(body.values()), {}).get("schema")) if body else None,
                "answer": _ref(answer.get("schema")),
                "path": _path(operation),
            }
    return names


def test_the_names_of_before_are_all_there() -> None:
    assert len(BEFORE["operations"]) > 300 and len(BEFORE["schemas"]) > 200


def test_every_way_of_before_keeps_its_names() -> None:
    now = _names()
    wrong = []
    for way, before in BEFORE["operations"].items():
        found = now.get(way)
        if found is None:
            wrong.append(f"{way}: gone")
            continue
        expected = {**before, "summary": CHANGED_WITH_THE_BEHAVIOUR.get(way, before["summary"])}
        wrong += [f"{way}: {key} {expected[key]!r} -> {found[key]!r}" for key in expected if found[key] != expected[key]]
    assert wrong == []


def test_every_schema_of_before_is_still_there() -> None:
    schemas = set(app.openapi()["components"]["schemas"])
    assert [name for name in BEFORE["schemas"] if name not in schemas] == []
