"""Finding notes by what they mean, not only by their words (Frag Lore, L7): a vector for every note from the
operator's service, kept in the database and refreshed when a note changes; a question's vector finds the notes
nearest to it, and every note its neighbours ("Similar notes" beside it).

* **Only with one service for all** (``ai_mode`` "shared") and a model for it (``ai_embed_model``). The vectors
  belong to the vault, not to a person: made with one account's key they would be paid by that account and lost with
  it. With each on their own, Lore looks things up by their words as before.
* **What goes out**: the first part of every note (``NOTE_CHARS``), once, and again when it changes, to the operator's
  own service. The operator's card says so. A question goes out as it is asked and stands in the asker's list.
* **Rights as everywhere**: a vector is only ever compared within the spaces the asker may read; the vectors
  themselves never leave the server.
* **Slowly and steadily**: the watcher reads in at most ``PASS_SECONDS`` per pass, in batches of ``BATCH``, the
  notes without a vector first, then the changed ones. A failure waits for the next pass; nothing else waits on it.

The vectors are normalised float32; the nearest are found with one product over a matrix kept in memory as float16
(100,000 notes with 768 numbers: about 150 MB), loaded again when vectors changed.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx
import numpy as np
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..models import Account, File, LoreVector, utcnow
from . import ai, index, paths, settings_service

logger = logging.getLogger("nexlore.meaning")

#: What of a note goes out to be turned into a vector: its title and the first part of its text.
NOTE_CHARS = 2_000
BATCH = 16
#: How long one pass of the watcher reads in at most.
PASS_SECONDS = 60.0
EMBED_SECONDS = 60.0
MAX_DIMS = 8_192
#: Below this a note is not "near" enough to count as found by its meaning. ⚠️ Not measured with a real model yet:
#: models differ in how near unrelated texts lie (often 0.3 to 0.5). Hence also ``SPREAD``.
NEAR = 0.35
#: For a question only notes this close to the best one count: a fixed threshold alone let unrelated notes in with
#: every question (seen with the stand-in of the screenshots, 05.10.2026), eating the material's budget.
SPREAD = 0.08
SIMILAR = 5


class MeaningError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def model(db: Session) -> str:
    return str(settings_service.get(db, "ai_embed_model") or "").strip()


def enabled(db: Session) -> bool:
    """Whether notes are found by their meaning: AI allowed, one service for all, complete, with a model for this."""
    if not ai.allowed(db) or not settings_service.get(db, "lore_allowed") or ai.mode(db) != "shared" or not model(db):
        return False
    return bool(settings_service.get(db, "ai_shared_url"))


def _text(path: str, title: str) -> str:
    """What goes out for a note: the title, then its text without front matter and code, up to NOTE_CHARS."""
    try:
        content = index.decode(paths.vault_root().joinpath(*path.split("/")).read_bytes())
    except OSError:
        return ""
    lines: list[str] = []
    fence = False
    body = content.splitlines()
    if body and body[0].strip() == "---":
        for number, line in enumerate(body[1:], start=1):
            if line.strip() == "---":
                body = body[number + 1 :]
                break
    for line in body:
        if line.strip().startswith(("```", "~~~")):
            fence = not fence
            continue
        if not fence and line.strip():
            lines.append(line.strip())
    return (title + "\n" + "\n".join(lines))[:NOTE_CHARS].strip()


def _digest(text: str, used: str) -> str:
    return hashlib.sha256((used + "\x00" + text).encode("utf-8")).hexdigest()


def embed(db: Session, texts: list[str]) -> list[np.ndarray]:
    """The vectors of ``texts`` from the operator's service (``…/embeddings``), normalised; raises MeaningError."""
    url = str(settings_service.get(db, "ai_shared_url") or "")
    used = model(db)
    if not url or not used:
        raise MeaningError("meaning_off")
    try:
        place = ai.checked_target(db, urljoin(ai.check_address(url), "embeddings"), trusted=True)
    except ai.AiError as exc:
        raise MeaningError(exc.code) from exc
    extensions = {"sni_hostname": place.host} if place.scheme == "https" else {}
    headers = {**ai.headers_for(ai.shared_key(db)), "Host": place.named}
    try:
        with httpx.Client(timeout=EMBED_SECONDS, follow_redirects=False, transport=ai.transport,
                          trust_env=False, verify=ai.tls()) as client:
            answer = client.post(place.url, headers=headers, extensions=extensions,
                                 json={"model": used, "input": texts})
    except httpx.HTTPError as exc:
        raise MeaningError("ai_unreachable") from exc
    if answer.status_code != 200 or len(answer.content) > ai.MAX_ANSWER * 8:
        raise MeaningError("meaning_refused" if answer.status_code != 200 else "ai_unreadable")
    try:
        data = answer.json()["data"]
        ordered = sorted(data, key=lambda item: int(item.get("index", 0)))
        vectors = [np.asarray(item["embedding"], dtype=np.float32) for item in ordered]
    except (ValueError, KeyError, TypeError) as exc:
        raise MeaningError("ai_unreadable") from exc
    if len(vectors) != len(texts) or any(v.ndim != 1 or not 0 < v.size <= MAX_DIMS for v in vectors):
        raise MeaningError("ai_unreadable")
    if len({v.size for v in vectors}) != 1:
        raise MeaningError("ai_unreadable")
    out = []
    for vector in vectors:
        length = float(np.linalg.norm(vector))
        out.append(vector / length if length > 0 else vector)
    return out


