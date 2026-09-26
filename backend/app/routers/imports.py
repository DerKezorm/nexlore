"""Importing an Obsidian vault as a ZIP, and the report on any space."""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Form, UploadFile
from fastapi import Path as PathParam

from ..config import get_settings
from ..deps import Account
from ..errors import error
from ..services import importer
from ..services.vault import VaultError

router = APIRouter(prefix="/api", tags=["import"])
_CHUNK = 1024 * 1024


@router.post("/import", status_code=201)
def import_vault(
    file: UploadFile, name: Annotated[str, Form(min_length=1, max_length=255)], _account: Account
) -> dict[str, Any]:
    folder = get_settings().data_dir / "tmp"
    folder.mkdir(parents=True, exist_ok=True)
    upload = folder / f"import-{uuid.uuid4().hex}.zip"
    try:
        size = 0
        with open(upload, "wb") as sink:
            while chunk := file.file.read(_CHUNK):
                size += len(chunk)
                if size > importer.MAX_TOTAL_BYTES:
                    raise error("archive_too_large", "The archive is too large.", 413)
                sink.write(chunk)
        try:
            return importer.import_archive(upload, name).as_dict()
        except VaultError as exc:
            raise error(exc.code, exc.text, exc.status) from exc
    finally:
        upload.unlink(missing_ok=True)


@router.get("/spaces/{name}/report")
def space_report(name: Annotated[str, PathParam(min_length=1, max_length=255)], _account: Account) -> dict[str, Any]:
    try:
        return importer.report(name).as_dict()
    except VaultError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
