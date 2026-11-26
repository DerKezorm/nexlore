"""Logging, from the shared module ``log`` (``app/vendor/nexlog``, bauplaene/log 1.0.0).

nexlore writes its log to ``data/logs/nexlore.log``. The file rolls over at a size limit, three older files are kept,
and files older than 14 days are deleted. Four levels (``quiet``, ``normal``, ``detailed``, ``trace``); the two deep
ones switch themselves off; ``NEXLORE_LOG_LEVEL`` overrides the stored level. All of it lives in the module now; this
file only tells it what is nexlore's own and keeps the names every caller used (``from app.services import logs``).

Messages are English on purpose: log lines end up in bug reports and web searches. ``tests/test_log_language.py``
keeps that rule.

⚠️ What never goes into the log, at any level: the content of a note or an attachment, search terms, passwords,
tokens, keys, session identifiers. Paths, sizes, counts, accounts and results do. A note's title is part of its
path and may appear at ``detailed`` and below. ``tests/test_log_secrets.py`` scans the code for the obvious
mistakes; the module's blacking out is the net below that rule.
"""

from __future__ import annotations

from pathlib import Path

from .. import private
from ..config import get_settings
from ..vendor import nexlog

# The names of the module, as nexlore's callers know them.
from ..vendor.nexlog import *

#: The prefixes nexlore's log blacked out before the module (``nx[aclre]_``: API tokens, calendar subscriptions, MCP
#: keys, refresh tokens, address links), the paired devices of the iPhone app and the connections with other nex apps
#: (``nxv_``, module verbinden): what follows them never reaches the log.
KEY_PREFIXES = ("nxa_", "nxc_", "nxl_", "nxr_", "nxe_", "nxd_", "nxv_", "nxvr_", "nxvc_")
#: Path segments followed by a token in nexlore, on top of the module's common ones: the link confirming an address.
TOKEN_PATHS = ("email",)
#: Query parameters that carry a token in nexlore, on top of the module's common ones.
QUERY_KEYS = ("invite",)


def configure(log_dir: Path | None = None) -> None:
    """What the module needs of nexlore: its name, folder, environment variable and rules. Done once on import, so
    every caller (the start, the tests) finds it configured. ``log_dir``: another folder (the contract tests)."""
    nexlog.configure(
        nexlog.AppConfig(
            app_name="nexlore",
            log_dir=log_dir if log_dir is not None else (lambda: get_settings().data_dir / "logs"),
            env_level=lambda: get_settings().log_level or "",
            key_prefixes=KEY_PREFIXES,
            token_paths=TOKEN_PATHS,
            query_keys=QUERY_KEYS,
            tighten=private.tighten,
        )
    )


configure()