# --- Reading in ---------------------------------------------------------------------------------------------------

_cache_lock = threading.Lock()
_reading = threading.Lock()
#: (model, generation) -> file ids, space ids, the matrix; loaded again when ``_generation`` moved on.
_cache: dict[str, tuple[int, np.ndarray, np.ndarray, np.ndarray]] = {}
_generation = 0


def _changed() -> None:
    global _generation
    with _cache_lock:
        _generation += 1


def waiting(db: Session) -> list[File]:
    """Notes whose vector is missing, made with another model, or older than the note."""
    used = model(db)
    known = {row.file_id: (row.model, row.source_hash) for row in db.execute(
        select(LoreVector.file_id, LoreVector.model, LoreVector.source_hash))}
    notes = db.scalars(select(File).where(File.is_note.is_(True), File.deleted_at.is_(None)).order_by(File.id))
    missing, stale = [], []
    for note in notes:
        have = known.get(note.id)
        if have is None or have[0] != used:
            missing.append(note)
        elif have[1] != note.hash:
            stale.append(note)
    return missing + stale


def catch_up(db: Session, *, seconds: float = PASS_SECONDS) -> int:
    """Reads in what waits, for at most ``seconds``; the number of notes that got a vector. A failure stops the pass
    and is logged by its kind, never with text."""
    if not enabled(db):
        return 0
    # One reading at a time (the watcher's pass, the one started by the operator's card): two would both write the
    # vector of the same note. Who comes second waits, then finds less to do.
    if not _reading.acquire(timeout=seconds + EMBED_SECONDS):
        return 0
    try:
        return _catch_up(db, seconds)
    finally:
        _reading.release()


def _catch_up(db: Session, seconds: float) -> int:
    used = model(db)
    end = time.monotonic() + seconds
    done = 0
    db.expire_all()
    queue = waiting(db)
    while queue and time.monotonic() < end:
        batch, queue = queue[:BATCH], queue[BATCH:]
        texts = [_text(note.path, note.title) or note.title or note.path for note in batch]
        try:
            vectors = embed(db, texts)
        except MeaningError as exc:
            logger.info("Reading notes in by their meaning stopped: %s", exc.code)
            break
        for note, text, vector in zip(batch, texts, vectors, strict=True):
            row = db.get(LoreVector, note.id)
            if row is None:
                row = LoreVector(file_id=note.id)
                db.add(row)
            row.model = used
            row.source_hash = note.hash
            row.text_hash = _digest(text, used)
            row.dims = int(vector.size)
            row.vector = vector.astype(np.float32).tobytes()
            row.updated_at = utcnow()
        db.commit()
        done += len(batch)
    if done:
        _changed()
        logger.info("Read %s note(s) in by their meaning", done)
    return done


def read_in_now() -> None:
    """Reads in at once, in the background, when the operator just chose a model: the watcher would wait for its
    next pass."""
    from ..db import SessionLocal

    def work() -> None:
        try:
            with SessionLocal() as db:
                while catch_up(db):
                    pass
        except Exception:
            logger.exception("Reading notes in by their meaning failed")

    threading.Thread(target=work, name="meaning-read-in", daemon=True).start()


def progress(db: Session) -> dict[str, int]:
    used = model(db)
    total = db.scalar(select(func.count()).select_from(File).where(File.is_note.is_(True),
                                                                   File.deleted_at.is_(None))) or 0
    have = db.scalar(select(func.count()).select_from(LoreVector).join(File, File.id == LoreVector.file_id).where(
        LoreVector.model == used, LoreVector.source_hash == File.hash, File.deleted_at.is_(None))) or 0
    return {"done": int(have), "total": int(total)}


