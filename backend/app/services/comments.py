"""
Comments in the margin: threads on a place in a note, kept in the database and never in the file, so a note read
elsewhere (Obsidian, a sync, git) stays as it was.

A thread holds on to the words it was started on (``quote``) and a little of what stood before and after them, so the
page finds the place again after the text around it changed; when the words are gone, the thread stays and says so.
Whoever may read the note may comment and reply; one's own words may be changed or taken back. A thread is closed
(and opened again) by whoever started it or may write in the space; a manager of the space may take back any comment.
``@name`` names somebody: the thread comes up in their "new since your last visit" until they open the note.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import quote

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account, Comment, File, Membership, utcnow
from . import rights

MAX_BODY = 5000
MAX_QUOTE = 500
MAX_CONTEXT = 80
#: Threads one note may carry; enough for any real discussion, a wall against a script.
MAX_THREADS = 500
MAX_REPLIES = 500

MENTION = re.compile(r"(?<![\w@])@([\w][\w.-]{0,63})")


class CommentError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass
class Who:
    id: int
    name: str
    may_write: bool
    may_manage: bool


def mentioned(text: str) -> set[str]:
    return {match.group(1).casefold().rstrip(".") for match in MENTION.finditer(text)}


def _clean(body: str) -> str:
    text = body.replace("\r\n", "\n").strip()
    if not text:
        raise CommentError("empty", "A comment needs words.", 422)
    if len(text) > MAX_BODY:
        raise CommentError("too_long", "A comment holds at most 5000 characters.", 422)
    return text


def _out(comment: Comment, who: Who) -> dict[str, Any]:
    return {
        "id": comment.id, "author": comment.author, "body": comment.body, "created_at": comment.created_at,
        "edited_at": comment.edited_at, "mine": comment.account_id == who.id,
    }


def threads(db: Session, file_id: int, who: Who) -> list[dict[str, Any]]:
    """The threads of a note, open ones first, each with its comments in order."""
    rows = list(db.scalars(select(Comment).where(Comment.file_id == file_id).order_by(Comment.id)))
    roots = [row for row in rows if row.thread_id is None]
    replies: dict[int, list[Comment]] = {}
    for row in rows:
        if row.thread_id is not None:
            replies.setdefault(row.thread_id, []).append(row)
    out = []
    for root in roots:
        out.append({
            "id": root.id, "quote": root.quote, "before": root.before, "after": root.after,
            "resolved": root.resolved_at is not None, "resolved_by": root.resolved_by,
            "may_resolve": who.may_write or root.account_id == who.id,
            "comments": [_out(item, who) for item in [root, *replies.get(root.id, [])]],
        })
    out.sort(key=lambda thread: (thread["resolved"], thread["id"]))
    return out


def start(db: Session, file: File, who: Who, *, quote: str, before: str, after: str, body: str) -> Comment:
    text = _clean(body)
    quote = quote.strip()
    if not quote or len(quote) > MAX_QUOTE:
        raise CommentError("invalid_input", "Choose between one and 500 characters of the note to comment on.", 422)
    roots = select(func.count()).select_from(Comment).where(Comment.file_id == file.id, Comment.thread_id.is_(None))
    count = db.scalar(roots)
    if (count or 0) >= MAX_THREADS:
        raise CommentError("too_many", "This note has as many threads as it may.", 409)
    comment = Comment(
        file_id=file.id, space_id=file.space_id, thread_id=None, account_id=who.id, author=who.name, body=text,
        quote=quote, before=before[-MAX_CONTEXT:], after=after[:MAX_CONTEXT],
    )
    db.add(comment)
    db.commit()
    _tell(db, file, comment, set())
    return comment


def _root(db: Session, file_id: int, thread_id: int) -> Comment:
    root = db.get(Comment, thread_id)
    if root is None or root.file_id != file_id or root.thread_id is not None:
        raise CommentError("not_found", "No such thread.", 404)
    return root


def reply(db: Session, file_id: int, thread_id: int, who: Who, body: str) -> Comment:
    root = _root(db, file_id, thread_id)
    text = _clean(body)
    count = db.scalar(select(func.count()).select_from(Comment).where(Comment.thread_id == root.id))
    if (count or 0) >= MAX_REPLIES:
        raise CommentError("too_many", "This thread has as many replies as it may.", 409)
    comment = Comment(
        file_id=root.file_id, space_id=root.space_id, thread_id=root.id, account_id=who.id, author=who.name, body=text,
    )
    db.add(comment)
    db.commit()
    taking_part = {root.account_id, *db.scalars(select(Comment.account_id).where(Comment.thread_id == root.id))}
    file = db.get(File, root.file_id)
    if file is not None:
        _tell(db, file, comment, {account_id for account_id in taking_part if account_id is not None})
    return comment


def _tell(db: Session, file: File, comment: Comment, taking_part: set[int]) -> None:
    """Notifications (block Z2): who is named with @ and may read the note, and who takes part in the thread; never
    the author. Only the note's title and who wrote, never the comment's words."""
    from . import notify

    named = mentioned(comment.body)
    wanted: set[int] = set(taking_part)
    if named:
        for row in db.scalars(select(Account).where(func.lower(Account.name).in_(named))):
            wanted.add(row.id)
    wanted.discard(comment.account_id or -1)
    for account_id in sorted(wanted):
        reader = db.get(Account, account_id)
        if reader is None or not rights.at_least(rights.role_in(db, reader, file.space_id), rights.READ):
            continue
        how = "names you in a comment on" if reader.name.casefold() in named else "answered in a thread on"
        notify.send(account_id, "mention", f"{comment.author} {how} {file.title or file.path}", "",
                    "/note/" + "/".join(quote(part) for part in file.path.split("/")))


def _one(db: Session, file_id: int, comment_id: int) -> Comment:
    comment = db.get(Comment, comment_id)
    if comment is None or comment.file_id != file_id:
        raise CommentError("not_found", "No such comment.", 404)
    return comment


def edit(db: Session, file_id: int, comment_id: int, who: Who, body: str) -> Comment:
    comment = _one(db, file_id, comment_id)
    if comment.account_id != who.id:
        raise CommentError("not_yours", "Only its author changes a comment.", 403)
    comment.body = _clean(body)
    comment.edited_at = utcnow()
    db.commit()
    return comment


def remove(db: Session, file_id: int, comment_id: int, who: Who) -> None:
    """One's own comment, or any for a manager of the space; the first of a thread takes the thread along (the
    database drops the answers with it: ``thread_id`` cascades)."""
    comment = _one(db, file_id, comment_id)
    if comment.account_id != who.id and not who.may_manage:
        raise CommentError("not_yours", "Only its author or a manager of the space takes a comment back.", 403)
    db.delete(comment)
    db.commit()


def resolve(db: Session, file_id: int, thread_id: int, who: Who, done: bool) -> None:
    root = _root(db, file_id, thread_id)
    if not who.may_write and root.account_id != who.id:
        raise CommentError("not_yours", "Whoever started the thread or may write here closes it.", 403)
    root.resolved_at = utcnow() if done else None
    root.resolved_by = who.name if done else ""
    db.commit()


def people(db: Session, space_id: int, words: str, limit: int = 8) -> list[str]:
    """The names of whoever may read the space, those that start with the words first."""
    members = (
        select(Account.name)
        .join(Membership, Membership.account_id == Account.id)
        .where(Membership.space_id == space_id)
    )
    names = set(db.scalars(members))
    if not names:
        # A space without members is the operators'.
        names = set(db.scalars(select(Account.name).where(Account.role == OPERATOR)))
    folded = words.casefold()
    found = [name for name in names if folded in name.casefold()]
    found.sort(key=lambda name: (not name.casefold().startswith(folded), name.casefold()))
    return found[:limit]


def mentions_of(
    db: Session, account: Any, readable: set[int], seen: dict[int, datetime], since: datetime
) -> list[dict[str, Any]]:
    """Open threads in readable notes where somebody else named the account after it last opened the note."""
    if not readable:
        return []
    pattern = f"%@{account.name}%"
    rows = db.execute(
        select(Comment, File.path, File.title)
        .join(File, File.id == Comment.file_id)
        .where(
            Comment.space_id.in_(readable), File.deleted_at.is_(None), Comment.body.ilike(pattern),
            or_(Comment.account_id.is_(None), Comment.account_id != account.id),
        )
        .order_by(Comment.created_at.desc())
        .limit(200)
    ).all()
    out: list[dict[str, Any]] = []
    name = account.name.casefold()
    for comment, path, title in rows:
        if name not in mentioned(comment.body):
            continue
        after = seen.get(comment.file_id, since)
        if comment.created_at <= after:
            continue
        thread_id = comment.thread_id or comment.id
        root = comment if comment.thread_id is None else db.get(Comment, thread_id)
        if root is None or root.resolved_at is not None or any(item["thread"] == thread_id for item in out):
            continue
        out.append({"thread": thread_id, "path": path, "title": title, "author": comment.author,
                    "at": comment.created_at, "excerpt": comment.body[:140]})
    return out[:30]
