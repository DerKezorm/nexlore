"""Backups over HTTP; operator only. Until M4 there is no operator, so these answer 401 (tests stand in)."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter
from fastapi import Path as PathParam
from pydantic import BaseModel, Field

from ..deps import OperatorAccount
from ..errors import error
from ..services import backups

router = APIRouter(prefix="/api/backups", tags=["backups"])
BackupName = Annotated[str, PathParam(max_length=64, pattern=backups.NAME.pattern)]


class CreateIn(BaseModel):
    note: str = Field(default="", max_length=200)


def _fail(exc: backups.BackupError) -> Exception:
    return error(exc.code, exc.text, 404 if exc.code == "not_found" else 400)


@router.get("")
def listing(_operator: OperatorAccount) -> list[dict[str, Any]]:
    return [asdict(entry) for entry in backups.entries()]


@router.post("", status_code=201)
def create(body: CreateIn, _operator: OperatorAccount) -> dict[str, str]:
    return {"name": backups.create(kind=backups.MANUAL, note=body.note).name}


@router.post("/{name}/check")
def check(name: BackupName, _operator: OperatorAccount) -> dict[str, Any]:
    try:
        brief = backups.check(name)
    except backups.BackupError as exc:
        raise _fail(exc) from exc
    return {**asdict(brief), "usable": brief.usable}


@router.post("/{name}/restore", status_code=202)
def restore(name: BackupName, _operator: OperatorAccount) -> dict[str, Any]:
    """Checks, keeps the current state as a backup, and restarts; the restore happens at the next start."""
    try:
        brief = backups.stage_restore(name)
    except backups.BackupError as exc:
        raise _fail(exc) from exc
    backups.restart_soon()
    return {**asdict(brief), "usable": brief.usable, "restarting": True}


@router.delete("/{name}", status_code=204)
def delete(name: BackupName, _operator: OperatorAccount) -> None:
    try:
        backups.remove(name)
    except backups.BackupError as exc:
        raise _fail(exc) from exc
