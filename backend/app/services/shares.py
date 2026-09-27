"""Public reading pages: a note or a folder behind a link, optionally with an end date and a password.

A way out of the house, so closed until the operator opens it (``shares_allowed``); closed again, every link
answers like one that never existed, and opened again, they work as before.

**What leaves the house is only what is shared.** The page gets the text of the note without its front matter and
without ``%%comments%%``; a link to a note outside the share arrives without a target, so the page shows its text
only. A file (a picture, a PDF) is reachable when a note inside the share links it: it belongs to that note.
Everything is answered by the share's token alone; a path from the page is only ever looked up below the share.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import posixpath
import secrets
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import File, Link, Share, utcnow
from ..security import hash_password, verify_password
from . import index, mdparse, paths, settings_service

logger = logging.getLogger("nexlore.shares")

#: How long a link may run, in days; None runs until it is withdrawn.
SHARE_DAYS = (1, 7, 30, 365)
COOKIE_PREFIX = "nexlore_share_"


class ShareError(Exception):
    def __init__(self, code: str, text: str, status: int = 400) -> None:
        super().__init__(text)
        self.code, self.text, self.status = code, text, status


def allowed(db: Session) -> bool:
    return bool(settings_service.get(db, "shares_allowed"))


def create(db: Session, *, space_id: int, path: str, by: int, days: int | None, password: str) -> Share:
    if days is not None and days not in SHARE_DAYS:
        raise ShareError("invalid_days", "Choose 1, 7, 30 or 365 days, or no end.", 422)
    full = paths.resolve(path)
    is_folder = full.is_dir()
    if not is_folder:
        live = db.scalar(select(File).where(File.path == path, File.deleted_at.is_(None)))
        if live is None or not live.is_note:
            raise ShareError("not_found", "Only notes and folders can be shared.", 404)
    share = Share(
        token=secrets.token_urlsafe(24), space_id=space_id, path=path, is_folder=is_folder, created_by=by,
        expires_at=utcnow() + timedelta(days=days) if days else None,
        password_hash=hash_password(password) if password else "",
    )
    db.add(share)
    db.commit()
    guarded = bool(share.password_hash)
    logger.info("Share created id=%s folder=%s ends=%s guarded=%s", share.id, is_folder, days or "-", guarded)
    return share


def find(db: Session, token: str) -> Share | None:
    """The share behind a token, when sharing is open and the share has not run out."""
    if not allowed(db):
        return None
    share = db.scalar(select(Share).where(Share.token == token))
    if share is None or (share.expires_at is not None and share.expires_at <= utcnow()):
        return None
    return share


# --- The password ---------------------------------------------------------------------------------------------------


def _pass_key() -> bytes:
    secret = get_settings().resolved_secret_key().encode("utf-8")
    return hashlib.sha256(b"nexlore-share-pass:" + secret).digest()


def pass_value(share: Share) -> str:
    """What the browser keeps after the right password: bound to this share and to its password (a share made anew
    under the same token does not exist; a changed secret key ends every pass)."""
    return hmac.new(_pass_key(), f"{share.token}:{share.password_hash}".encode(), hashlib.sha256).hexdigest()


def unlocked(share: Share, cookie: str | None) -> bool:
    return not share.password_hash or (cookie is not None and hmac.compare_digest(cookie, pass_value(share)))


def check_password(share: Share, password: str) -> bool:
    return verify_password(password, share.password_hash)


# --- What the page may see ------------------------------------------------------------------------------------------


def root(share: Share) -> str:
    """The folder the share's paths are relative to."""
    return share.path if share.is_folder else posixpath.dirname(share.path)


def notes(db: Session, share: Share) -> list[File]:
    if not share.is_folder:
        note = db.scalar(select(File).where(File.path == share.path, File.deleted_at.is_(None)))
        return [note] if note is not None and note.is_note else []
    prefix = share.path + "/"
    return list(
        db.scalars(
            select(File)
            .where(
                File.space_id == share.space_id, File.deleted_at.is_(None), File.is_note.is_(True),
                File.path > prefix, File.path < share.path + "0",
            )
            .order_by(File.path)
        )
    )


def relative(share: Share, path: str) -> str:
    return path[len(root(share)) + 1 :] if root(share) else path


