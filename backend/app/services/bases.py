"""Views over notes, as Obsidian's Bases: a ``.base`` file (YAML) or a ``base`` code block names filters, formulas and
views (table, cards, list, board); nexlore reads the notes of the space, keeps those the filters let through, works
out the formulas and hands back the rows of one view, sorted, grouped and limited.

A space of nexlore is a vault of Obsidian: paths in the filters start at the space's top. Expressions go through
``services/baseexpr`` only.
"""

from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import sort_key
from ..models import File, Link, Tag
from . import baseexpr, paths

VIEW_TYPES = ("table", "cards", "list", "board")
MAX_ROWS = 2000
MAX_TEXT = 100_000

DEFAULT = """filters:
  and:
    - file.inFolder("{folder}")
views:
  - type: table
    name: Table
    order:
      - file.name
      - file.mtime
"""


class BaseError(ValueError):
    pass


@dataclass
class Column:
    key: str
    label: str


@dataclass
class Result:
    views: list[dict[str, str]]
    view: int
    kind: str
    name: str
    columns: list[Column]
    group: str | None
    image: str | None
    groups: list[dict[str, Any]]
    total: int
    problems: list[str] = field(default_factory=list)


def read(text: str) -> dict[str, Any]:
    if len(text) > MAX_TEXT:
        raise BaseError("The view is too long.")
    try:
        data = yaml.safe_load(text) if text.strip() else {}
    except yaml.YAMLError as exc:
        raise BaseError("The view is no YAML nexlore can read.") from exc
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise BaseError("A view is a mapping of filters, formulas and views.")
    return data


def _filter(spec: Any, problems: list[str]) -> baseexpr.Node | None:
    """Obsidian's filter: an expression, or ``and``/``or``/``not`` over a list of them."""
    if spec is None:
        return None
    if isinstance(spec, str):
        try:
            return baseexpr.parse(spec)
        except baseexpr.ExprError as exc:
            problems.append(f"{spec}: {exc}")
            return None
    if isinstance(spec, dict) and len(spec) == 1:
        kind, items = next(iter(spec.items()))
        parts = [
            part
            for part in (_filter(item, problems) for item in (items if isinstance(items, list) else [items]))
            if part
        ]
        if kind == "not":
            return baseexpr.Node("not", items=[_chain("or", parts)]) if parts else None
        if kind in ("and", "or"):
            return _chain(kind, parts) if parts else None
    problems.append("A filter nexlore does not understand was left out.")
    return None


def _chain(kind: str, parts: list[baseexpr.Node]) -> baseexpr.Node:
    node = parts[0]
    for part in parts[1:]:
        node = baseexpr.Node(kind, items=[node, part])
    return node


def _key(key: Any) -> str:
    text = str(key).strip()
    return text if text.startswith(("file.", "note.", "formula.")) else f"note.{text}"


def _label(key: str, properties: dict[str, Any]) -> str:
    shown = properties.get(key) or properties.get(key.removeprefix("note."))
    if isinstance(shown, dict) and shown.get("displayName"):
        return str(shown["displayName"])[:80]
    return key.split(".", 1)[1] if key.startswith(("file.", "note.", "formula.")) else key


