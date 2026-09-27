"""Keeping the index in step with changes from outside: Obsidian, Syncthing, an editor, a script.

Two ways, because neither is enough alone:

* **The watcher** (watchfiles, on the operating system's own notifications) reports changes within a second or two.
  Some network shares and container mounts deliver no notifications at all; ``NEXLORE_WATCH_POLLING`` switches the
  watcher to polling for those.
* **The full scan** every ``NEXLORE_SCAN_INTERVAL`` seconds catches whatever the watcher missed: events lost while
  the app was busy, changes made while it was not running (the first scan runs right at start).

Once a day the housekeeping runs: the trash forgets what is older than 30 days, old versions are thinned out.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from watchfiles import awatch

from ..config import get_settings
from . import index, paths, vault

logger = logging.getLogger("nexlore.watcher")

HOUSEKEEPING_SECONDS = 24 * 3600
#: How long the watcher collects events before it hands them over, in milliseconds.
DEBOUNCE_MS = 1500
RETRY_SECONDS = 30


def relative_paths(root: Path, changed: set[tuple[object, str]]) -> set[str]:
    """Vault-relative paths from watcher events; hidden parts and anything outside the vault are dropped."""
    found: set[str] = set()
    for _change, raw in changed:
        try:
            rel = paths.relative(Path(raw), root=root)
        except ValueError:
            continue
        if not rel or rel == "." or any(paths.is_hidden(part) for part in rel.split("/")):
            continue
        found.add(rel)
    return found


def _visible(_change: object, raw: str) -> bool:
    return not any(paths.is_hidden(part) for part in Path(raw).parts)


async def watch(stop: asyncio.Event) -> None:
    settings = get_settings()
    root = paths.vault_root()
    while not stop.is_set():
        try:
            async for changes in awatch(
                root, stop_event=stop, watch_filter=_visible, debounce=DEBOUNCE_MS,
                force_polling=settings.watch_polling, recursive=True,
            ):
                rels = relative_paths(root, changes)
                if rels:
                    logger.debug("Watcher saw changes paths=%s", len(rels))
                    await asyncio.to_thread(index.refresh, rels)
        except (OSError, RuntimeError) as exc:
            logger.warning("File watcher stopped, trying again in %s seconds: %s", RETRY_SECONDS, exc)
            try:
                await asyncio.wait_for(stop.wait(), RETRY_SECONDS)
            except TimeoutError:
                continue


async def scan_forever(stop: asyncio.Event) -> None:
    settings = get_settings()
    last_housekeeping = 0.0
    try:
        await asyncio.to_thread(index.fill_tasks)
    except Exception:
        logger.exception("Filling in the tasks failed")
    while not stop.is_set():
        try:
            await asyncio.to_thread(index.scan)
            if time.monotonic() - last_housekeeping >= HOUSEKEEPING_SECONDS or last_housekeeping == 0.0:
                await asyncio.to_thread(vault.purge_expired)
                await asyncio.to_thread(vault.thin_all)
                last_housekeeping = time.monotonic()
        except Exception:
            logger.exception("Index scan failed")
        interval = settings.scan_interval if settings.scan_interval > 0 else HOUSEKEEPING_SECONDS
        try:
            await asyncio.wait_for(stop.wait(), interval)
        except TimeoutError:
            continue
