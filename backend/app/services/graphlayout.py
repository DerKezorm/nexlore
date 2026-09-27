"""The map of a space: nested circles, laid out from the bottom up. Pure computation, no database.

Every group (a space, a folder, a tag, a topic) is a circle. Its items, subgroups and notes, are placed with a small
force simulation (collision, links pulling linked items together, a pull to the middle), then the group becomes the
circle around them, and its parent only moves whole circles. That keeps every group a closed region, which is what
lets the graph open a folder once it is big enough on screen.

A group with more than ``MAX_ITEMS`` items is first split into buckets by its links (``split``): notes that link to
each other end up together, named after the note most linked to; notes without a link inside the group go to their
own bucket. That keeps every circle readable and bounds what the browser has to load when one opens.

The same input and the same previous positions give the same map (``seed``). With previous positions the
simulation starts from them and runs cooler, so a new layout still looks like the old one.
"""

from __future__ import annotations

import hashlib
import math
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

import numpy as np

#: A group shows at most this many items; more are split into buckets.
MAX_ITEMS = 300
#: A bucket is made at least this big; smaller link communities join a neighbour.
MIN_BUCKET = 12
#: Buckets aimed for when links say nothing (a group without community structure).
CHUNK = 160

GOLDEN = math.pi * (3 - math.sqrt(5))


def note_radius(degree: int) -> float:
    """Dot size of a note grows slowly with its number of links."""
    return 5.0 + min(7.0, math.sqrt(degree) * 1.6)


@dataclass
class Group:
    """A circle of the map: a space, a folder, a tag, a topic or a bucket."""

    key: str
    kind: str
    name: str
    children: list[Group] = field(default_factory=list)
    notes: list[int] = field(default_factory=list)
    #: The note a bucket is named after (``kind == "bucket"``).
    anchor: int | None = None


@dataclass
class Placed:
    x: float
    y: float
    r: float
    #: Position relative to the parent group's centre: what the next layout starts from.
    rx: float
    ry: float
    parent: str | None


@dataclass
class Result:
    groups: dict[str, Placed]
    notes: dict[int, Placed]


def stable_seed(text: str) -> int:
    return int.from_bytes(hashlib.blake2b(text.encode(), digest_size=4).digest(), "little")


# --- Buckets ---------------------------------------------------------------------------------------------------------


def _communities(members: list[int], adjacency: dict[int, dict[int, int]]) -> list[list[int]]:
    """Label propagation in a fixed order: every member takes the label most of its neighbours carry (ties: the
    smallest). Deterministic, and quick enough for tens of thousands of notes."""
    label = {m: m for m in members}
    inside = set(members)
    for _ in range(20):
        changed = 0
        for m in members:
            weights: dict[int, int] = defaultdict(int)
            for other, weight in adjacency.get(m, {}).items():
                if other in inside:
                    weights[label[other]] += weight
            if not weights:
                continue
            best = max(weights.values())
            pick = min(lab for lab, weight in weights.items() if weight == best)
            if pick != label[m]:
                label[m] = pick
                changed += 1
        if not changed:
            break
    groups: dict[int, list[int]] = defaultdict(list)
    for m in members:
        groups[label[m]].append(m)
    return sorted(groups.values(), key=lambda g: (-len(g), min(g)))


def _chunks_by_reach(members: list[int], adjacency: dict[int, dict[int, int]], size: int) -> list[list[int]]:
    """Cut a community without inner structure into pieces that hang together: breadth first from the most linked
    member, a new piece every ``size`` members."""
    inside = set(members)
    order: list[int] = []
    seen: set[int] = set()
    by_degree = sorted(members, key=lambda m: (-len(adjacency.get(m, {})), m))
    for start in by_degree:
        if start in seen:
            continue
        queue = [start]
        seen.add(start)
        while queue:
            current = queue.pop(0)
            order.append(current)
            for other in sorted(adjacency.get(current, {})):
                if other in inside and other not in seen:
                    seen.add(other)
                    queue.append(other)
    count = max(1, math.ceil(len(order) / size))
    step = math.ceil(len(order) / count)
    return [order[i : i + step] for i in range(0, len(order), step)]