def _plain(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, list):
        return [_plain(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, baseexpr._Scope):
        return None
    return value


def _front(front: Any) -> dict[str, Any]:
    if not isinstance(front, dict):
        return {}
    return {str(key): (baseexpr.as_date(value) if isinstance(value, date) else value) for key, value in front.items()}


def _folder_limit(node: baseexpr.Node) -> str | None:
    """A folder every note of the view must lie in: ``file.inFolder("x")`` alone or in an ``and`` chain. Only to read
    fewer notes; the filter itself still decides."""
    if node.kind == "and":
        for item in node.items:
            found = _folder_limit(item)
            if found:
                return found
        return None
    if (
        node.kind == "method"
        and node.value == "inFolder"
        and len(node.items) == 2
        and node.items[0].kind == "name"
        and node.items[0].value == "file"
        and node.items[1].kind == "lit"
        and isinstance(node.items[1].value, str)
    ):
        return node.items[1].value.strip("/") or None
    return None


def _like_prefix(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"


def _rows(
    db: Session,
    space_id: int,
    space_name: str,
    formulas: dict[str, baseexpr.Node],
    *,
    folder: str | None = None,
    want_tags: bool = True,
    want_links: bool = True,
) -> list[tuple[Any, baseexpr.Row]]:
    """The notes of the space as the expressions see them. Only the columns needed, only below ``folder`` when a
    filter demands it, and tags or links only when the view mentions them (a space of 33,000 notes has some 260,000
    links)."""
    query = select(File.id, File.path, File.title, File.size, File.mtime_ns, File.front).where(
        File.space_id == space_id, File.is_note.is_(True), File.deleted_at.is_(None)
    )
    if folder:
        query = query.where(File.path_key.like(_like_prefix(paths.fold(f"{space_name}/{folder}")), escape="\\"))
    files = db.execute(query).all()
    ids = [file.id for file in files]
    tags: dict[int, list[str]] = {}
    links: dict[int, list[str]] = {}
    for start in range(0, len(ids), 900):
        part = ids[start : start + 900]
        if want_tags:
            for file_id, tag in db.execute(
                select(Tag.file_id, Tag.tag).where(Tag.file_id.in_(part)).order_by(Tag.pos)
            ):
                tags.setdefault(file_id, []).append(tag)
        if want_links:
            for file_id, target in db.execute(select(Link.source_id, Link.target).where(Link.source_id.in_(part))):
                links.setdefault(file_id, []).append(target)
    out = []
    for file in files:
        inside = file.path[len(space_name) + 1 :]
        out.append(
            (
                file,
                baseexpr.Row(
                    name=paths.stem(file.path),
                    path=inside,
                    folder=posixpath.dirname(inside),
                    size=file.size,
                    mtime=datetime.fromtimestamp(file.mtime_ns / 1e9, UTC),
                    tags=tags.get(file.id, []),
                    links=links.get(file.id, []),
                    front=_front(file.front),
                    formulas=formulas,
                ),
            )
        )
    return out


def _sort_value(value: Any) -> tuple[int, Any]:
    if value is None or value == "" or value == []:
        return (2, "")
    if isinstance(value, bool):
        return (0, float(value))
    if isinstance(value, int | float):
        return (0, float(value))
    if isinstance(value, datetime):
        return (0, value.timestamp())
    return (1, sort_key(str(value)))


def run(db: Session, config: dict[str, Any], space_id: int, space_name: str, view_index: int = 0) -> Result:
    problems: list[str] = []
    views = [view for view in config.get("views") or [] if isinstance(view, dict)] or [
        {"type": "table", "name": "Table"}
    ]
    view_index = max(0, min(view_index, len(views) - 1))
    view = views[view_index]
    kind = str(view.get("type") or "table").lower()
    kind = {"kanban": "board", "gallery": "cards"}.get(kind, kind)
    if kind not in VIEW_TYPES:
        problems.append(f"The view type {kind!r} is shown as a table.")
        kind = "table"
    properties = config.get("properties") if isinstance(config.get("properties"), dict) else {}
    formulas: dict[str, baseexpr.Node] = {}
    for name, text in (config.get("formulas") or {}).items() if isinstance(config.get("formulas"), dict) else []:
        try:
            formulas[str(name)] = baseexpr.parse(str(text))
        except baseexpr.ExprError as exc:
            problems.append(f"formula.{name}: {exc}")
    wanted = [
        node for node in (_filter(config.get("filters"), problems), _filter(view.get("filters"), problems)) if node
    ]
    order = [_key(key) for key in (view.get("order") or []) if key] or ["file.name"]
    columns = [Column(key=key, label=_label(key, properties)) for key in order]
    group_spec = view.get("groupBy")
    group = _key(group_spec.get("property")) if isinstance(group_spec, dict) and group_spec.get("property") else None
    if group is None and kind == "board":
        group = next((key for key in order if key.startswith("note.")), None)
    image = _key(view["image"]) if view.get("image") else None
    parsed: dict[str, baseexpr.Node] = {}
    for key in {*order, *(k for k in (group, image) if k)}:
        try:
            parsed[key] = baseexpr.parse(key)
        except baseexpr.ExprError as exc:
            problems.append(f"{key}: {exc}")
    rows = []
    failed = 0
    # Whatever the view never names need not be read: "tag" and "link" anywhere in it (a superset, never too little).
    said = json.dumps(config, ensure_ascii=False, default=str).casefold()
    folder = next((found for found in map(_folder_limit, wanted) if found), None)
    for file, row in _rows(
        db, space_id, space_name, formulas, folder=folder, want_tags="tag" in said, want_links="link" in said
    ):
        try:
            if not all(baseexpr.truthy(baseexpr.evaluate(node, row)) for node in wanted):
                continue
            cells = {key: _plain(baseexpr.evaluate(node, row)) for key, node in parsed.items()}
        except (baseexpr.ExprError, RecursionError, ValueError, TypeError, OverflowError):
            failed += 1
            continue
        sort_cells = {key: baseexpr.evaluate(node, row) for key, node in parsed.items()}
        rows.append(
            {"path": file.path, "title": file.title or row.name, "cells": cells, "_sort": sort_cells, "_row": row}
        )
    if failed:
        problems.append(f"{failed} notes could not be worked out and are left out.")
    # By name first: without a sort the order is the names', and a sort keeps it among equal values.
    rows.sort(key=lambda item: (sort_key(item["title"]), item["path"]))
    for spec in reversed([item for item in (view.get("sort") or []) if isinstance(item, dict)]):
        key = _key(spec.get("property") or "file.name")
        if key not in parsed:
            try:
                parsed[key] = baseexpr.parse(key)
            except baseexpr.ExprError:
                continue
            for item in rows:
                item["_sort"][key] = baseexpr.evaluate(parsed[key], item["_row"])
        descending = str(spec.get("direction") or "ASC").upper() == "DESC"
        rows.sort(key=lambda item, k=key: _sort_value(item["_sort"].get(k)), reverse=descending)
        if descending:
            # Empty values last either way.
            rows.sort(key=lambda item, k=key: _sort_value(item["_sort"].get(k))[0] == 2)
    total = len(rows)
    limit = view.get("limit")
    cap = min(int(limit), MAX_ROWS) if isinstance(limit, int) and limit > 0 else MAX_ROWS
    rows = rows[:cap]
    groups: list[dict[str, Any]] = []
    if group:
        seen: dict[str, dict[str, Any]] = {}
        for item in rows:
            value = item["cells"].get(group)
            label = ", ".join(map(str, value)) if isinstance(value, list) else ("" if value is None else str(value))
            if label not in seen:
                seen[label] = {"value": label, "rows": []}
                groups.append(seen[label])
            seen[label]["rows"].append(item)
        direction = group_spec.get("direction") if isinstance(group_spec, dict) else None
        groups.sort(
            key=lambda entry: (entry["value"] == "", sort_key(entry["value"])),
            reverse=str(direction).upper() == "DESC",
        )
    else:
        groups = [{"value": None, "rows": rows}]
    for entry in groups:
        entry["rows"] = [
            {"path": item["path"], "title": item["title"], "cells": item["cells"]} for item in entry["rows"]
        ]
    return Result(
        views=[
            {"name": str(v.get("name") or f"View {i + 1}"), "type": str(v.get("type") or "table")}
            for i, v in enumerate(views)
        ],
        view=view_index,
        kind=kind,
        name=str(view.get("name") or ""),
        columns=columns,
        group=group,
        image=image,
        groups=groups,
        total=total,
        problems=problems,
    )