def forget(db: Session) -> int:
    """Every vector goes (the model changed, or the operator switched it off)."""
    removed = int(db.execute(delete(LoreVector)).rowcount or 0)
    db.commit()
    _changed()
    return removed


# --- Finding ------------------------------------------------------------------------------------------------------


def _matrix(db: Session) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    used = model(db)
    with _cache_lock:
        cached = _cache.get(used)
        if cached is not None and cached[0] == _generation:
            return cached[1], cached[2], cached[3]
        generation = _generation
    rows = db.execute(
        select(LoreVector.file_id, File.space_id, LoreVector.vector, LoreVector.dims)
        .join(File, File.id == LoreVector.file_id)
        .where(LoreVector.model == used, File.deleted_at.is_(None), File.is_note.is_(True))
    ).all()
    dims = max((row.dims for row in rows), default=0)
    rows = [row for row in rows if row.dims == dims]
    ids = np.asarray([row.file_id for row in rows], dtype=np.int64)
    spaces = np.asarray([row.space_id for row in rows], dtype=np.int64)
    matrix = (np.frombuffer(b"".join(row.vector for row in rows), dtype=np.float32).reshape(len(rows), dims)
              .astype(np.float16) if rows else np.zeros((0, 0), dtype=np.float16))
    with _cache_lock:
        _cache.clear()
        _cache[used] = (generation, ids, spaces, matrix)
    return ids, spaces, matrix


@dataclass
class Near:
    file_id: int
    score: float


def nearest(db: Session, vector: np.ndarray, spaces: set[int], *, limit: int, leave_out: set[int] | None = None,
            least: float | None = None) -> list[Near]:
    """The notes nearest to ``vector`` in ``spaces`` (the asker's readable ones, already chosen), best first, at
    least ``least`` near (``NEAR`` when not given)."""
    least = NEAR if least is None else least
    ids, owners, matrix = _matrix(db)
    if not len(ids) or matrix.shape[1] != vector.size or not spaces:
        return []
    allowed = np.isin(owners, np.fromiter(spaces, dtype=np.int64))
    if leave_out:
        allowed &= ~np.isin(ids, np.fromiter(leave_out, dtype=np.int64))
    if not allowed.any():
        return []
    scores = (matrix[allowed].astype(np.float32) @ vector.astype(np.float32))
    picked = ids[allowed]
    order = np.argsort(-scores)[:limit]
    return [Near(int(picked[i]), float(scores[i])) for i in order if scores[i] >= least]


def question_near(db: Session, account: Account, question: str, spaces: set[int], *, limit: int,
                  leave_out: set[int]) -> list[Near]:
    """The notes a question means, in ``spaces``. What went out stands in the asker's list."""
    if not enabled(db) or not spaces:
        return []
    body = {"model": model(db), "input": [question]}
    try:
        vector = embed(db, [question])[0]
    except MeaningError as exc:
        ai.keep_event(db, account, model=model(db), task="lore_meaning", target="", body=body, tokens_in=0,
                      tokens_out=0, failed=exc.code)
        logger.info("A question could not be turned into a vector: %s", exc.code)
        return []
    ai.keep_event(db, account, model=model(db), task="lore_meaning", target="", body=body, tokens_in=0,
                  tokens_out=0, failed="")
    return close_to_best(nearest(db, vector, spaces, limit=limit, leave_out=leave_out))


def close_to_best(found: list[Near], spread: float | None = None) -> list[Near]:
    """Of the nearest (best first), those within ``SPREAD`` of the best."""
    spread = SPREAD if spread is None else spread
    return [near for near in found if found and near.score >= found[0].score - spread]


def similar(db: Session, file_id: int, spaces: set[int], *, limit: int = SIMILAR) -> list[Near]:
    """The notes nearest to a note, in ``spaces``; nothing while the note has no vector yet."""
    row = db.get(LoreVector, file_id)
    if row is None or row.model != model(db):
        return []
    vector = np.frombuffer(row.vector, dtype=np.float32)
    return nearest(db, vector, spaces, limit=limit, leave_out={file_id}, least=0.0)


def shown(db: Session, found: list[Near]) -> list[dict[str, Any]]:
    if not found:
        return []
    files = {file.id: file for file in db.scalars(select(File).where(File.id.in_([near.file_id for near in found])))}
    return [{"path": files[near.file_id].path, "title": files[near.file_id].title or
             files[near.file_id].path.rsplit("/", 1)[-1].removesuffix(".md"), "score": round(near.score, 3)}
            for near in found if near.file_id in files]