def _alphabetical(members: list[int], titles: dict[int, str], size: int) -> list[list[int]]:
    ordered = sorted(members, key=lambda m: (titles.get(m, "").casefold(), m))
    count = max(1, math.ceil(len(ordered) / size))
    step = math.ceil(len(ordered) / count)
    return [ordered[i : i + step] for i in range(0, len(ordered), step)]


def split(
    group: Group, links: Iterable[tuple[int, int]], titles: dict[int, str], degree: dict[int, int]
) -> None:
    """Split every group with more than ``MAX_ITEMS`` notes into buckets, in place, all the way down."""
    adjacency: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for a, b in links:
        if a != b:
            adjacency[a][b] += 1
            adjacency[b][a] += 1
    _split(group, adjacency, titles, degree)


def _split(group: Group, adjacency: dict[int, dict[int, int]], titles: dict[int, str], degree: dict[int, int]) -> None:
    for child in group.children:
        _split(child, adjacency, titles, degree)
    if len(group.notes) + len(group.children) <= MAX_ITEMS or len(group.notes) <= MIN_BUCKET:
        return
    members = sorted(group.notes)
    inside = set(members)
    linked = [m for m in members if any(o in inside for o in adjacency.get(m, {}))]
    linked_set = set(linked)
    lonely = [m for m in members if m not in linked_set]

    pieces: list[list[int]] = []
    for community in _communities(linked, adjacency):
        if len(community) > MAX_ITEMS // 2:
            pieces.extend(_chunks_by_reach(community, adjacency, CHUNK))
        else:
            pieces.append(community)
    # Small communities join the piece they link to most, or each other.
    big = [p for p in pieces if len(p) >= MIN_BUCKET]
    small = [p for p in pieces if len(p) < MIN_BUCKET]
    if not big and small:
        big, small = [[m for piece in small for m in piece]], []
    where = {m: i for i, piece in enumerate(big) for m in piece}
    for piece in small:
        votes: dict[int, int] = defaultdict(int)
        for m in piece:
            for other, weight in adjacency.get(m, {}).items():
                if other in where:
                    votes[where[other]] += weight
        target = min(votes, key=lambda i: (-votes[i], i)) if votes else len(big) - 1
        big[target].extend(piece)
        for m in piece:
            where[m] = target

    buckets: list[Group] = []
    for piece in big:
        piece.sort()
        anchor = min(piece, key=lambda m: (-degree.get(m, 0), titles.get(m, "").casefold(), m))
        buckets.append(Group(key=f"{group.key}|b{anchor}", kind="bucket", name=titles.get(anchor, ""), notes=piece,
                             anchor=anchor))
    lonely_pieces = _alphabetical(lonely, titles, CHUNK) if len(lonely) > MAX_ITEMS // 2 else [lonely] if lonely else []
    for index, piece in enumerate(lonely_pieces):
        first = titles.get(piece[0], "")[:1].upper()
        last = titles.get(piece[-1], "")[:1].upper()
        name = f"{first}–{last}" if len(lonely_pieces) > 1 else ""
        buckets.append(Group(key=f"{group.key}|u{index}", kind="unlinked", name=name, notes=piece))
    group.notes = []
    group.children = group.children + buckets
    # Many buckets are items too: split again one level up, grouping buckets by the links between them.
    if len(group.children) > MAX_ITEMS:
        _bucket_buckets(group, adjacency, titles, degree)


