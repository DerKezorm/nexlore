"""
Quick capture: a thought goes into the inbox note of a space, the newest on top with the time it was taken, without
opening anything. The inbox is ``Inbox.md`` or ``Eingang.md`` at the top of the space, whichever is there; without
one it is made, named in the language of the account.

An entry is one list item, ``- 2026-09-29 22:41 the words``, further lines indented under it. It goes in after the
front matter and a first heading, above the entries before it. Never into the inbox while someone edits it (its lock).
"""
from __future__ import annotations

import logging
import re

from ..db import SessionLocal
from . import index, mdparse, paths, vault
from .vault import Actor, _valid_lock, atomic_write

logger = logging.getLogger("nexlore.inbox")

#: The inbox's name by language; any other language gets the English one.
NAMES = {"de": "Eingang"}
DEFAULT = "Inbox"
#: The time of an entry as the browser gives it (its own clock and zone).
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
MAX_CHARS = 20_000

_HEADING = re.compile(r"[ \t]*#[ \t][^\r\n]*(?:\r?\n|$)")
_BLANK = re.compile(r"(?:[ \t]*\r?\n)*")


class InboxError(Exception):
    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def name_for(language: str | None) -> str:
    return NAMES.get((language or "").split("-")[0].lower(), DEFAULT)


def entry(text: str, stamp: str) -> str:
    """The words as one list item: the first line after the time, the others indented under it."""
    lines = [line.rstrip() for line in text.strip().replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    out = f"- {stamp} {lines[0]}"
    for line in lines[1:]:
        out += "\n  " + line if line else "\n"
    return out + "\n"


def put_in(content: str, item: str) -> str:
    """The inbox with the item on top: after the front matter and a first heading, above everything else."""
    newline = "\r\n" if "\r\n" in content else "\n"
    item = item.replace("\n", newline)
    start = mdparse.parse(content).body_start
    body = content[start:]
    head = content[:start]
    lead = _BLANK.match(body)
    at = lead.end() if lead else 0
    heading = _HEADING.match(body, at)
    if heading:
        title = body[: heading.end()]
        if not title.endswith("\n"):
            title += newline
        gap = _BLANK.match(body, heading.end())
        blank = body[heading.end() : gap.end()] if gap else ""
        rest = body[gap.end() if gap else heading.end() :]
        head += title + (blank or newline)
    else:
        head += body[:at]
        rest = body[at:]
    # An entry before: one list with it. Anything else: a blank line between.
    if not rest or rest.startswith("- "):
        return head + item + rest
    return head + item + newline + rest


def _find(db: object, space: str, language: str | None) -> str | None:
    for name in [name_for(language), DEFAULT, *NAMES.values()]:
        found = vault.live_by_key(db, f"{space}/{name}.md")  # type: ignore[arg-type]
        if found is not None and found.is_note:
            return found.path
    return None


def capture(space: str, text: str, stamp: str, *, actor: Actor, language: str | None) -> str:
    """Puts the words into the space's inbox; the path of the inbox."""
    words = text.strip()
    if not words:
        raise InboxError("empty", "Nothing to keep.", 422)
    if len(words) > MAX_CHARS:
        raise InboxError("too_long", "That is too long for a quick note.", 422)
    if not STAMP.match(stamp):
        raise InboxError("invalid_input", "The time is not valid.", 422)
    item = entry(words, stamp)
    with index.guard, SessionLocal() as db:
        path = _find(db, space, language)
        if path is not None:
            note = vault.live(db, path)
            if note is None:
                raise InboxError("not_found", "The inbox went away.", 404)
            if _valid_lock(db, note.id) is not None:
                raise InboxError("note_locked", "Someone is editing the inbox; try again in a moment.")
            full = paths.vault_root().joinpath(*path.split("/"))
            try:
                data = full.read_bytes()
                content = data.decode("utf-8-sig")
            except (OSError, UnicodeDecodeError) as exc:
                raise InboxError("not_found", "The inbox cannot be read.", 404) from exc
            new_data = put_in(content, item).encode("utf-8")
            if data.startswith(b"\xef\xbb\xbf"):
                new_data = b"\xef\xbb\xbf" + new_data
            stat = atomic_write(full, new_data)
            index.record(db, path, new_data, stat, source=index.APP, author=actor.name, session=actor.client, file=note)
            db.commit()
            logger.info("Captured into the inbox")
            return path
    name = name_for(language)
    made = vault.create_note(space, name, f"# {name}\n\n{item}".encode(), actor=actor)
    logger.info("Captured into a new inbox")
    return made.path
