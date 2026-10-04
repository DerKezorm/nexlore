"""The graph of every space, worked out on the server and kept in the database.

For each space and each cloud (``folders``, ``tags``, ``topics``) the notes are grouped into nested circles
(``graphlayout``) and stored: ``graph_groups`` for the circles, ``graph_nodes`` for the notes. The browser then loads
the circles of a space once and the notes only for the part of the map it shows (``tiles``).

The map stays calm. A new, moved or deleted note changes only its own place: it takes a free spot in its group,
without moving anything else (``refresh``). A full layout runs the first time, when much changed at once or bit by bit
since the last one, when a new note or group finds no room (in spaces small enough to lay out at once), and at night
after a day with changes; it starts from the old positions, so the map stays recognisable (``build``).

Changes are noticed where notes are written: every note added, changed, moved or deleted through the ORM marks its
space (``_after_flush``), and the index's bulk insert marks the spaces it filled (``touch``). Only the clouds of a
marked space are brought up to date, so typing in one space never makes the map of a big other one work. Every write
to ``files``, ``links`` or ``tags`` also counts up ``changes()``: link counts are counted again from it, and once in a
while every cloud is checked against it, a net for a way of writing the marks do not see. One worker thread does the
work, one job after the other; small spaces are done at once, inside the request, so the graph is there on the first
look.
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

from sqlalchemy import and_, delete, event, func, insert, or_, select, update
from sqlalchemy.orm import Session, aliased

from ..config import get_settings
from ..db import SessionLocal, engine
from ..models import File, GraphGroup, GraphNode, GraphState, Link, Setting, Space, Tag, utcnow
from . import graphlayout as gl
from . import paths, spaceopts

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
#: More notes placed one by one since the last layout than this share of the space: a new layout as well. A space
#: filled a note at a time (a helper writing through MCP) otherwise keeps the circle it had when nearly empty.
GROWN_SHARE = 0.25
#: Up to this many notes, a new group or note that finds no room lays the space out anew; bigger spaces wait for the
#: share above or the night.
CROWDED_RELAYOUT_UPTO = INLINE_NOTES
#: Radius of a group made for a single new note.
NEW_GROUP_R = 40.0
NIGHT_HOUR = 3
#: A job that failed is not tried again before this, unless somebody asks for it directly (a new layout).
RETRY_SECONDS = 600.0

# --- Noticing changes ------------------------------------------------------------------------------------------------

_WRITES = re.compile(
    r"^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+\"?(?:files|links|tags)\b", re.IGNORECASE
)
_counter_lock = threading.Lock()
_counter = 0
_space_counters: dict[int, int] = defaultdict(int)
#: How often every cloud is checked against the global count anyway (a write the marks did not see).
NET_SECONDS = 600.0


def touch(space_id: int | None = None) -> None:
    """Something changed; with ``space_id``: in that space, and its clouds are to be brought up to date."""
    global _counter
    with _counter_lock:
        _counter += 1
        if space_id is not None:
            _space_counters[space_id] += 1


def changes(space_id: int | None = None) -> int:
    return _counter if space_id is None else _space_counters[space_id]


@event.listens_for(engine, "after_cursor_execute")
def _watch(_conn: Any, _cursor: Any, statement: str, _params: Any, _context: Any, _many: bool) -> None:
    if _WRITES.match(statement):
        touch()


@event.listens_for(Session, "after_flush")
def _after_flush(session: Session, _context: Any) -> None:
    for item in (*session.new, *session.dirty, *session.deleted):
        if isinstance(item, File) and item.space_id is not None:
            touch(item.space_id)


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
    space = db.get(Space, space_id)
    # Which notes are daily notes, the space says (M6: its daily folder); the switch on the map hides them.
    opts = spaceopts.options_of(space) if space is not None else spaceopts.DEFAULTS
    for file_id, path, title in db.execute(
        select(File.id, File.path, File.title)
        .where(File.space_id == space_id, File.is_note.is_(True), File.deleted_at.is_(None))
        .order_by(File.id)
    ):
        notes.ids.append(file_id)
        notes.path[file_id] = path
        notes.title[file_id] = title
        if spaceopts.is_daily(path, opts):
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
            select(Link.source_id, Link.target_id)
            .where(Link.space_id == space_id, Link.target_id.is_not(None), Link.source_id != Link.target_id)
            # A fixed order, so the same links always give the same map (the layout adds up in this order).
            .order_by(Link.source_id, Link.target_id)
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
        state.placed_since = 0
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
        placed = len(new) + len(moved)
        if placed > max(RELAYOUT_MIN, RELAYOUT_SHARE * len(notes.ids)) or (
            (state.placed_since or 0) + placed > max(RELAYOUT_MIN, GROWN_SHARE * len(notes.ids))
        ):
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
        crowded = False
        for file_id in sorted(new + moved):
            crowded |= not _place(db, space_id, cloud, groups, by_key, notes, file_id, linked[file_id])
        if crowded and len(notes.ids) <= CROWDED_RELAYOUT_UPTO:
            # A laid-out circle is packed tight: a new group, or a note that finds no room, would lie on top of others
            # or over the edge. A space this small is laid out anew in a moment.
            db.rollback()
            db.close()
            build(space_id, cloud)
            return True
        state.version += 1
        state.changed_at = utcnow()
        state.placed_since = (state.placed_since or 0) + placed
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
    """What lies in a group already, as drawn: first its groups, then its notes."""
    taken = [(groups[c].x, groups[c].y, groups[c].r) for c in group.children if c in groups]
    taken += [
        (x, y, r)
        for x, y, r in db.execute(
            select(GraphNode.x, GraphNode.y, GraphNode.r).where(
                GraphNode.cloud == cloud, GraphNode.group_id == group.id
            )
        )
    ]
    return taken


def _with_room(groups: dict[int, _G], group: _G, taken: list[tuple[float, float, float]]
               ) -> list[tuple[float, float, float]]:
    """The obstacles as ``free_spot`` takes them: room around every note, none around groups."""
    count = sum(1 for c in group.children if c in groups)
    return taken[:count] + [(x, y, r + 12) for x, y, r in taken[count:]]


def _fits(parent: _G, taken: list[tuple[float, float, float]], x: float, y: float, r: float) -> bool:
    """Whether a circle at this spot lies inside its parent and on top of nothing there. ``free_spot`` keeps room
    around notes that a laid-out circle never has; what counts here is a real overlap."""
    if math.hypot(x - parent.x, y - parent.y) + r > parent.r + 0.5:
        return False
    return all(math.hypot(x - ox, y - oy) >= other + r - 0.5 for ox, oy, other in taken)


def _make_group(db: Session, space_id: int, cloud: str, groups: dict[int, _G], by_key: dict[str, _G], key: str,
                kind: str, name: str, parent: _G, room: list[bool]) -> _G:
    """A group that did not exist yet, as a small circle at a free spot of its parent. ``room`` learns whether the
    spot was really free."""
    taken = _obstacles(db, groups, parent, cloud)
    x, y = gl.free_spot((parent.x, parent.y), parent.r, _with_room(groups, parent, taken), NEW_GROUP_R, None,
                        gl.stable_seed(key))
    if not _fits(parent, taken, x, y, NEW_GROUP_R):
        room[0] = False
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
           file_id: int, linked: set[int]) -> bool:
    """Put a note at a free spot of its group, making the groups it needs. Returns whether everything found room."""
    room = [True]
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
                                                          parent, room)
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
                db, space_id, cloud, groups, by_key, f"{target.key}|u0", "unlinked", "", target, room
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
    taken = _obstacles(db, groups, target, cloud)
    x, y = gl.free_spot((target.x, target.y), target.r, _with_room(groups, target, taken), radius + 12, near,
                        gl.stable_seed(f"{cloud}:{file_id}"))
    if not _fits(target, taken, x, y, radius):
        room[0] = False
    daily = file_id in notes.daily
    db.execute(insert(GraphNode).values(
        cloud=cloud, file_id=file_id, space_id=space_id, group_id=target.id, x=x, y=y, r=radius,
        rx=x - target.x, ry=y - target.y, level=level_of(target.r), placed=placement(cloud, notes, file_id)
        if cloud != "topics" else "recent", daily=daily,
    ))
    _count(db, groups, target.id, 1, 1 if daily else 0)
    return room[0]


# --- Asking ----------------------------------------------------------------------------------------------------------


def state(db: Session, space_id: int, cloud: str) -> GraphState | None:
    return db.get(GraphState, (space_id, cloud))


def note_count(db: Session, space_id: int, cloud: str | None = None) -> int:
    """Notes of a space: from its map when there is one (the map's index answers at once), else from the files."""
    if cloud is not None and state(db, space_id, cloud) is not None:
        return db.scalar(
            select(func.count()).where(GraphNode.space_id == space_id, GraphNode.cloud == cloud)
        ) or 0
    return db.scalar(
        select(func.count()).where(File.space_id == space_id, File.is_note.is_(True), File.deleted_at.is_(None))
    ) or 0


_seen: dict[tuple[int, str], int] = {}


def ready(space_id: int, cloud: str) -> str:
    """Make sure the cloud is there and current, as far as that can be done now: ``ready`` or ``building``."""
    background = not get_settings().disable_background
    with SessionLocal() as db:
        found = state(db, space_id, cloud)
        small = note_count(db, space_id, cloud) <= INLINE_NOTES
    if found is None:
        if background and not small:
            worker.ask(("build", space_id, cloud))
            return "building"
        marker = changes(space_id)
        build(space_id, cloud)
        _seen[(space_id, cloud)] = marker
        return "ready"
    if _seen.get((space_id, cloud)) != changes(space_id):
        marker = changes(space_id)
        if background and not small:
            worker.ask(("update", space_id, cloud))
        else:
            refresh(space_id, cloud)
            _seen[(space_id, cloud)] = marker
    return "ready"


_pairs: dict[tuple[int, str], tuple[tuple[int, str], int, float, list[list[int]]]] = {}
#: Link counts are counted again at most this often while links change; until then the last count is shown.
PAIRS_SECONDS = 10.0


def forget() -> None:
    """Drop what is kept in memory (tests start every case with an empty database)."""
    _pairs.clear()
    _across.clear()
    _seen.clear()
    _space_counters.clear()


def count_links(db: Session, space_id: int, cloud: str) -> list[list[int]]:
    """How many links run between the notes of two groups: ``[group, group, count]``, each pair once."""
    home = dict(
        db.execute(
            select(GraphNode.file_id, GraphNode.group_id).where(
                GraphNode.space_id == space_id, GraphNode.cloud == cloud
            )
        ).all()
    )
    counts: dict[tuple[int, int], int] = defaultdict(int)
    for source, target in db.execute(
        select(Link.source_id, Link.target_id).where(Link.space_id == space_id, Link.target_id.is_not(None))
    ):
        a = home.get(source)
        b = home.get(target)
        if a is None or b is None or a == b:
            continue
        counts[(a, b) if a < b else (b, a)] += 1
    return [[a, b, count] for (a, b), count in sorted(counts.items())]


def group_links(db: Session, space_id: int, cloud: str, version: tuple[int, str]) -> list[list[int]]:
    """The link counts between groups for the overview; the browser adds them up to whatever circles are closed.
    Kept, and while links keep changing counted again at most every few seconds (in the background for big
    spaces): typing a link must not make everybody's map wait for a count of every link."""
    key = (space_id, cloud)
    cached = _pairs.get(key)
    now = time.monotonic()
    if cached and cached[0] == version:
        stale = cached[1] != changes() and now - cached[2] >= PAIRS_SECONDS
        if not stale:
            return cached[3]
        if not get_settings().disable_background and note_count(db, space_id, cloud) > INLINE_NOTES:
            worker.ask(("pairs", space_id, cloud))
            return cached[3]
    marker = changes()
    pairs = count_links(db, space_id, cloud)
    _pairs[key] = (version, marker, now, pairs)
    return pairs


def _recount(space_id: int, cloud: str) -> None:
    with SessionLocal() as db:
        found = state(db, space_id, cloud)
        if found is None:
            return
        version = (found.version, found.built_at.isoformat() if found.built_at else "")
        marker = changes()
        pairs = count_links(db, space_id, cloud)
    _pairs[(space_id, cloud)] = (version, marker, time.monotonic(), pairs)


_across: dict[tuple[str, frozenset[int]], tuple[tuple[int, int], float, list[list[int]]]] = {}


def count_across(db: Session, cloud: str, readable: set[int]) -> list[list[int]]:
    """How many links run between groups of two different spaces, both in ``readable``: ``[group, group, count]``,
    each pair once. Group ids are unique over all spaces, so the browser adds them up like the counts inside one.
    Kept like ``group_links``: counted again at most every few seconds while links change."""
    key = (cloud, frozenset(readable))
    now = time.monotonic()
    # A map built or laid out anew changes where notes stand without a write to files, links or tags: its version
    # counts as a change too.
    maps = tuple(db.execute(
        select(GraphState.space_id, GraphState.version, GraphState.built_at)
        .where(GraphState.cloud == cloud, GraphState.space_id.in_(readable))
        .order_by(GraphState.space_id)
    ).all())
    marker = (changes(), hash(maps))
    cached = _across.get(key)
    if cached and (cached[0] == marker or (cached[0][1] == marker[1] and now - cached[1] < PAIRS_SECONDS)):
        return cached[2]
    source_node = aliased(GraphNode)
    target_node = aliased(GraphNode)
    counts: dict[tuple[int, int], int] = defaultdict(int)
    for a, b, count in db.execute(
        select(source_node.group_id, target_node.group_id, func.count())
        .select_from(Link)
        .join(source_node, and_(source_node.file_id == Link.source_id, source_node.cloud == cloud))
        .join(target_node, and_(target_node.file_id == Link.target_id, target_node.cloud == cloud))
        .where(Link.target_space_id.is_not(None), Link.target_space_id.in_(readable), Link.space_id.in_(readable))
        .group_by(source_node.group_id, target_node.group_id)
    ):
        if a != b:
            counts[(a, b) if a < b else (b, a)] += count
    pairs = [[a, b, count] for (a, b), count in sorted(counts.items())]
    if len(_across) > 256:
        _across.clear()
    _across[key] = (marker, now, pairs)
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


def tiles(
    db: Session, space_id: int, cloud: str, wanted: list[tuple[int, int, int]], readable: set[int]
) -> dict[str, Any]:
    """The notes that become visible at a zoom level, inside a square of the map, with their links. For the ends of
    those links outside the squares only the group is sent: a line to a note not loaded ends at its closed circle.
    A link into or out of another space comes along only where ``readable`` holds that space: to anybody else it
    is not there, and neither is the note at its other end."""
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
        for source, target in _tile_links(db, space_id, part, readable):
            links.append([source, target])
            for end in (source, target):
                if end not in inside:
                    others[end] = []
    missing = sorted(others)
    for start in range(0, len(missing), 500):
        for file_id, group_id in db.execute(
            select(GraphNode.file_id, GraphNode.group_id).where(
                GraphNode.cloud == cloud, GraphNode.file_id.in_(missing[start : start + 500])
            )
        ):
            others[file_id] = [file_id, group_id]
    unique = {tuple(sorted(pair)) for pair in links if others.get(pair[0]) != [] and others.get(pair[1]) != []}
    return {
        "tiles": out_tiles,
        "links": [list(pair) for pair in sorted(unique)],
        "others": [value for value in others.values() if value],
    }


def _readable_link(readable: set[int]) -> Any:
    """A link both of whose ends lie in spaces of ``readable``: its note's space, and the target's where that is
    another one."""
    return and_(
        Link.space_id.in_(readable), or_(Link.target_space_id.is_(None), Link.target_space_id.in_(readable))
    )


def _tile_links(db: Session, space_id: int, ids: list[int], readable: set[int]) -> list[tuple[int, int]]:
    """Links from or to these notes of one space, both ends readable. Inside the space by the index that covers it
    (``links_space_pair``), as before links could leave a space: measured with 100,000 notes, the general query
    (``_links_touching``) made 9 tiles take 3.3 s instead of 1.2 s. The few links over the edge of the space come
    from their own indexes (``links_across_out``, ``links_across_in``)."""
    found: set[tuple[int, int]] = set()
    for column in (Link.source_id, Link.target_id):
        for source, target in db.execute(
            select(Link.source_id, Link.target_id).where(
                column.in_(ids), Link.space_id == space_id, Link.target_id.is_not(None),
                Link.source_id != Link.target_id,
            )
        ):
            found.add((source, target))
    # Out of the space: only into a space the account may read.
    for source, target, target_space in db.execute(
        select(Link.source_id, Link.target_id, Link.target_space_id).where(
            Link.space_id == space_id, Link.target_space_id.is_not(None), Link.source_id.in_(ids)
        )
    ):
        if target_space not in readable:
            found.discard((source, target))
    # Into the space: only from a space the account may read.
    for source, target, source_space in db.execute(
        select(Link.source_id, Link.target_id, Link.space_id).where(
            Link.target_space_id == space_id, Link.target_id.in_(ids)
        )
    ):
        if source_space in readable and source != target:
            found.add((source, target))
    return sorted(found)


def _links_touching(db: Session, ids: list[int], readable: set[int]) -> list[tuple[int, int]]:
    """Links from or to these notes, both ends readable. Two queries, one per direction: an OR of both makes SQLite
    read every link."""
    found: set[tuple[int, int]] = set()
    for column in (Link.source_id, Link.target_id):
        for source, target in db.execute(
            select(Link.source_id, Link.target_id).where(
                column.in_(ids), Link.target_id.is_not(None), Link.source_id != Link.target_id,
                _readable_link(readable),
            )
        ):
            found.add((source, target))
    return sorted(found)


def locate(db: Session, file_id: int, cloud: str) -> dict[str, Any] | None:
    row = db.execute(
        select(GraphNode.x, GraphNode.y, GraphNode.group_id, GraphNode.level).where(
            GraphNode.cloud == cloud, GraphNode.file_id == file_id
        )
    ).first()
    if row is None:
        return None
    return {"id": file_id, "x": row.x, "y": row.y, "group": row.group_id, "level": row.level}


def local(db: Session, file_id: int, depth: int, limit: int, readable: set[int]) -> dict[str, Any]:
    """The neighbourhood of a note: every note up to ``depth`` links away, either direction, at most ``limit``;
    the nearest first, the best linked first among equals. Across spaces too, as far as ``readable`` reaches."""
    distance = {file_id: 0}
    frontier = [file_id]
    edges: set[tuple[int, int]] = set()
    for step in range(1, depth + 1):
        if not frontier or len(distance) >= limit:
            break
        found: dict[int, int] = defaultdict(int)
        for start in range(0, len(frontier), 500):
            part = frontier[start : start + 500]
            for source, target in _links_touching(db, part, readable):
                for other in (source, target):
                    if other not in distance:
                        found[other] += 1
        # Notes only, and only live ones: a link to a picture or to a note in the trash leads nowhere here.
        live = set(
            db.scalars(
                # Readable only, as the links that led here (``_links_touching``).
                select(File.id).where(File.id.in_(list(found)), File.deleted_at.is_(None), File.is_note.is_(True))
            )
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
                Link.source_id.in_(part), Link.target_id.in_(ids), _readable_link(readable)
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
        self._last_net = 0.0
        #: Jobs that failed, and when: not asked for again for a while (a broken space must not keep the thread busy).
        self._failed: dict[tuple[str, int, str], float] = {}
        self._last_night: str | None = None
        self.busy: tuple[str, int, str] | None = None

    def ask(self, job: tuple[str, int, str]) -> None:
        failed = self._failed.get(job)
        if failed is not None and time.monotonic() - failed < RETRY_SECONDS:
            return
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
                    self._failed.pop(job, None)
                else:
                    self._look_around()
            except Exception:
                logger.exception("Graph job failed job=%s", job)
                if job is not None:
                    self._failed[job] = time.monotonic()
            finally:
                self.busy = None

    def _do(self, job: tuple[str, int, str]) -> None:
        kind, space_id, cloud = job
        if kind == "pairs":
            _recount(space_id, cloud)
            return
        marker = changes(space_id)
        if kind == "build":
            build(space_id, cloud)
        else:
            refresh(space_id, cloud)
        _seen[(space_id, cloud)] = marker

    def _look_around(self) -> None:
        with SessionLocal() as db:
            laid = db.execute(select(GraphState.space_id, GraphState.cloud)).all()
        for space_id, cloud in laid:
            if _seen.get((space_id, cloud)) != changes(space_id):
                self.ask(("update", space_id, cloud))
        # The net: now and then every cloud once more, when anything at all was written since.
        overall = changes()
        if overall != self._last_changes and time.monotonic() - self._last_net >= NET_SECONDS:
            self._last_changes = overall
            self._last_net = time.monotonic()
            for space_id, cloud in laid:
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
