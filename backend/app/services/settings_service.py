"""Operator settings in the database, with defaults."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Setting

DEFAULTS: dict[str, Any] = {
    "log_mode": "normal",
    "log_mode_until": None,
    #: off | daily | weekly. Off until the operator decides (M4 brings the switch to the interface).
    "backup_schedule": "off",
    "backup_keep": 7,
    #: Where uploaded files go, next to the note they belong to. Only a name, never a path.
    "attachment_folder": "Attachments",
    #: Largest single upload, in MB.
    "upload_max_mb": 1024,
    #: Space per account for what it uploaded, in MB; 0 is no limit.
    "quota_mb": 0,
    #: Remove the place and the device from photos and videos on upload.
    "strip_location": True,
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    if row is None:
        return DEFAULTS.get(key)
    return row.value


def get_all(db: Session) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in db.scalars(select(Setting)):
        values[row.key] = row.value
    return values


def save(db: Session, changes: dict[str, Any]) -> None:
    for key, value in changes.items():
        if key not in DEFAULTS:
            raise KeyError(key)
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
    db.commit()
