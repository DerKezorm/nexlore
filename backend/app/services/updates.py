"""Whether a newer nexlore is out (block X2), after nexmail's update check.

At most once a day the public GitHub API is asked for the newest release. Nothing goes out but the question itself: no
names, no notes, no settings. It is the one place nexlore calls out by itself, so the switch stands on the about page,
where the answer shows, and the page says in a sentence what goes out. Off means "not by itself": the button still asks.

The check is a side matter. Without a network, with GitHub down or answering an error, nothing on the page breaks: the
answer is simply not there. While the repository is private, GitHub answers "not found" and so says nothing either.
"""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx

from .. import __version__
from ..config import get_settings

logger = logging.getLogger("nexlore.updates")

REPO = "DerKezorm/nexlore"
REPO_URL = f"https://github.com/{REPO}"
RELEASES_URL = f"{REPO_URL}/releases"
PROJECT_URL = "https://www.nexlore.de"
API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"

#: Once a day at most; GitHub allows 60 questions an hour without signing in.
INTERVAL = timedelta(hours=24)
#: The page should not wait on GitHub.
TIMEOUT = httpx.Timeout(6.0, connect=4.0)

_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class State:
    current: str
    latest: str | None = None
    newer: bool = False
    checked_at: datetime | None = None


_known: State | None = None
_lock = threading.Lock()


def parse(text: str) -> tuple[int, int, int] | None:
    """``"v1.2.3"`` -> ``(1, 2, 3)``; anything else -> ``None``."""
    found = _PATTERN.match((text or "").strip())
    if not found:
        return None
    return int(found.group(1)), int(found.group(2)), int(found.group(3))


def is_newer(latest: str, current: str) -> bool:
    """Numbers, not text: ``"0.10.0" > "0.9.0"`` is false as text, and that shows exactly once, at the tenth minor."""
    a, b = parse(latest), parse(current)
    if a is None or b is None:
        return False
    return a > b


def _ask() -> str | None:
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            answer = client.get(get_settings().update_url or API_URL, headers={"accept": "application/vnd.github+json"})
            answer.raise_for_status()
            return str(answer.json().get("tag_name") or "") or None
    except Exception as problem:  # noqa: BLE001
        # Every exception, not a list of names: in Nexview httpx.InvalidURL slipped past httpx.HTTPError and took a
        # whole page with it. A side matter that fails must break nothing.
        logger.info("The update check did not get through: %s", type(problem).__name__)
        return None


def state(*, on: bool = True, force: bool = False) -> State:
    """The last known state, asked afresh when it is a day old (or when forced)."""
    global _known
    if not on and not force:
        return _known if _known is not None else State(current=__version__)
    now = datetime.now(UTC)
    with _lock:
        fresh = _known is not None and _known.checked_at is not None and now - _known.checked_at < INTERVAL
        if fresh and not force:
            return _known  # type: ignore[return-value]
        latest = _ask()
        _known = State(
            current=__version__,
            latest=latest,
            newer=bool(latest) and is_newer(latest or "", __version__),
            checked_at=now,
        )
        return _known


def forget() -> None:
    """For tests, and when the check is switched off."""
    global _known
    _known = None
