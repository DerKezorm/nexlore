"""Backups of the whole of nexlore (the vault's files and the database in one ZIP), from the shared module
``sicherung`` (``app/vendor/nexsicherung``, bauplaene/sicherung 1.0.1). What goes into an archive and how it comes
back is nexlore's own (``services/backup_hooks.py``); the module runs the rest: names, list, schedule (off, every
night, every week, every month at a time of day), keeping the newest automatic copies, upload, download, the check
before a restore, the copy of the current state before it, staging and the swap at the next start.

This file keeps the names the rest of nexlore calls (``from app.services import backups``).
"""

from __future__ import annotations

from ..vendor.nexsicherung import AUTOMATIC_KINDS, MANUAL, SCHEDULED, UPDATE, archives, plan, restore, space
from ..vendor.nexsicherung.errors import BackupError
from . import backup_hooks
from .backup_hooks import DATABASE_ENTRY, MANIFEST, SECRET_ENTRY, TRASH_PREFIX, VAULT_PREFIX

__all__ = [
    "AUTOMATIC_KINDS", "DATABASE_ENTRY", "MANIFEST", "MANUAL", "SCHEDULED", "SECRET_ENTRY", "TRASH_PREFIX", "UPDATE",
    "VAULT_PREFIX", "BackupError", "apply_pending", "check", "configure", "create", "entries", "folder", "path_of",
    "pending_folder", "prune", "receive", "remove", "report_failed_restore", "restart_soon", "run_forever",
    "stage_restore", "tidy_at_start", "warn_at_start",
]

configure = backup_hooks.configure
create = archives.create
entries = archives.entries
folder = archives.folder
path_of = archives.path_of
prune = archives.prune
receive = archives.receive
remove = archives.remove
tidy_at_start = archives.tidy_at_start
check = restore.check
stage_restore = restore.stage_restore
apply_pending = restore.apply_pending
pending_folder = restore.pending_folder
restart_soon = restore.restart_soon
report_failed_restore = restore.report_failed_restore
run_forever = plan.run_forever
warn_at_start = space.warn_at_start

configure()