def note_at(db: Session, share: Share, rel: str | None) -> File:
    """A note of the share by its path relative to the share; for a note share the note itself."""
    if not share.is_folder:
        found = notes(db, share)
        if not found or (rel is not None and rel != relative(share, found[0].path)):
            raise ShareError("not_found", "No such page.", 404)
        return found[0]
    if not rel:
        raise ShareError("not_found", "No such page.", 404)
    try:
        wanted = paths.parse(f"{share.path}/{rel}")
    except paths.PathError as exc:
        raise ShareError("not_found", "No such page.", 404) from exc
    if not wanted.startswith(share.path + "/"):
        raise ShareError("not_found", "No such page.", 404)
    note = db.scalar(select(File).where(File.path == wanted, File.deleted_at.is_(None), File.is_note.is_(True)))
    if note is None:
        raise ShareError("not_found", "No such page.", 404)
    return note


def inside(share: Share, path: str) -> bool:
    return path == share.path or (share.is_folder and path.startswith(share.path + "/"))


@dataclass
class PublicLink:
    kind: str
    target: str
    #: A note of the share, relative to it; None: the page shows the text only.
    note: str | None
    #: A file the page may show or offer.
    file: int | None


@dataclass
class Page:
    path: str
    title: str
    content: str
    links: list[PublicLink]


def _shown_text(text: str, link: mdparse.LinkRef) -> str:
    """What a link that leads nowhere public shows: its own words, never where it pointed."""
    written = text[link.start : link.end]
    if link.kind in (mdparse.WIKI, mdparse.EMBED):
        inner = written.lstrip("!")[2:-2]
        label = inner.split("|", 1)[1] if "|" in inner else inner.split("#", 1)[0]
        return label.strip()
    close = written.find("](")
    if close < 0:
        close = written.find("][")
    return written.lstrip("!")[1:close - (1 if written.startswith("!") else 0)] if close > 0 else ""


def page(db: Session, share: Share, note: File) -> Page:
    data = paths.resolve(note.path).read_bytes()
    text = index.decode(data)
    parsed = mdparse.parse(text)
    targets: dict[tuple[str, str], File | None] = {}
    for kind, target, target_id in db.execute(
        select(Link.kind, Link.target, Link.target_id).where(Link.source_id == note.id).order_by(Link.id)
    ):
        found = db.get(File, target_id) if target_id is not None else None
        targets.setdefault((kind, target), found if found is not None and found.deleted_at is None else None)

    def public(found: File | None) -> bool:
        # A note of the share, or a file this note uses (it belongs to the note). Never anything of another space
        # (``[[Space/Note]]``): a public page shows such a link as its words.
        if found is None or found.space_id != share.space_id:
            return False
        return not found.is_note or inside(share, found.path)

    # Front matter and comments stay at home: they are notes to oneself, not part of the page. A link out of the
    # share becomes its words: the path it pointed to is nobody's business outside.
    cuts: list[tuple[int, int, str]] = [(start, end, "") for start, end in parsed.comments]
    if parsed.body_start:
        cuts.append((0, parsed.body_start, ""))
    for link in parsed.links:
        if not public(targets.get((link.kind, link.target))):
            cuts.append((link.start, link.end, _shown_text(text, link)))
    pieces: list[str] = []
    position = 0
    for start, end, instead in sorted(cuts):
        if start < position:
            continue
        pieces.append(text[position:start])
        pieces.append(instead)
        position = end
    pieces.append(text[position:])
    links: list[PublicLink] = []
    for (kind, target), found in targets.items():
        if not public(found):
            continue
        assert found is not None
        if found.is_note:
            links.append(PublicLink(kind, target, relative(share, found.path), None))
        else:
            links.append(PublicLink(kind, target, None, found.id))
    return Page(relative(share, note.path), note.title, "".join(pieces), links)


def file_for(db: Session, share: Share, file_id: int) -> File:
    """A file a note of the share links, or ShareError: nothing else of the space is reachable."""
    file = db.get(File, file_id)
    if file is None or file.deleted_at is not None or file.is_note or file.space_id != share.space_id:
        raise ShareError("not_found", "No such file.", 404)
    sources = select(Link.source_id).where(Link.target_id == file.id)
    for source in db.scalars(select(File).where(File.id.in_(sources), File.deleted_at.is_(None))):
        if inside(share, source.path):
            return file
    raise ShareError("not_found", "No such file.", 404)
