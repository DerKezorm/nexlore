"""Whether a newer nexlore is out: the shared module ``vendor/nexupdates`` (updates 0.1.3), set up for nexlore.

The question to GitHub, the beat (once a day, an hour after a failure), the operator's switch ``update_check`` and the
bell come from the module (plan U1 to U21). What stays nexlore's: where the switch is stored (the settings, key
``update_check``; nothing stored means on, as every installation before had it), the version the operators were last
told about (``notify_version``, so nobody hears of a version twice after the update), and the bell itself
(``notify.operators``: webhook and mail of every operator, the mail in the language of the operator's account, U17).
The operators' paired devices that want to hear of new versions (module geraete) count as a bell too (``devices_want``,
``on_devices``, U24): the module tells them once per version.

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


def _devices_want() -> bool:
    """A device of an operator wants to hear of new versions (module geraete, G56): it counts as a bell (U24)."""
    from . import geraete_config

    return geraete_config.update_wanted()


def _on_devices(version: str) -> None:
    """The operators' devices that want it hear of the new version, once per version (module geraete, G56)."""
    from . import geraete_config

    try:
        with SessionLocal() as db:
            address = settings_service.public_url(db)
        geraete_config.newer(version.strip().removeprefix("v"), APP_VERSION,
                             f"{address}/settings/about" if address else RELEASES_URL)
    except Exception:  # a side matter: the bell has heard already
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
            devices_want=_devices_want,
            on_devices=_on_devices,
        )
    )


configure()
