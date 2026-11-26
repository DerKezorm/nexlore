"""nexlore's side of the shared AI module ``vendor/nexki`` (ki 0.1.0): its configuration and the ``Store`` over
nexlore's own fields, so that no field wanders (Entwurf KI-Anbieter, "Alte Einstellungen gelten weiter").

Where everything stays: the operator's main switch ``ai_allowed`` (closed from the start, as before); the way
``ai_mode`` (written once at the start where never stored: ``own`` where accounts have their own access, K17); the
operator's service ``ai_shared_url``, ``ai_shared_model``, ``ai_shared_key_enc`` (sealed with ``operator:ai-key``);
the hosts in the own network ``ai_private_hosts`` (one per line, as the old page wrote them); ``ai_per_minute``. Per
account ``Account.ai_allowed`` ("KI erlaubt"), ``ai_active`` ("KI für mich"), ``ai_url``, ``ai_model``,
``ai_key_enc`` (sealed with ``account:<id>:ai-key``), and the list of what went out in ``ai_events`` (older lines
stay readable with their own context). New only: the interface of a service (``ai_shared_api``, ``Account.ai_api``;
nexlore spoke only the OpenAI form, so empty is ``openai``), the brakes per day, and per line of the list its target,
kind, size and outcome.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..models import Account, AiEvent, Setting
from ..security import account_out, decrypt_secret, encrypt_secret
from ..vendor import nexki
from ..vendor.nexki import Event, OwnAccess
from . import settings_service

#: The tasks of the buttons in notes (``services/ai.py`` ``TASKS``), with their temperature as before.
CONFIG = nexki.AppConfig(
    app_name="nexlore",
    tasks=(
        nexki.Task("spelling", temperature=0.2, max_out=8_000, seconds=120.0),
        nexki.Task("rewrite", temperature=0.7, max_out=8_000, seconds=120.0),
        nexki.Task("translate", temperature=0.2, max_out=8_000, seconds=120.0),
        nexki.Task("summarize", temperature=0.3, max_out=8_000, seconds=120.0),
        nexki.Task("write", temperature=0.7, max_out=8_000, seconds=120.0),
    ),
    modes=("shared", "own"),
    operator_key_context="operator:ai-key",
    account_key_context=lambda account_id: f"account:{account_id}:ai-key",
    per_minute=20,
)

#: The module's settings under nexlore's names; ``None`` here: nexlore had no such setting before.
NAMES = {
    "enabled": "ai_allowed", "mode": "ai_mode", "api": "ai_shared_api", "url": "ai_shared_url",
    "model": "ai_shared_model", "key": "ai_shared_key_enc", "hosts": "ai_private_hosts",
    "per_minute": "ai_per_minute", "per_day": "ai_per_day", "server_day": "ai_server_day", "day": "ai_day",
    "hosts_adopted": "ai_hosts_adopted",
}
#: Settings that have a value of before even when never stored (the main switch with its old default, closed; the
#: brake per minute); the others answer ``None`` while never stored, and ``nexki.settings.adopt`` writes the way
#: (``own`` where accounts have their own access, else ``shared``, K17).
ALWAYS = ("enabled", "per_minute")


def _old_event_context(account_id: Any) -> str:
    return f"account:{account_id}:ai-event"


class KiStore:
    """``nexki.Store`` over one session."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- the operator --------------------------------------------------------------------------------------------

    def setting(self, name: str) -> Any:
        key = NAMES[name]
        if name == "api":
            # nexlore spoke only the OpenAI form: a service of before is one.
            return settings_service.get(self.db, key) or "openai"
        if name in ALWAYS:
            return settings_service.get(self.db, key)
        row = self.db.get(Setting, key)
        if row is None:
            return None
        if name == "hosts":
            return [host for host in str(row.value or "").replace("\n", ",").split(",") if host.strip()] \
                if isinstance(row.value, str) else list(row.value or [])
        return row.value

    def set_setting(self, name: str, value: Any) -> None:
        if name == "hosts":
            value = "\n".join(value or [])
        settings_service.save(self.db, {NAMES[name]: value}, commit=False)

    # --- accounts ------------------------------------------------------------------------------------------------

    def _row(self, account_id: Any) -> Account | None:
        try:
            return self.db.get(Account, int(account_id))
        except (TypeError, ValueError):
            return None

    def account_allowed(self, account_id: Any) -> bool:
        row = self._row(account_id)
        return row is not None and bool(row.ai_allowed)

    def account_out(self, account_id: Any) -> bool:
        return account_out(self._row(account_id))

    def _shared(self) -> bool:
        return nexki.settings.mode(self, CONFIG) == "shared"

    def person_on(self, account_id: Any) -> bool:
        """With the operator's service for all: on unless the person switched it off (nexlore had no switch there);
        with an own access: ``ai_active``, as before."""
        row = self._row(account_id)
        if row is None:
            return False
        if self._shared():
            return not row.ai_mine_off
        # Without a complete access the switch is no reason (the chain then names what is missing); with one,
        # ``ai_active`` as before: a person who kept it off keeps it off.
        complete = bool(row.ai_url and row.ai_model)
        return not row.ai_mine_off and (bool(row.ai_active) or not complete)

    def set_person_on(self, account_id: Any, on: bool) -> None:
        row = self._row(account_id)
        if row is not None:
            # Remembered for both ways: who switched it off for themselves stays off when an access is saved later.
            row.ai_mine_off = not on
            if not self._shared():
                row.ai_active = bool(on)
            self.db.flush()

    def own_access(self, account_id: Any) -> OwnAccess | None:
        row = self._row(account_id)
        if row is None or not (row.ai_url or row.ai_model or row.ai_key_enc):
            return None
        return OwnAccess(api=row.ai_api or "openai", url=row.ai_url, model=row.ai_model, key=row.ai_key_enc)

    def set_own_access(self, account_id: Any, access: OwnAccess | None) -> None:
        row = self._row(account_id)
        if row is None:
            return
        row.ai_api = access.api if access else ""
        row.ai_url = access.url if access else ""
        row.ai_model = access.model if access else ""
        row.ai_key_enc = access.key if access else ""
        complete = bool(access and access.url and access.model)
        # As before, an access that becomes incomplete switches itself off; a complete one saved by a person who did
        # not switch the AI off for themselves is meant to be used (the page of the module has no second step).
        row.ai_active = complete and (row.ai_active or not row.ai_mine_off)
        self.db.flush()

    def own_access_urls(self) -> list[str]:
        return [url for url in self.db.scalars(select(Account.ai_url).where(Account.ai_url != "")) if url]

    # --- sealing -------------------------------------------------------------------------------------------------

    def seal(self, text: str, context: str) -> str:
        return encrypt_secret(text, context)

    def unseal(self, sealed: str, context: str) -> str:
        try:
            found = decrypt_secret(sealed, context)
        except Exception:  # noqa: BLE001
            found = ""
        if not found and context.endswith(":ai-key:events"):
            # A line of the list from before the module: sealed with the old context of the list.
            account_id = context.split(":")[1]
            try:
                found = decrypt_secret(sealed, _old_event_context(account_id))
            except Exception:  # noqa: BLE001
                found = ""
        return found or ""

    # --- what went out -------------------------------------------------------------------------------------------

    def add_event(self, event: Event) -> None:
        self.db.add(AiEvent(account_id=int(event.account_id), at=event.at, model=event.model[:200],
                            task=event.task[:32], target="", body_enc=event.sent, to=event.to[:255],
                            manual=event.manual, chars=event.chars, outcome=event.outcome[:64],
                            error="" if event.outcome == "ok" else event.outcome[:64]))
        self.db.flush()

    def events(self, account_id: Any) -> list[Event]:
        rows = self.db.scalars(select(AiEvent).where(AiEvent.account_id == int(account_id))
                               .order_by(AiEvent.at.desc(), AiEvent.id.desc()))
        return [Event(account_id=row.account_id, at=row.at, task=row.task, to=row.to or "", model=row.model,
                      manual=bool(row.manual), chars=int(row.chars or 0),
                      outcome=row.outcome or (row.error or "ok"), sent=row.body_enc or "", id=row.id)
                for row in rows]

    def clear_events(self, account_id: Any) -> int:
        return int(self.db.execute(delete(AiEvent).where(AiEvent.account_id == int(account_id))).rowcount or 0)

    def drop_events(self, before: datetime, *, keep: int) -> int:
        removed = int(self.db.execute(delete(AiEvent).where(AiEvent.at < before)).rowcount or 0)
        crowded = self.db.execute(select(AiEvent.account_id).group_by(AiEvent.account_id)
                                  .having(func.count() > keep)).scalars().all()
        for account_id in crowded:
            kept = select(AiEvent.id).where(AiEvent.account_id == account_id).order_by(
                AiEvent.at.desc(), AiEvent.id.desc()).limit(keep)
            removed += int(self.db.execute(delete(AiEvent).where(AiEvent.account_id == account_id,
                                                                 AiEvent.id.not_in(kept))).rowcount or 0)
        return removed

    def commit(self) -> None:
        self.db.commit()


def store() -> Iterator[KiStore]:
    """The dependency of the module's routes: a store over a session of its own."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        yield KiStore(db)


def adopt() -> list[str]:
    """At every start (K17): what was never stored gets the value that keeps the installation as it was."""
    from ..db import SessionLocal

    with SessionLocal() as db:
        done = nexki.settings.adopt(KiStore(db), CONFIG)
        db.commit()
    return done
