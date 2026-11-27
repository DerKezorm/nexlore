"""Whether a newer nexlore is out: the shared module ``vendor/nexupdates`` (updates 0.1.1), set up for nexlore.

The question to GitHub, the beat (once a day, an hour after a failure), the operator's switch ``update_check`` and the
bell come from the module (plan U1 to U21). What stays nexlore's: where the switch is stored (the settings, key
``update_check``; nothing stored means on, as every installation before had it), the version the operators were last
told about (``notify_version``, so nobody hears of a version twice after the update), and the bell itself
(``notify.operators``: webhook and mail of every operator, the mail in the language of the operator's account, U17).

Every name the routes and tests used from the old file is still here (``parse``, ``is_newer``, ``state``, ``forget``,
``State``, ``INTERVAL``, ``RETRY``, ``MAX_ANSWER``), now the module's.
"""

from __future__ import annotations

import logging

from .. import __version__ as APP_VERSION
from ..config import get_settings
from ..db import SessionLocal
from ..vendor import nexupdates
from ..vendor.nexupdates import *
from . import settings_service

REPO = "DerKezorm/nexlore"
REPO_URL = f"https://github.com/{REPO}"
RELEASES_URL = f"{REPO_URL}/releases"
#: The project pages are switched off since 17.10.2026 (U18): no line on the about page until they are back.
PROJECT_URL = ""


def _read_switch() -> bool | None:
    from ..models import Setting

    with SessionLocal() as db:
        row = db.get(Setting, "update_check")
        return None if row is None else bool(row.value)


def _write_switch(on: bool) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"update_check": bool(on)})


def _read_told() -> str | None:
    with SessionLocal() as db:
        return str(settings_service.get(db, "notify_version") or "") or None


def _write_told(version: str) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"notify_version": version})


def _on_newer(version: str) -> None:
    """The operators hear of it once, each in the language of the account (the words are the module's)."""
    from . import notify

    notify.operators(notify.words("new_version", version=version.strip().removeprefix("v")), "/settings/about", 2)
    # And on the operators' devices whose app understands it (module geraete, G18), once per version.
    try:
        from . import geraete_config

        with SessionLocal() as db:
            address = settings_service.public_url(db)
        geraete_config.announce(version.strip().removeprefix("v"), APP_VERSION,
                                f"{address}/settings/about" if address else RELEASES_URL)
    except Exception:
        logging.getLogger("nexlore.app").exception("Telling the devices of a new version failed")


def configure() -> None:
    nexupdates.configure(
        nexupdates.AppConfig(
            app_name="nexlore",
            version=APP_VERSION,
            repo=REPO,
            project_url=PROJECT_URL,
            update_url=lambda: get_settings().update_url,
            read_switch=_read_switch,
            write_switch=_write_switch,
            read_told=_read_told,
            write_told=_write_told,
            on_newer=_on_newer,
        )
    )


configure()
