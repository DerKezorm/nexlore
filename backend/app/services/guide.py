"""The space "nexlore": a guide that is an example at the same time. Every note in it uses what it explains (links,
tasks, callouts, a Kanban board, a template), with pictures of the real interface.

It ships with the program in both languages (``app/guide/de``, ``app/guide/en``) and is made:

* on the very first start, when the operator sets up nexlore and the vault is still empty, in the language chosen then;
* again at any time by the operator (Settings → Server), next to what is there: "nexlore 2" when "nexlore" is taken.
  Nothing is ever overwritten.

Due dates of the tasks are relative to the day the guide is made (``⟦+3⟧`` is three days later), so the calendar and
the task list show something today, not three years ago.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from ..config import get_settings
from ..db import SessionLocal
from ..models import MANAGE, Membership, Space
from . import index, paths, rights, vault

logger = logging.getLogger("nexlore.guide")

ROOT = Path(__file__).resolve().parent.parent / "guide"
LANGUAGES = ("de", "en")
NAME = "nexlore"
_DAY = re.compile("⟦\\+(\\d{1,3})⟧")


def language_of(wanted: str) -> str:
    """German for German, English for every other language (the guide is written in those two)."""
    return "de" if (wanted or "").lower().startswith("de") else "en"


def _free_name() -> str:
    root = paths.vault_root()
    with SessionLocal() as db:
        for number in range(1, 100):
            name = NAME if number == 1 else f"{NAME} {number}"
            if vault.taken(root / name):
                continue
            try:
                rights.free_name(db, name)
            except rights.RightsError:
                # Still in the trash under that name: the next one.
                continue
            return name
    raise RuntimeError("no free name for the guide")


def fill(text: str, today: date) -> str:
    """``⟦+N⟧`` becomes the date N days after ``today``."""
    return _DAY.sub(lambda found: (today + timedelta(days=int(found.group(1)))).isoformat(), text)


def create(account_id: int | None, language: str, today: date | None = None) -> str:
    """Makes the guide as a space of its own and gives it to ``account_id`` to manage; returns the space's name."""
    # The server's own day, as the calendar counts it.
    today = today or datetime.now().astimezone().date()
    source = ROOT / language_of(language)
    paths.vault_root().mkdir(parents=True, exist_ok=True)
    name = vault.create_space(_free_name())
    target_root = paths.vault_root() / name
    for file in sorted(source.rglob("*")):
        if not file.is_file():
            continue
        target = target_root / file.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = file.read_bytes()
        if file.suffix == ".md":
            data = fill(data.decode("utf-8"), today).encode("utf-8")
        target.write_bytes(data)
    if account_id is not None:
        with SessionLocal() as db:
            space = db.scalar(select(Space).where(Space.folder == name))
            assert space is not None
            db.add(Membership(space_id=space.id, account_id=account_id, role=MANAGE))
            db.commit()
    index.scan()
    logger.info("The guide was made space=%s language=%s", name, language_of(language))
    return name


def on_first_start(account_id: int, language: str) -> str | None:
    """At the setup: the guide, when the vault is still empty and it is not switched off (``NEXLORE_WELCOME_GUIDE``)."""
    if not get_settings().welcome_guide:
        return None
    root = paths.vault_root()
    if root.is_dir() and any(not entry.name.startswith(".") for entry in root.iterdir()):
        return None
    try:
        return create(account_id, language)
    except Exception:
        # The guide is a welcome, not a condition: the setup goes on without it.
        logger.exception("The guide could not be made")
        return None
