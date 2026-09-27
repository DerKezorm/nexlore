"""Automatic topics: notes grouped by what they are about, named by three words.

Every note becomes a vector of its words (title and tags count more than the text), weighted so that words common to
all notes count little (TF-IDF), folded into 128 numbers by a fixed random projection. Linked notes lean towards
each other: a note's vector takes in half of its neighbours' mean. Then spherical k-means splits the space into
topics, and each topic that is still big into subtopics, down to a few hundred notes. A topic is named by the three
words that set it apart from its siblings.

Nothing here is random in a way that changes between runs: the projection and the start of every k-means come from
fixed seeds. New topics are matched to the ones before by the notes they share and keep their key, so colours and
places on the map stay where people know them. The work runs at night or when a space's manager asks, never while
somebody types.
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import FTS_TABLE, File, Tag
from .graphlayout import MAX_ITEMS, stable_seed

logger = logging.getLogger("nexlore.graph")

DIMENSIONS = 128
#: Words of the text that are read per note; titles and tags always whole.
BODY_CHARS = 4000
MAX_TERMS_PER_NOTE = 40
MAX_DEPTH = 3
WORD = re.compile(r"[^\W\d_]{3,}", re.UNICODE)

# Words that say nothing about a topic, German and English.
STOPWORDS = frozenset(
    re.split(
        r"\s+",
        """
    aber alle allem allen aller alles also als am an ander andere anderem anderen anderer anderes anderm andern
    anderr anders auch auf aus bei bin bis bist da damit dann das dass dasselbe dazu dein deine deinem deinen deiner
    dem demselben den denn denselben der derer derselbe derselben des desselben dessen dich die dies diese dieselbe
    dieselben diesem diesen dieser dieses dir doch dort du durch ein eine einem einen einer eines einig einige einigem
    einigen einiger einiges einmal er es etwas euch euer eure eurem euren eurer eures für gegen gewesen hab habe haben
    hat hatte hatten hier hin hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer ihres im in indem ins ist jede jedem
    jeden jeder jedes jene jenem jenen jener jenes jetzt kann kein keine keinem keinen keiner keines können könnte
    machen man manche manchem manchen mancher manches mein meine meinem meinen meiner meines mich mir mit muss musste
    nach nicht nichts noch nun nur oder ohne sehr sein seine seinem seinen seiner seines selbst sich sie sind so
    solche solchem solchen solcher solches soll sollte sondern sonst über um und uns unsere unserem unseren unser
    unseres unter viel vom von vor während war waren warst was weg weil weiter welche welchem welchen welcher welches
    wenn werde werden wie wieder will wir wird wirst wo wollen wollte würde würden zu zum zur zwar zwischen noch
    schon immer mehr heute gibt geht ganz gut neue neuen neu erst etwa
    about above after again against all also and any are because been before being below between both but can did
    does doing down during each few for from further had has have having her here hers herself him himself his how
    into its itself just more most myself nor not now off once only other our ours ourselves out over own same she
    should some such than that the their theirs them themselves then there these they this those through too under
    until very was were what when where which while who whom why will with would you your yours yourself yourselves
    get got one two new use used using also may might must need like see note notes
    """.strip(),
    )
)


@dataclass
class Topic:
    key: str
    name: str
    children: list[Topic] = field(default_factory=list)


@dataclass
class Topics:
    roots: list[Topic]
    #: Note id to the key of the (deepest) topic it is in.
    assignment: dict[int, str]


def _words(value: str) -> list[str]:
    return [w for w in (m.group(0).casefold() for m in WORD.finditer(value)) if w not in STOPWORDS]


def _texts(db: Session, space_id: int, notes: Any) -> dict[int, Counter[str]]:
    """The weighted words of every note: title three times, tags three times, the start of the text once."""
    counts: dict[int, Counter[str]] = {n: Counter() for n in notes.ids}
    for file_id in notes.ids:
        for word in _words(notes.title.get(file_id, "")):
            counts[file_id][word] += 3
    for file_id, tag in db.execute(
        select(Tag.file_id, Tag.tag).join(File, File.id == Tag.file_id).where(File.space_id == space_id)
    ):
        if file_id in counts:
            for word in _words(re.sub(r"[/_-]", " ", tag)):
                counts[file_id][word] += 3
    ids = notes.ids
    for start in range(0, len(ids), 900):
        part = ids[start : start + 900]
        marks = ",".join(str(int(i)) for i in part)
        for rowid, body in db.execute(
            text(f"SELECT rowid, substr(body, 1, {BODY_CHARS}) FROM {FTS_TABLE} WHERE rowid IN ({marks})")  # noqa: S608
        ):
            if rowid in counts and body:
                counts[rowid].update(_words(body))
    return counts


def _projection(term: str) -> np.ndarray:
    return np.random.default_rng(stable_seed("term:" + term)).standard_normal(DIMENSIONS).astype(np.float32)


def _kmeans(vectors: np.ndarray, k: int, seed: int) -> np.ndarray:
    """Spherical k-means with a k-means++ start from a fixed seed. Returns the cluster of each row."""
    n = len(vectors)
    rng = np.random.default_rng(seed)
    centres = [vectors[int(rng.integers(n))]]
    closest = 1 - vectors @ centres[0]
    for _ in range(1, k):
        weights = np.clip(closest, 0, None) ** 2
        total = float(weights.sum())
        pick = int(rng.choice(n, p=weights / total)) if total > 0 else int(rng.integers(n))
        centres.append(vectors[pick])
        closest = np.minimum(closest, 1 - vectors @ vectors[pick])
    centre = np.stack(centres)
    labels = np.zeros(n, dtype=np.int64)
    for _ in range(30):
        new = np.argmax(vectors @ centre.T, axis=1)
        if np.array_equal(new, labels) and _ > 0:
            break
        labels = new
        for c in range(k):
            members = vectors[labels == c]
            if len(members):
                mean = members.sum(axis=0)
                norm = float(np.linalg.norm(mean))
                centre[c] = mean / norm if norm > 0 else centre[c]
    return labels


def _choose(vectors: np.ndarray, most: int, seed: int) -> np.ndarray:
    """k-means for every k from 2 to ``most``; the one whose notes sit clearly closer to their own topic than to
    the next (mean silhouette on cosine distance, over at most 4000 notes) wins."""
    n = len(vectors)
    rng = np.random.default_rng(seed)
    sample = rng.choice(n, size=min(n, 4000), replace=False) if n > 4000 else np.arange(n)
    best: tuple[float, np.ndarray] | None = None
    for k in range(2, max(2, most) + 1):
        labels = _kmeans(vectors, k, seed + k)
        if len(np.unique(labels)) < 2:
            continue
        centres = np.stack([
            vectors[labels == c].mean(axis=0) if np.any(labels == c) else np.zeros(vectors.shape[1])
            for c in range(k)
        ])
        norms = np.linalg.norm(centres, axis=1)
        centres[norms > 0] /= norms[norms > 0, None]
        similarity = vectors[sample] @ centres.T
        own = similarity[np.arange(len(sample)), labels[sample]]
        similarity[np.arange(len(sample)), labels[sample]] = -np.inf
        other = similarity.max(axis=1)
        a, b = 1 - own, 1 - other
        score = float(np.mean((b - a) / np.maximum(np.maximum(a, b), 1e-9)))
        if best is None or score > best[0] + 1e-9:
            best = (score, labels)
    return best[1] if best is not None else np.zeros(n, dtype=np.int64)


def compute(
    db: Session, space_id: int, notes: Any, links: list[tuple[int, int]], previous: dict[int, str] | None = None
) -> Topics:
    """Topics of a space, matched to ``previous`` (note id to topic key) where they overlap."""
    previous = previous or {}
    ids = list(notes.ids)
    if not ids:
        return Topics(roots=[], assignment={})
    counts = _texts(db, space_id, notes)
    df: Counter[str] = Counter()
    for c in counts.values():
        df.update(c.keys())
    n = len(ids)
    lowest = 2 if n >= 20 else 1
    vocabulary = [t for t, d in df.items() if lowest <= d <= max(2, 0.5 * n)]
    index = {t: i for i, t in enumerate(sorted(vocabulary))}
    idf = np.array([math.log(n / df[t]) + 1 for t in sorted(vocabulary)], dtype=np.float32)
    projection = np.stack([_projection(t) for t in sorted(vocabulary)]) if vocabulary else np.zeros((0, DIMENSIONS))

    rows: list[list[tuple[int, float]]] = []
    vectors = np.zeros((n, DIMENSIONS), dtype=np.float32)
    for row, file_id in enumerate(ids):
        weighted = [(index[t], math.log1p(c) * float(idf[index[t]])) for t, c in counts[file_id].items() if t in index]
        weighted.sort(key=lambda item: -item[1])
        weighted = weighted[:MAX_TERMS_PER_NOTE]
        rows.append(weighted)
        if weighted:
            cols = np.array([w[0] for w in weighted])
            vals = np.array([w[1] for w in weighted], dtype=np.float32)
            vectors[row] = vals @ projection[cols]
    norms = np.linalg.norm(vectors, axis=1)
    has_words = norms > 0
    vectors[has_words] /= norms[has_words, None]

    # Linked notes lean towards each other.
    position = {file_id: row for row, file_id in enumerate(ids)}
    if links:
        src = np.array([position[a] for a, b in links if a in position and b in position] +
                       [position[b] for a, b in links if a in position and b in position])
        dst = np.array([position[b] for a, b in links if a in position and b in position] +
                       [position[a] for a, b in links if a in position and b in position])
        if len(src):
            order = np.argsort(src, kind="stable")
            src, dst = src[order], dst[order]
            starts = np.flatnonzero(np.r_[True, src[1:] != src[:-1]])
            sums = np.add.reduceat(vectors[dst], starts, axis=0)
            degree = np.diff(np.r_[starts, len(src)])
            vectors[src[starts]] += 0.5 * sums / degree[:, None]
    norms = np.linalg.norm(vectors, axis=1)
    usable = norms > 0
    vectors[usable] /= norms[usable, None]

    # Term weights per note for naming: a flat list (note row, term, weight).
    note_rows = np.array([r for r, weighted in enumerate(rows) for _ in weighted], dtype=np.int64)
    term_cols = np.array([t for weighted in rows for t, _ in weighted], dtype=np.int64)
    term_vals = np.array([w for weighted in rows for _, w in weighted], dtype=np.float64)
    terms = sorted(vocabulary)

    def profile(members: np.ndarray) -> np.ndarray:
        if not len(members) or not len(term_cols):
            return np.zeros(len(terms))
        mask = np.isin(note_rows, members)
        return np.bincount(term_cols[mask], term_vals[mask], len(terms)) / len(members)

    def name_of(members: np.ndarray, parent_profile: np.ndarray, taken: set[str]) -> str:
        score = profile(members) - parent_profile
        chosen: list[str] = []
        for i in np.argsort(-score, kind="stable"):
            if score[i] <= 0 or len(chosen) == 3:
                break
            if terms[i] not in taken:
                chosen.append(terms[i])
        return " · ".join(chosen)

    assignment: dict[int, str] = {}
    old_members: dict[str, set[int]] = defaultdict(set)
    for file_id, key in previous.items():
        parts = key.split("/")
        for depth in range(1, len(parts) + 1):
            old_members["/".join(parts[:depth])].add(file_id)

    def split(members: np.ndarray, prefix: str, depth: int, parent_profile: np.ndarray,
              taken: set[str]) -> list[Topic]:
        size = len(members)
        most = min(12 if depth == 1 else 8, size // 3)
        if most < 2:
            return []
        labels = _choose(vectors[members], most, stable_seed(f"{space_id}:{prefix}"))
        clusters = [members[labels == c] for c in range(int(labels.max()) + 1)]
        clusters = [c for c in clusters if len(c)]
        if len(clusters) < 2:
            return []
        # Keys of the topics before: the one sharing most notes keeps its key.
        wanted = [f"{prefix}{i}" for i in range(1000)]
        known = sorted({key for key in old_members if key.startswith(prefix) and "/" not in key[len(prefix):]})
        overlaps = []
        for ci, cluster in enumerate(clusters):
            ids_here = {ids[r] for r in cluster}
            for key in known:
                shared = len(ids_here & old_members[key])
                if shared:
                    overlaps.append((shared, ci, key))
        overlaps.sort(key=lambda item: (-item[0], item[1], item[2]))
        keys: dict[int, str] = {}
        used: set[str] = set()
        for _shared, ci, key in overlaps:
            if ci not in keys and key not in used:
                keys[ci] = key
                used.add(key)
        free = (w for w in wanted if w not in used and w not in old_members)
        for ci in range(len(clusters)):
            if ci not in keys:
                keys[ci] = next(free)
        topics: list[Topic] = []
        own = profile(members)
        for ci, cluster in sorted(enumerate(clusters), key=lambda item: keys[item[0]]):
            key = keys[ci]
            topic = Topic(key=key, name=name_of(cluster, own, taken))
            if len(cluster) > MAX_ITEMS and depth < MAX_DEPTH:
                topic.children = split(cluster, key + "/", depth + 1, profile(cluster),
                                       taken | set(topic.name.split(" · ")))
            if not topic.children:
                for r in cluster:
                    assignment[ids[int(r)]] = key
            topics.append(topic)
        return topics

    with_words = np.flatnonzero(usable)
    roots = split(with_words, "k:", 1, profile(np.arange(n)), set()) if len(with_words) >= 4 else []
    if not roots and len(with_words):
        roots = [Topic(key="k:0", name=name_of(with_words, np.zeros(len(terms)), set()))]
        for r in with_words:
            assignment[ids[int(r)]] = "k:0"
    logger.info("Topics worked out space=%s notes=%s topics=%s", space_id, n, len(roots))
    # Notes without a single usable word are in no topic; the graph gives them a group of their own.
    return Topics(roots=roots, assignment=assignment)