def _bucket_buckets(
    group: Group, adjacency: dict[int, dict[int, int]], titles: dict[int, str], degree: dict[int, int]
) -> None:
    children = group.children
    size = math.ceil(len(children) / math.ceil(len(children) / (MAX_ITEMS // 2)))
    parts = [children[i : i + size] for i in range(0, len(children), size)]
    group.children = []
    for index, part in enumerate(parts):
        notes = [n for child in part for n in _all_notes(child)]
        anchor = min(notes, key=lambda m: (-degree.get(m, 0), titles.get(m, "").casefold(), m)) if notes else None
        group.children.append(
            Group(key=f"{group.key}|p{index}", kind="bucket", name=titles.get(anchor, "") if anchor else "",
                  children=part, anchor=anchor)
        )


def _all_notes(group: Group) -> list[int]:
    found = list(group.notes)
    for child in group.children:
        found.extend(_all_notes(child))
    return found


# --- Layout ----------------------------------------------------------------------------------------------------------


def _simulate(
    pos: np.ndarray, radius: np.ndarray, edges: list[tuple[int, int, int]], gap: float, warm: bool
) -> None:
    """Move ``pos`` (n × 2) in place until the items stop overlapping and linked ones sit close. Warm: start from
    an earlier layout and only settle what changed, so the map stays recognisable."""
    n = len(pos)
    if n == 1:
        pos[:] = 0
        return
    velocity = np.zeros_like(pos)
    ticks = 40 if warm else 160
    alpha = 0.05 if warm else 1.0
    decay = 1 - 0.001 ** (1 / ticks)
    if edges:
        src = np.array([e[0] for e in edges])
        dst = np.array([e[1] for e in edges])
        # As d3 does it: a link's pull is shared out by how many links each end has. Without that, an item linked to
        # seventy others gets seventy full pulls a tick, and the simulation swings itself apart.
        count = np.bincount(src, minlength=n) + np.bincount(dst, minlength=n)
        strength = np.minimum(0.5, 0.08 * np.array([e[2] for e in edges], dtype=np.float64))
        strength = strength / np.minimum(count[src], count[dst])
        bias = count[src] / (count[src] + count[dst])
        rest = radius[src] + radius[dst] + gap
    reach = radius[:, None] + radius[None, :] + gap / 2
    np.fill_diagonal(reach, 0)
    # No item moves further than its own size in a tick: a last guard against swinging.
    limit = np.maximum(radius, 1.0)[:, None]
    for _ in range(ticks):
        if edges:
            delta = pos[dst] + velocity[dst] - pos[src] - velocity[src]
            length = np.sqrt((delta**2).sum(axis=1)) + 1e-9
            pull = ((length - rest) / length * alpha * strength)[:, None] * delta
            for axis in (0, 1):
                velocity[:, axis] += np.bincount(src, pull[:, axis] * (1 - bias), n)
                velocity[:, axis] -= np.bincount(dst, pull[:, axis] * bias, n)
        velocity -= pos * (0.06 * alpha)
        speed = np.sqrt((velocity**2).sum(axis=1, keepdims=True)) + 1e-12
        velocity *= np.minimum(1.0, limit / speed)
        pos += velocity * 0.6
        velocity *= 0.6
        # Collision: pairs closer than their radii are pushed apart, half each.
        diff = pos[:, None, :] - pos[None, :, :]
        dist = np.sqrt((diff**2).sum(axis=2)) + 1e-9
        overlap = np.clip(reach - dist, 0, None)
        if overlap.any():
            pos += ((overlap / dist * 0.5)[:, :, None] * diff).sum(axis=1) * 0.7
        alpha -= alpha * decay
    if not np.isfinite(pos).all():
        raise FloatingPointError("layout diverged")


#: Nearest neighbours on a golden-angle sunflower with step 1 lie this far apart (measured, any size).
SUNFLOWER_SPACING = 1.546


def _pack(
    size: np.ndarray, edges: list[tuple[int, int, int]], start: np.ndarray, keep: bool
) -> np.ndarray:
    """Notes of one group: an even disc without overlaps where linked notes sit near each other. The start
    positions are smoothed towards their linked neighbours a few times (like a spring layout, but in a handful of
    array operations), then every note takes a place on a sunflower in the same order of distance and angle."""
    n = len(size)
    pos = start.copy()
    if edges and not keep:
        src = np.array([e[0] for e in edges] + [e[1] for e in edges])
        dst = np.array([e[1] for e in edges] + [e[0] for e in edges])
        weight = np.array([e[2] for e in edges] * 2, dtype=np.float64)
        total = np.bincount(src, weight, n)
        has = total > 0
        for _ in range(12):
            for axis in (0, 1):
                mean = np.bincount(src, weight * pos[dst, axis], n)
                pos[has, axis] = 0.6 * pos[has, axis] + 0.4 * mean[has] / total[has]
    step = 2 * float(size.max()) / SUNFLOWER_SPACING
    index = np.arange(n, dtype=np.float64)
    slot_distance = np.sqrt(index + 0.5) * step
    slot_angle = np.mod(index * GOLDEN, 2 * math.pi)
    centre = pos.mean(axis=0)
    rel = pos - centre
    item_distance = np.sqrt((rel**2).sum(axis=1))
    item_angle = np.mod(np.arctan2(rel[:, 1], rel[:, 0]), 2 * math.pi)
    by_distance = np.lexsort((np.arange(n), item_distance))
    out = np.zeros_like(pos)
    # Rings of slots, one step wide; items fill them from the middle outwards, in the order of their angle.
    ring = np.floor(slot_distance / step).astype(int)
    begin = 0
    for value in np.unique(ring):
        slots = np.nonzero(ring == value)[0]
        items = by_distance[begin : begin + len(slots)]
        begin += len(slots)
        slots_sorted = slots[np.argsort(slot_angle[slots], kind="stable")]
        items_sorted = items[np.argsort(item_angle[items], kind="stable")]
        out[items_sorted, 0] = np.cos(slot_angle[slots_sorted]) * slot_distance[slots_sorted]
        out[items_sorted, 1] = np.sin(slot_angle[slots_sorted]) * slot_distance[slots_sorted]
    return out


def _enclosing_centre(pos: np.ndarray, size: np.ndarray) -> np.ndarray:
    """Close to the centre of the smallest circle around all items. The farthest reach is a convex function of the
    centre: step towards the farthest item while that helps, halve the step when it does not. The middle of the
    bounding box wastes room when one item is much bigger than the rest."""
    if len(pos) == 1:
        return pos[0].copy()
    low = (pos - size[:, None]).min(axis=0)
    high = (pos + size[:, None]).max(axis=0)
    centre = (low + high) / 2

    def reach_of(c: np.ndarray) -> np.ndarray:
        return np.sqrt(((pos - c) ** 2).sum(axis=1)) + size

    reach = reach_of(centre)
    worst = float(reach.max())
    step = worst * 0.25
    while step > worst * 0.002:
        far = int(np.argmax(reach))
        direction = pos[far] - centre
        length = float(np.sqrt((direction**2).sum()))
        if length < 1e-9:
            break
        trial = centre + direction / length * step
        trial_reach = reach_of(trial)
        if float(trial_reach.max()) < worst:
            centre, reach, worst = trial, trial_reach, float(trial_reach.max())
        else:
            step /= 2
    return centre


def _start(count: int, rng: np.random.Generator, spacing: float) -> np.ndarray:
    """A sunflower: a round, even start without overlaps to untangle."""
    index = np.arange(count, dtype=np.float64)
    distance = np.sqrt(index + 0.5) * spacing
    angle = index * GOLDEN + rng.uniform(0, 2 * math.pi)
    return np.stack([np.cos(angle) * distance, np.sin(angle) * distance], axis=1)


def layout(
    root: Group,
    links: Iterable[tuple[int, int]],
    degree: dict[int, int],
    previous: dict[str, tuple[float, float]] | None = None,
    seed: str = "",
) -> Result:
    """Lay out ``root`` (already split). ``previous`` maps item keys (``g:<key>`` and ``n:<id>``) to positions
    relative to their parent from an earlier layout; items found there start where they were."""
    previous = previous or {}
    home: dict[int, str] = {}
    parent_of: dict[str, str | None] = {root.key: None}
    groups: dict[str, Group] = {}

    def index(group: Group) -> None:
        groups[group.key] = group
        for note in group.notes:
            home[note] = group.key
        for child in group.children:
            parent_of[child.key] = group.key
            index(child)

    index(root)

    # Which item of a group contains a note: the chain of groups from the root to the note's home.
    def chain(note: int) -> list[str]:
        keys: list[str] = []
        key: str | None = home.get(note)
        while key is not None:
            keys.append(key)
            key = parent_of[key]
        return keys[::-1]

    chains: dict[int, list[str]] = {}
    edges_in: dict[str, dict[tuple[str, str], int]] = defaultdict(lambda: defaultdict(int))
    for a, b in links:
        if a == b or a not in home or b not in home:
            continue
        ca = chains.setdefault(a, chain(a))
        cb = chains.setdefault(b, chain(b))
        depth = 0
        while depth < len(ca) and depth < len(cb) and ca[depth] == cb[depth]:
            depth += 1
        owner = ca[depth - 1]
        item_a = f"g:{ca[depth]}" if depth < len(ca) else f"n:{a}"
        item_b = f"g:{cb[depth]}" if depth < len(cb) else f"n:{b}"
        pair = (item_a, item_b) if item_a < item_b else (item_b, item_a)
        edges_in[owner][pair] += 1

    relative: dict[str, tuple[float, float]] = {}
    radius: dict[str, float] = {}

    def place(group: Group, depth: int) -> float:
        keys: list[str] = []
        sizes: list[float] = []
        for child in group.children:
            keys.append(f"g:{child.key}")
            sizes.append(place(child, depth + 1))
        for note in group.notes:
            keys.append(f"n:{note}")
            sizes.append(note_radius(degree.get(note, 0)) + 12)
        if not keys:
            radius[group.key] = 30.0
            return 30.0
        rng = np.random.default_rng(stable_seed(seed + group.key))
        size = np.array(sizes, dtype=np.float64)
        gap = 40.0 if depth <= 1 else 16.0
        # Old positions where there are any; new items near what they link to, else on the sunflower.
        known = [k in previous for k in keys]
        pos = _start(len(keys), rng, float(np.mean(size)) * 1.9)
        order = sorted(range(len(keys)), key=lambda i: keys[i])
        pos = pos[np.argsort(order)]
        warm = sum(known) > len(keys) / 2
        slot = {k: i for i, k in enumerate(keys)}
        edges = [(slot[a], slot[b], w) for (a, b), w in edges_in.get(group.key, {}).items() if a in slot and b in slot]
        if any(known):
            for i, k in enumerate(keys):
                if known[i]:
                    pos[i] = previous[k]
            neighbours: dict[int, list[int]] = defaultdict(list)
            for a, b, _w in edges:
                neighbours[a].append(b)
                neighbours[b].append(a)
            for i in range(len(keys)):
                if not known[i]:
                    anchors = [j for j in neighbours[i] if known[j]]
                    if anchors:
                        pos[i] = pos[anchors].mean(axis=0) + rng.normal(0, size[i], 2)
        if group.children:
            _simulate(pos, size, edges, gap, warm)
        elif not all(known):
            pos = _pack(size, edges, pos, keep=False)
        pos -= _enclosing_centre(pos, size)
        extent = float(np.max(np.sqrt((pos**2).sum(axis=1)) + size))
        r = extent + (30.0 if depth <= 1 else 16.0)
        for i, k in enumerate(keys):
            relative[k] = (float(pos[i, 0]), float(pos[i, 1]))
        radius[group.key] = r
        return r

    place(root, 1)

    result = Result(groups={}, notes={})

    def assign(group: Group, x: float, y: float) -> None:
        rx, ry = relative.get(f"g:{group.key}", (0.0, 0.0))
        result.groups[group.key] = Placed(x, y, radius[group.key], rx, ry, parent_of[group.key])
        for child in group.children:
            px, py = relative[f"g:{child.key}"]
            assign(child, x + px, y + py)
        for note in group.notes:
            px, py = relative[f"n:{note}"]
            result.notes[note] = Placed(x + px, y + py, note_radius(degree.get(note, 0)), px, py, group.key)

    assign(root, 0.0, 0.0)
    return result


def free_spot(
    centre: tuple[float, float], group_r: float, taken: list[tuple[float, float, float]], r: float,
    near: tuple[float, float] | None, seed: int,
) -> tuple[float, float]:
    """A place for a new note inside a group without moving anything: the free candidate nearest ``near`` (or the
    middle). Candidates lie on a sunflower inside the circle; when none is free, the least crowded one."""
    cx, cy = centre
    rng = np.random.default_rng(seed)
    count = 400
    index = np.arange(count, dtype=np.float64)
    spread = max(group_r - r - 8, 1.0)
    distance = np.sqrt((index + 0.5) / count) * spread
    angle = index * GOLDEN + rng.uniform(0, 2 * math.pi)
    candidates = np.stack([cx + np.cos(angle) * distance, cy + np.sin(angle) * distance], axis=1)
    if taken:
        others = np.array(taken, dtype=np.float64)
        diff = candidates[:, None, :] - others[None, :, :2]
        clearance = (np.sqrt((diff**2).sum(axis=2)) - others[None, :, 2] - r - 4).min(axis=1)
    else:
        clearance = np.full(count, np.inf)
    target = np.array(near if near else centre, dtype=np.float64)
    closeness = np.sqrt(((candidates - target) ** 2).sum(axis=1))
    free = clearance >= 0
    if free.any():
        pick = int(np.argmin(np.where(free, closeness, np.inf)))
    else:
        pick = int(np.argmax(clearance))
    return float(candidates[pick, 0]), float(candidates[pick, 1])
