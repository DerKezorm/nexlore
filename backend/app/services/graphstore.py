"""The graph of every space, worked out on the server and kept in the database.

For each space and each cloud (``folders``, ``tags``, ``topics``) the notes are grouped into nested circles
(``graphlayout``) and stored: ``graph_groups`` for the circles, ``graph_nodes`` for the notes. The browser then loads
the circles of a space once and the notes only for the part of the map it shows (``tiles``).

The map stays calm. A new, moved or deleted note changes only its own place: it takes a free spot in its group,
without moving anything else (``refresh``). A full layout runs the first time, when much changed at once, and at
night after a day with changes; it starts from the old positions, so the map stays recognisable (``build``).

Changes are noticed on the database connection itself: every write to ``files``, ``links`` or ``tags`` counts up
``changes()``. One worker thread does the work, one job after the other; small spaces are done at once, inside the
request, so the graph is there on the first look.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import delete, event, func, insert, select, text, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal, engine
from ..models import File, GraphGroup, GraphNode, GraphState, Link, Setting, Space, Tag, utcnow
from . import graphlayout as gl
from . import paths

logger = logging.getLogger("nexlore.graph")

CLOUDS = ("folders", "tags", "topics")
#: Radius on screen, in pixels, at which a group starts to open. The interface uses the same number.
OPEN_FROM = 80.0
PALETTE = 10
#: Spaces up to this size get their graph at once, inside the request; bigger ones in the background.
INLINE_NOTES = 3000
#: More new or moved notes than this share of the space at once: a new layout instead of finding spots one by one.
RELAYOUT_SHARE = 0.05
RELAYOUT_MIN = 40
#: Radius of a group made for a single new note.
NEW_GROUP_R = 40.0
NIGHT_HOUR = 3
DAILY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# --- Noticing changes ------------------------------------------------------------------------------------------------

_WRITES = re.compile(
    r"^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+\"?(?:files|links|tags)\b", re.IGNORECASE
)
_counter_lock = threading.Lock()
_counter = 0


def touch() -> None:
    global _counter
    with _counter_lock:
        _counter += 1


def changes() -> int:
    return _counter


@event.listens_for(engine, "after_cursor_execute")
def _watch(_conn: Any, _cursor: Any, statement: str, _params: Any, _context: Any, _many: bool) -> None:
    if _WRITES.match(statement):
        touch()


# --- Reading what the graph is made of -------------------------------------------------------------------------------


@dataclass
class Notes:
    ids: list[int] = field(default_factory=list)
    path: dict[int, str] = field(default_factory=dict)
    title: dict[int, str] = field(default_factory=dict)
    daily: set[int] = field(default_factory=set)
    #: First tag of each note that has one: (key, as written).
    tag: dict[int, tuple[str, str]] = field(default_factory=dict)


def _load_notes(db: Session, space_id: int, with_tags: bool) -> Notes:
    notes = Notes()
    for file_id, path, title in db.execute(
        select(File.id, File.path, File.title)
        .where(File.space_id == space_id, File.is_note.is_(True), File.deleted_at.is_(None))
        .order_by(File.id)
    ):
        notes.ids.append(file_id)
        notes.path[file_id] = path
        notes.title[file_id] = title
        stem = path.rsplit("/", 1)[-1][:-3]
        if DAILY.match(stem):
            notes.daily.add(file_id)
    if with_tags:
        for file_id, key, tag in db.execute(
            select(Tag.file_id, Tag.tag_key, Tag.tag)
            .join(File, File.id == Tag.file_id)
            .where(File.space_id == space_id, File.deleted_at.is_(None), File.is_note.is_(True))
            .order_by(Tag.file_id, Tag.pos, Tag.tag_key)
        ):
            notes.tag.setdefault(file_id, (key, tag))
    return notes


def _load_links(db: Session, space_id: int, ids: set[int]) -> list[tuple[int, int]]:
    return [
        (source, target)
        for source, target in db.execute(
            select(Link.source_id, Link.target_id).where(
                Link.space_id == space_id, Link.target_id.is_not(None), Link.source_id != Link.target_id
            )
        )
        if source in ids and target in ids
    ]


def folder_of(path: str) -> str:
    """The folder of a note inside its space: ``A/B`` of ``Space/A/B/Note.md``, empty at the top of the space."""
    parts = path.split("/")
    return "/".join(parts[1:-1])


def placement(cloud: str, notes: Notes, file_id: int) -> str:
    """The key of the group a note belongs in, before buckets: its folder, its first tag, or (topics) nothing."""
    if cloud == "folders":
        folder = folder_of(notes.path[file_id])
        return f"f:{folder}" if folder else "space"
    if cloud == "tags":
        found = notes.tag.get(file_id)
        return f"t:{found[0]}" if found else "untagged"
    return "recent"


def _tree(cloud: str, space_name: str, notes: Notes, topics: Any = None) -> tuple[gl.Group, dict[int, str]]:
    """The groups of a cloud with the notes in them; and for every note what it was grouped by."""
    root = gl.Group(key="space", kind="space", name=space_name)
    groups: dict[str, gl.Group] = {"space": root}
    placed: dict[int, str] = {}

    def chain(keys: list[tuple[str, str, str]]) -> gl.Group:
        current = root
        for key, kind, name in keys:
            group = groups.get(key)
            if group is None:
                group = gl.Group(key=key, kind=kind, name=name)
                groups[key] = group
                current.children.append(group)
            current = group
        return current

    if cloud == "topics" and topics is not None:
        for topic in topics.roots:
            _topic_tree(root, topic, groups)
        for file_id in notes.ids:
            key = topics.assignment.get(file_id, "unsorted")
            target = groups.get(key) or chain([(key, "unsorted", "")])
            target.notes.append(file_id)
            placed[file_id] = key
        return root, placed

    for file_id in notes.ids:
        key = placement(cloud, notes, file_id)
        placed[file_id] = key
        if cloud == "folders":
            parts = folder_of(notes.path[file_id]).split("/") if key != "space" else []
            keys = [(f"f:{'/'.join(parts[: i + 1])}", "folder", part) for i, part in enumerate(parts)]
        elif key == "untagged":
            keys = [("untagged", "untagged", "")]
        else:
            tag_key, tag = notes.tag[file_id]
            key_parts = tag_key.split("/")
            name_parts = tag.split("/")
            keys = [
                (f"t:{'/'.join(key_parts[: i + 1])}", "tag", "/".join(name_parts[: i + 1]))
                for i in range(len(key_parts))
            ]
        chain(keys).notes.append(file_id)
    return root, placed


def _topic_tree(parent: gl.Group, topic: Any, groups: dict[str, gl.Group]) -> None:
    group = gl.Group(key=topic.key, kind="topic", name=topic.name)
    groups[topic.key] = group
    parent.children.append(group)
    for child in topic.children:
        _topic_tree(group, child, groups)


def _colour(key: str) -> int:
    """Stable palette slot of a top-level group; the interface works out the same for folders (``folderColor``)."""
    value = 0x811C9DC5
    for byte in key.encode():
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value % PALETTE


def level_of(radius: float) -> int:
    """The zoom level (``floor(log2(zoom))``) from which a group of this radius starts to open."""
    return math.floor(math.log2(OPEN_FROM / max(radius, 1e-6)))


# --- Full layout -----------------------------------------------------------------------------------------------------


_lock = threading.RLock()


def _space(db: Session, space_id: int) -> Space | None:
    return db.get(Space, space_id)


def build(space_id: int, cloud: str, *, topics: Any = None) -> None:
    """Lay out the cloud of a space anew, starting from where things were."""
    with _lock, SessionLocal() as db:
        space = _space(db, space_id)
        if space is None:
            return
        started = time.monotonic()
        notes = _load_notes(db, space_id, with_tags=cloud == "tags")
        ids = set(notes.ids)
        links = _load_links(db, space_id, ids)
        degree: dict[int, int] = defaultdict(int)
        for a, b in links:
            degree[a] += 1
            degree[b] += 1
        if cloud == "topics" and topics is None:
            from . import topics as topic_service

            topics = topic_service.compute(db, space_id, notes, links, previous=_previous_topics(db, space_id))
        root, placed = _tree(cloud, space.folder, notes, topics)
        gl.split(root, links, notes.title, degree)
        previous = _previous_positions(db, space_id, cloud)
        result = gl.layout(root, links, degree, previous, seed=f"{space.folder}/{cloud}")
        _write(db, space_id, cloud, root, result, notes, placed)
        state = db.get(GraphState, (space_id, cloud)) or GraphState(space_id=space_id, cloud=cloud, version=0)
        state.version += 1
        state.built_at = utcnow()
        state.changed_at = None
        db.merge(state)
        db.commit()
        logger.info(
            "Graph laid out space=%s cloud=%s notes=%s groups=%s seconds=%.1f",
            space_id, cloud, len(notes.ids), len(result.groups), time.monotonic() - started,
        )


def _previous_positions(db: Session, space_id: int, cloud: str) -> dict[str, tuple[float, float]]:
    previous: dict[str, tuple[float, float]] = {}
    for key, rx, ry in db.execute(
        select(GraphGroup.key, GraphGroup.rx, GraphGroup.ry).where(
            GraphGroup.space_id == space_id, GraphGroup.cloud == cloud
        )
    ):
        previous[f"g:{key}"] = (rx, ry)
    for file_id, rx, ry in db.execute(
        select(GraphNode.file_id, GraphNode.rx, GraphNode.ry).where(
            GraphNode.space_id == space_id, GraphNode.cloud == cloud
        )
    ):
        previous[f"n:{file_id}"] = (rx, ry)
    return previous


def _previous_topics(db: Session, space_id: int) -> dict[int, str]:
    return {
        file_id: placed
        for file_id, placed in db.execute(
            select(GraphNode.file_id, GraphNode.placed).where(
                GraphNode.space_id == space_id, GraphNode.cloud == "topics"
            )
        )
    }


def _write(
    db: Session, space_id: int, cloud: str, root: gl.Group, result: gl.Result, notes: Notes, placed: dict[int, str]
) -> None:
    db.execute(delete(GraphNode).where(GraphNode.space_id == space_id, GraphNode.cloud == cloud))
    db.execute(delete(GraphGroup).where(GraphGroup.space_id == space_id, GraphGroup.cloud == cloud))
    next_id = (db.scalar(select(func.max(GraphGroup.id))) or 0) + 1
    ids: dict[str, int] = {}
    group_rows: list[dict[str, Any]] = []
    node_rows: list[dict[str, Any]] = []

    def walk(group: gl.Group, parent: int | None, colour: int, index: int) -> tuple[int, int]:
        nonlocal next_id
        group_id = next_id
        next_id += 1
        ids[group.key] = group_id
        if parent is not None and colour == -2:
            # A group right below the space picks the colour its part of the map keeps.
            if group.kind in ("untagged", "recent", "unsorted"):
                colour = -1
            elif group.kind == "topic":
                # The number in the key stays with a topic across new calculations, and so does its colour.
                colour = int(re.sub(r"\D", "", group.key.split("/")[0]) or index) % PALETTE
            else:
                colour = _colour(group.key)
        row: dict[str, Any] = {"id": group_id}
        group_rows.append(row)
        total = len(group.notes)
        daily = sum(1 for n in group.notes if n in notes.daily)
        for position, child in enumerate(group.children):
            below, below_daily = walk(child, group_id, colour if parent is not None else -2, position)
            total += below
            daily += below_daily
        placed_group = result.groups[group.key]
        row.update(
            space_id=space_id, cloud=cloud, key=group.key, parent_id=parent, kind=group.kind, name=group.name,
            anchor_id=group.anchor, total=total, daily=daily, x=placed_group.x, y=placed_group.y, r=placed_group.r,
            rx=placed_group.rx, ry=placed_group.ry, color=max(colour, -1),
        )
        level = level_of(placed_group.r)
        for note in group.notes:
            spot = result.notes[note]
            node_rows.append({
                "cloud": cloud, "file_id": note, "space_id": space_id, "group_id": group_id, "x": spot.x,
                "y": spot.y, "r": spot.r, "rx": spot.rx, "ry": spot.ry, "level": level, "placed": placed[note],
                "daily": note in notes.daily,
            })
        return total, daily

    walk(root, None, -2, 0)
    connection = db.connection()
    if group_rows:
        connection.execute(insert(GraphGroup), group_rows)
    for start in range(0, len(node_rows), 5000):
        connection.execute(insert(GraphNode), node_rows[start : start + 5000])


# --- Small changes: a spot for each new note, nothing else moves ------------------------------------------------------


@dataclass
class _G:
    id: int
    key: str
    parent: int | None
    kind: str
    x: float
    y: float
    r: float
    children: list[int] = field(default_factory=list)


def refresh(space_id: int, cloud: str) -> bool:
    """Bring a laid-out cloud in line with the notes of the space without moving anything that stayed. Returns
    whether anything changed. Too much at once, and the cloud is laid out anew instead."""
    with _lock, SessionLocal() as db:
        state = db.get(GraphState, (space_id, cloud))
        if state is None:
            return False
        notes = _load_notes(db, space_id, with_tags=cloud == "tags")
        stored = {
            file_id: (group_id, placed)
            for file_id, group_id, placed in db.execute(
                select(GraphNode.file_id, GraphNode.group_id, GraphNode.placed).where(
                    GraphNode.space_id == space_id, GraphNode.cloud == cloud
                )
            )
        }
        current = set(notes.ids)
        gone = [file_id for file_id in stored if file_id not in current]
        if cloud == "topics":
            moved: list[int] = []
        else:
            moved = [n for n in notes.ids if n in stored and stored[n][1] != placement(cloud, notes, n)]
        new = [n for n in notes.ids if n not in stored]
        titles_changed = False
        if not gone and not moved and not new:
            return titles_changed
        if len(new) + len(moved) > max(RELAYOUT_MIN, RELAYOUT_SHARE * len(notes.ids)):
            db.close()
            build(space_id, cloud)
            return True
        groups = _load_groups(db, space_id, cloud)
        by_key = {g.key: g for g in groups.values()}
        _remove(db, groups, stored, gone + moved, notes)
        links = _load_links(db, space_id, current) if new or moved else []
        linked: dict[int, set[int]] = defaultdict(set)
        for a, b in links:
            linked[a].add(b)
            linked[b].add(a)
        for file_id in sorted(new + moved):
            _place(db, space_id, cloud, groups, by_key, notes, file_id, linked[file_id])
        state.version += 1
        state.changed_at = utcnow()
        db.commit()
        logger.debug("Graph updated space=%s cloud=%s new=%s moved=%s gone=%s", space_id, cloud, len(new),
                     len(moved), len(gone))
        return True


def _load_groups(db: Session, space_id: int, cloud: str) -> dict[int, _G]:
    groups = {
        row.id: _G(row.id, row.key, row.parent_id, row.kind, row.x, row.y, row.r)
        for row in db.execute(
            select(GraphGroup.id, GraphGroup.key, GraphGroup.parent_id, GraphGroup.kind, GraphGroup.x, GraphGroup.y,
                   GraphGroup.r).where(GraphGroup.space_id == space_id, GraphGroup.cloud == cloud)
        )
    }
    for group in groups.values():
        if group.parent in groups:
            groups[group.parent].children.append(group.id)
    return groups


def _count(db: Session, groups: dict[int, _G], group_id: int, total: int, daily: int) -> None:
    current: int | None = group_id
    while current is not None:
        db.execute(
            update(GraphGroup)
            .where(GraphGroup.id == current)
            .values(total=GraphGroup.total + total, daily=GraphGroup.daily + daily)
        )
        current = groups[current].parent if current in groups else None


def _remove(db: Session, groups: dict[int, _G], stored: dict[int, tuple[int, str]], ids: list[int],
            notes: Notes) -> None:
    for file_id in ids:
        group_id, _placed = stored[file_id]
        daily = db.scalar(select(GraphNode.daily).where(GraphNode.file_id == file_id, GraphNode.group_id == group_id))
        db.execute(delete(GraphNode).where(GraphNode.file_id == file_id, GraphNode.group_id == group_id))
        if group_id in groups:
            _count(db, groups, group_id, -1, -1 if daily else 0)
    # Groups left empty go, from the bottom up; the space itself stays.
    for group in sorted(groups.values(), key=lambda g: -_depth(groups, g.id)):
        if group.kind == "space" or group.id not in groups:
            continue
        total = db.scalar(select(GraphGroup.total).where(GraphGroup.id == group.id))
        if total is not None and total <= 0 and not group.children:
            db.execute(delete(GraphGroup).where(GraphGroup.id == group.id))
            parent = groups.get(group.parent) if group.parent is not None else None
            if parent is not None:
                parent.children.remove(group.id)
            del groups[group.id]


def _depth(groups: dict[int, _G], group_id: int) -> int:
    depth = 0
    current = groups[group_id].parent
    while current is not None and current in groups:
        depth += 1
        current = groups[current].parent
    return depth


def _obstacles(db: Session, groups: dict[int, _G], group: _G, cloud: str) -> list[tuple[float, float, float]]:
    taken = [(groups[c].x, groups[c].y, groups[c].r) for c in group.children if c in groups]
    taken += [
        (x, y, r + 12)
        for x, y, r in db.execute(
            select(GraphNode.x, GraphNode.y, GraphNode.r).where(
                GraphNode.cloud == cloud, GraphNode.group_id == group.id
            )
        )
    ]
    return taken


def _make_group(db: Session, space_id: int, cloud: str, groups: dict[int, _G], by_key: dict[str, _G], key: str,
                kind: str, name: str, parent: _G) -> _G:
    """A group that did not exist yet, as a small circle at a free spot of its parent."""
    taken = _obstacles(db, groups, parent, cloud)
    x, y = gl.free_spot((parent.x, parent.y), parent.r, taken, NEW_GROUP_R, None, gl.stable_seed(key))
    colour = db.scalar(select(GraphGroup.color).where(GraphGroup.id == parent.id))
    if parent.kind == "space":
        colour = -1 if kind in ("untagged", "recent") else _colour(key)
    row = GraphGroup(space_id=space_id, cloud=cloud, key=key, parent_id=parent.id, kind=kind, name=name, total=0,
                     daily=0, x=x, y=y, r=NEW_GROUP_R, rx=x - parent.x, ry=y - parent.y, color=colour)
    db.add(row)
    db.flush()
    made = _G(row.id, key, parent.id, kind, x, y, NEW_GROUP_R)
    groups[row.id] = made
    by_key[key] = made
    parent.children.append(row.id)
    return made


def _place(db: Session, space_id: int, cloud: str, groups: dict[int, _G], by_key: dict[str, _G], notes: Notes,
           file_id: int, linked: set[int]) -> None:
    key = placement(cloud, notes, file_id)
    target = by_key.get(key)
    if target is None:
        # The chain of groups down to the new one: folders and nested tags, each part a group of its own.
        root = by_key["space"]
        if cloud == "folders":
            parts = key[2:].split("/")
            chain = [(f"f:{'/'.join(parts[: i + 1])}", "folder", part) for i, part in enumerate(parts)]
        elif key == "untagged" or key == "recent":
            chain = [(key, key, "")]
        else:
            tag_key, tag = notes.tag[file_id]
            key_parts, name_parts = tag_key.split("/"), tag.split("/")
            chain = [(f"t:{'/'.join(key_parts[: i + 1])}", "tag", "/".join(name_parts[: i + 1]))
                     for i in range(len(key_parts))]
        parent = root
        for chain_key, kind, name in chain:
            parent = by_key.get(chain_key) or _make_group(db, space_id, cloud, groups, by_key, chain_key, kind, name,
                                                          parent)
        target = parent
    # A crowded group that was split: into the bucket its links point to, else among the unlinked.
    buckets = [groups[c] for c in target.children if groups[c].kind in ("bucket", "unlinked")]
    if buckets:
        votes: dict[int, int] = defaultdict(int)
        if linked:
            for group_id in db.scalars(
                select(GraphNode.group_id).where(GraphNode.cloud == cloud, GraphNode.file_id.in_(linked))
            ):
                votes[group_id] += 1
        choice = max((b for b in buckets if votes.get(b.id)), key=lambda b: (votes[b.id], -b.id), default=None)
        if choice is None:
            unlinked = [b for b in buckets if b.kind == "unlinked"]
            choice = unlinked[0] if unlinked else _make_group(
                db, space_id, cloud, groups, by_key, f"{target.key}|u0", "unlinked", "", target
            )
        target = choice
    near = None
    if linked:
        rows = db.execute(
            select(GraphNode.x, GraphNode.y).where(
                GraphNode.cloud == cloud, GraphNode.group_id == target.id, GraphNode.file_id.in_(linked)
            )
        ).all()
        if rows:
            near = (sum(r[0] for r in rows) / len(rows), sum(r[1] for r in rows) / len(rows))
    radius = gl.note_radius(len(linked))
    x, y = gl.free_spot((target.x, target.y), target.r, _obstacles(db, groups, target, cloud), radius + 12, near,
                        gl.stable_seed(f"{cloud}:{file_id}"))
    daily = file_id in notes.daily
    db.execute(insert(GraphNode).values(
        cloud=cloud, file_id=file_id, space_id=space_id, group_id=target.id, x=x, y=y, r=radius,
        rx=x - target.x, ry=y - target.y, level=level_of(target.r), placed=placement(cloud, notes, file_id)
        if cloud != "topics" else "recent", daily=daily,
    ))
    _count(db, groups, target.id, 1, 1 if daily else 0)


# --- Asking ----------------------------------------------------------------------------------------------------------


def state(db: Session, space_id: int, cloud: str) -> GraphState | None:
    return db.get(GraphState, (space_id, cloud))


def note_count(db: Session, space_id: int) -> int:
    return db.scalar(
        select(func.count()).where(File.space_id == space_id, File.is_note.is_(True), File.deleted_at.is_(None))
    ) or 0


_seen: dict[tuple[int, str], int] = {}


def ready(space_id: int, cloud: str) -> str:
    """Make sure the cloud is there and current, as far as that can be done now: ``ready`` or ``building``."""
    background = not get_settings().disable_background
    with SessionLocal() as db:
        found = state(db, space_id, cloud)
        small = note_count(db, space_id) <= INLINE_NOTES
    if found is None:
        if background and not small:
            worker.ask(("build", space_id, cloud))
            return "building"
        build(space_id, cloud)
        _seen[(space_id, cloud)] = changes()
        return "ready"
    if _seen.get((space_id, cloud)) != changes():
        marker = changes()
        if background and not small:
            worker.ask(("update", space_id, cloud))
        else:
            refresh(space_id, cloud)
            _seen[(space_id, cloud)] = marker
    return "ready"


_pairs: dict[tuple[int, str], tuple[tuple[int, str], float, list[list[int]]]] = {}
PAIRS_SECONDS = 10.0


def forget() -> None:
    """Drop what is kept in memory (tests start every case with an empty database)."""
    _pairs.clear()
    _seen.clear()


def group_links(db: Session, space_id: int, cloud: str, version: tuple[int, str]) -> list[list[int]]:
    """How many links run between the notes of two groups: ``[group, group, count]``. The browser adds them up
    to whatever circles are closed on screen. Kept for a few seconds; typing a link need not count everything."""
    key = (space_id, cloud)
    cached = _pairs.get(key)
    now = time.monotonic()
    if cached and cached[0] == version and now - cached[1] < PAIRS_SECONDS:
        return cached[2]
    rows = db.execute(
        text(
            "SELECT a.group_id, b.group_id, COUNT(*) FROM links l "
            "JOIN graph_nodes a ON a.cloud = :cloud AND a.file_id = l.source_id "
            "JOIN graph_nodes b ON b.cloud = :cloud AND b.file_id = l.target_id "
            "WHERE l.space_id = :space AND l.target_id IS NOT NULL AND l.source_id != l.target_id "
            "AND a.group_id != b.group_id GROUP BY a.group_id, b.group_id"
        ),
        {"cloud": cloud, "space": space_id},
    ).all()
    merged: dict[tuple[int, int], int] = defaultdict(int)
    for a, b, count in rows:
        merged[(a, b) if a < b else (b, a)] += count
    pairs = [[a, b, count] for (a, b), count in sorted(merged.items())]
    _pairs[key] = (version, now, pairs)
    return pairs


def overview(db: Session, space_id: int, cloud: str) -> dict[str, Any]:
    found = state(db, space_id, cloud)
    if found is None:
        return {"status": "building", "version": 0, "groups": [], "links": []}
    anchor = File.__table__.alias("anchor")
    groups = [
        [row.id, row.parent_id, row.kind, row.title if row.kind == "bucket" and row.title is not None else row.name,
         row.total, row.daily, round(row.x, 1), round(row.y, 1), round(row.r, 1), row.color, row.key,
         level_of(row.r)]
        for row in db.execute(
            select(GraphGroup.id, GraphGroup.parent_id, GraphGroup.kind, GraphGroup.name, GraphGroup.total,
                   GraphGroup.daily, GraphGroup.x, GraphGroup.y, GraphGroup.r, GraphGroup.color, GraphGroup.key,
                   anchor.c.title.label("title"))
            .outerjoin(anchor, anchor.c.id == GraphGroup.anchor_id)
            .where(GraphGroup.space_id == space_id, GraphGroup.cloud == cloud)
            .order_by(GraphGroup.id)
        )
    ]
    return {
        "status": "ready",
        "version": found.version,
        "built": found.built_at.isoformat() if found.built_at else None,
        "changed": found.changed_at.isoformat() if found.changed_at else None,
        "groups": groups,
        "links": group_links(
            db, space_id, cloud, (found.version, found.built_at.isoformat() if found.built_at else "")
        ),
    }


#: A tile at level L is TILE / 2**L wide in map units: at zoom 2**L that is TILE pixels on screen.
TILE = 512.0
MAX_TILES = 64


def tiles(db: Session, space_id: int, cloud: str, wanted: list[tuple[int, int, int]]) -> dict[str, Any]:
    """The notes that become visible at a zoom level, inside a square of the map, with their links. Links to notes
    outside come with where those are and which group they are in, so the line can end at the right circle."""
    out_tiles: list[dict[str, Any]] = []
    inside: set[int] = set()
    for level, tx, ty in wanted[:MAX_TILES]:
        size = TILE / 2**level
        x0, y0 = tx * size, ty * size
        rows = db.execute(
            select(GraphNode.file_id, GraphNode.group_id, GraphNode.x, GraphNode.y, GraphNode.r, GraphNode.daily,
                   File.title, File.path)
            .join(File, File.id == GraphNode.file_id)
            .where(
                GraphNode.space_id == space_id, GraphNode.cloud == cloud, GraphNode.level == level,
                GraphNode.x >= x0, GraphNode.x < x0 + size, GraphNode.y >= y0, GraphNode.y < y0 + size,
            )
        ).all()
        notes = [[r.file_id, r.group_id, round(r.x, 1), round(r.y, 1), round(r.r, 1), 1 if r.daily else 0, r.title,
                  r.path] for r in rows]
        inside.update(r.file_id for r in rows)
        out_tiles.append({"level": level, "x": tx, "y": ty, "notes": notes})
    links: list[list[int]] = []
    others: dict[int, list[Any]] = {}
    ids = sorted(inside)
    for start in range(0, len(ids), 500):
        part = ids[start : start + 500]
        for source, target in db.execute(
            select(Link.source_id, Link.target_id).where(
                Link.space_id == space_id, Link.target_id.is_not(None), Link.source_id != Link.target_id,
                (Link.source_id.in_(part)) | (Link.target_id.in_(part)),
            )
        ):
            links.append([source, target])
            for end in (source, target):
                if end not in inside:
                    others[end] = []
    missing = sorted(others)
    for start in range(0, len(missing), 500):
        for file_id, group_id, x, y, level in db.execute(
            select(GraphNode.file_id, GraphNode.group_id, GraphNode.x, GraphNode.y, GraphNode.level).where(
                GraphNode.cloud == cloud, GraphNode.file_id.in_(missing[start : start + 500])
            )
        ):
            others[file_id] = [file_id, group_id, round(x, 1), round(y, 1), level]
    unique = {tuple(sorted(pair)) for pair in links if others.get(pair[0]) != [] and others.get(pair[1]) != []}
    return {
        "tiles": out_tiles,
        "links": [list(pair) for pair in sorted(unique)],
        "others": [value for value in others.values() if value],
    }


def locate(db: Session, file_id: int, cloud: str) -> dict[str, Any] | None:
    row = db.execute(
        select(GraphNode.x, GraphNode.y, GraphNode.group_id, GraphNode.level).where(
            GraphNode.cloud == cloud, GraphNode.file_id == file_id
        )
    ).first()
    if row is None:
        return None
    return {"id": file_id, "x": row.x, "y": row.y, "group": row.group_id, "level": row.level}


def local(db: Session, file_id: int, space_id: int, depth: int, limit: int) -> dict[str, Any]:
    """The neighbourhood of a note: every note up to ``depth`` links away, either direction, at most ``limit``;
    the nearest first, the best linked first among equals."""
    distance = {file_id: 0}
    frontier = [file_id]
    edges: set[tuple[int, int]] = set()
    for step in range(1, depth + 1):
        if not frontier or len(distance) >= limit:
            break
        found: dict[int, int] = defaultdict(int)
        for start in range(0, len(frontier), 500):
            part = frontier[start : start + 500]
            for source, target in db.execute(
                select(Link.source_id, Link.target_id)
                .join(File, File.id == Link.target_id)
                .where(
                    Link.space_id == space_id, Link.target_id.is_not(None), Link.source_id != Link.target_id,
                    File.is_note.is_(True), File.deleted_at.is_(None),
                    (Link.source_id.in_(part)) | (Link.target_id.in_(part)),
                )
            ):
                for other in (source, target):
                    if other not in distance:
                        found[other] += 1
        live = set(
            db.scalars(select(File.id).where(File.id.in_(list(found)), File.deleted_at.is_(None)))
        ) if found else set()
        ranked = sorted((n for n in found if n in live), key=lambda n: (-found[n], n))
        room = limit - len(distance)
        frontier = ranked[:room]
        for other in frontier:
            distance[other] = step
    ids = list(distance)
    for start in range(0, len(ids), 500):
        part = ids[start : start + 500]
        for source, target in db.execute(
            select(Link.source_id, Link.target_id).where(
                Link.space_id == space_id, Link.source_id.in_(part), Link.target_id.in_(ids)
            )
        ):
            if source != target:
                edges.add((min(source, target), max(source, target)))
    rows = {
        file_id: (path, title)
        for file_id, path, title in db.execute(select(File.id, File.path, File.title).where(File.id.in_(ids)))
    }
    return {
        "nodes": [[n, rows[n][0], rows[n][1], distance[n]] for n in ids if n in rows],
        "links": [list(edge) for edge in sorted(edges)],
    }


TAG_ORDER_DONE = "graph_tag_order"


def fix_tag_order() -> int:
    """Tags indexed before they kept their order all have position 0. Notes with more than one tag are read again
    once, so the tag cloud puts them under their real first tag. Returns how many notes were read."""
    from .prepare import analyse

    with SessionLocal() as db:
        if db.get(Setting, TAG_ORDER_DONE) is not None:
            return 0
        ids = list(db.scalars(
            select(Tag.file_id).group_by(Tag.file_id).having(func.count() > 1, func.max(Tag.pos) == 0)
        ))
        done = 0
        for file_id in ids:
            file = db.get(File, file_id)
            if file is None or file.deleted_at is not None:
                continue
            try:
                data = paths.resolve(file.path).read_bytes()
            except (OSError, paths.PathError):
                continue
            order = {key: pos for pos, (key, _tag) in enumerate(analyse(file.path, data).tags)}
            for tag in db.scalars(select(Tag).where(Tag.file_id == file_id)):
                tag.pos = order.get(tag.tag_key, len(order))
            done += 1
        db.add(Setting(key=TAG_ORDER_DONE, value=True))
        db.commit()
    if done:
        logger.info("Tag order read again notes=%s", done)
    return done


# --- The worker ------------------------------------------------------------------------------------------------------


class _Worker:
    """One thread, one job after the other: laying out, updating, topics. Checks for changes every few seconds and
    once a night orders the map again where the day changed it."""

    def __init__(self) -> None:
        self._jobs: list[tuple[str, int, str]] = []
        self._wake = threading.Condition()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_changes = -1
        self._last_night: str | None = None
        self.busy: tuple[str, int, str] | None = None

    def ask(self, job: tuple[str, int, str]) -> None:
        with self._wake:
            if job not in self._jobs and job != self.busy:
                self._jobs.append(job)
            self._wake.notify()

    def pending(self, space_id: int, cloud: str) -> bool:
        with self._wake:
            return any(j[1] == space_id and j[2] == cloud for j in self._jobs) or (
                self.busy is not None and self.busy[1] == space_id and self.busy[2] == cloud
            )

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="nexlore-graph", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._wake:
            self._wake.notify()
        if self._thread is not None:
            self._thread.join(timeout=10)
        self._thread = None

    def _run(self) -> None:
        try:
            fix_tag_order()
        except Exception:
            logger.exception("Reading the tag order again failed")
        while not self._stop.is_set():
            job = None
            with self._wake:
                if not self._jobs:
                    self._wake.wait(timeout=3)
                if self._jobs:
                    job = self._jobs.pop(0)
                    self.busy = job
            try:
                if job is not None:
                    self._do(job)
                else:
                    self._look_around()
            except Exception:
                logger.exception("Graph job failed job=%s", job)
            finally:
                self.busy = None

    def _do(self, job: tuple[str, int, str]) -> None:
        kind, space_id, cloud = job
        marker = changes()
        if kind == "build":
            build(space_id, cloud)
        else:
            refresh(space_id, cloud)
        _seen[(space_id, cloud)] = marker

    def _look_around(self) -> None:
        marker = changes()
        with SessionLocal() as db:
            laid = db.execute(select(GraphState.space_id, GraphState.cloud)).all()
        if marker != self._last_changes:
            self._last_changes = marker
            for space_id, cloud in laid:
                if _seen.get((space_id, cloud)) != marker:
                    self.ask(("update", space_id, cloud))
        now = datetime.now().astimezone()
        today = now.date().isoformat()
        if now.hour == NIGHT_HOUR and self._last_night != today:
            self._last_night = today
            for job in nightly():
                self.ask(job)


def nightly() -> list[tuple[str, int, str]]:
    """What the night lays out again: every cloud that notes were added to or moved in since its last layout, and
    the topics of every space whose notes changed since they were worked out."""
    jobs: list[tuple[str, int, str]] = []
    with SessionLocal() as db:
        for space_id, cloud, built, changed in db.execute(
            select(GraphState.space_id, GraphState.cloud, GraphState.built_at, GraphState.changed_at)
        ):
            if cloud == "topics":
                newest = db.scalar(
                    select(func.max(File.indexed_at)).where(File.space_id == space_id, File.is_note.is_(True))
                )
                deleted = db.scalar(
                    select(func.max(File.deleted_at)).where(File.space_id == space_id, File.is_note.is_(True))
                )
                later = [t for t in (newest, deleted, changed) if t is not None and (built is None or t > built)]
                if later:
                    jobs.append(("build", space_id, cloud))
            elif changed is not None:
                jobs.append(("build", space_id, cloud))
    return jobs


worker = _Worker()
