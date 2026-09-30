"""
Who has a note open right now: each open page says so every little while (``touch``), and whoever else looks at the
note sees their pictures in its header. Whoever holds the note's lock (the tab that edits it) is shown as writing.

Kept in memory only (one worker serves nexlore): after a restart the pages say it again within a heartbeat. A page
that stopped saying it is gone after ``STALE_SECONDS``; one that closes says goodbye (``leave``).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

#: A page renews its presence about every 25 seconds; after this without a word it counts as gone.
STALE_SECONDS = 70


@dataclass
class Seen:
    account_id: int
    name: str
    avatar: str | None
    client: str
    at: float


_lock = threading.Lock()
#: file id -> (account id, client) -> when last seen
_open: dict[int, dict[tuple[int, str], Seen]] = {}


def _now() -> float:
    return time.monotonic()


def _prune(file_id: int, now: float) -> None:
    here = _open.get(file_id)
    if not here:
        return
    for key in [key for key, seen in here.items() if now - seen.at > STALE_SECONDS]:
        del here[key]
    if not here:
        del _open[file_id]


def touch(file_id: int, account_id: int, name: str, avatar: str | None, client: str) -> None:
    with _lock:
        now = _now()
        _open.setdefault(file_id, {})[(account_id, client)] = Seen(account_id, name, avatar, client, now)
        _prune(file_id, now)


def leave(file_id: int, account_id: int, client: str) -> None:
    with _lock:
        here = _open.get(file_id)
        if here:
            here.pop((account_id, client), None)
            if not here:
                del _open[file_id]


def others(file_id: int, account_id: int, writer: str | None) -> list[dict[str, object]]:
    """Everybody else with the note open, once each (the newest of their tabs), the one writing first."""
    with _lock:
        now = _now()
        _prune(file_id, now)
        people: dict[int, dict[str, object]] = {}
        for seen in _open.get(file_id, {}).values():
            if seen.account_id == account_id:
                continue
            writing = writer is not None and seen.client == writer
            known = people.get(seen.account_id)
            if known is None or writing:
                people[seen.account_id] = {
                    "id": seen.account_id, "name": seen.name, "avatar": seen.avatar, "writing": writing,
                }
    return sorted(people.values(), key=lambda person: (not person["writing"], str(person["name"]).casefold()))


def forget() -> None:
    """For the tests: nobody is anywhere."""
    with _lock:
        _open.clear()
