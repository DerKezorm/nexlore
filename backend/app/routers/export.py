"""A note or a folder as PDF, and a preview of its pages for the print dialog (``services/typeset.py``)."""

from __future__ import annotations

import base64
import logging
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from ..db import SessionLocal
from ..deps import Account, need
from ..errors import error
from ..services import paths, rights, typeset

router = APIRouter(prefix="/api/export", tags=["export"])

LOG = logging.getLogger("nexlore.export")


class OptionsIn(BaseModel):
    paper: Literal["a4", "letter"] = "a4"
    landscape: bool = False
    properties: bool = True
    embeds: bool = True
    links: Literal["footnote", "text"] = "footnote"
    header: bool = True
    footer: bool = True
    font: Literal["app", "serif"] = "app"
    contents: bool = True
    new_page: bool = True
    #: The language of the words nexlore adds; left out, the account's.
    language: Literal["de", "en"] | None = None


class ExportIn(BaseModel):
    """One note (``path``) or a folder (``folder``, a space works too), never both."""

    path: str | None = Field(default=None, min_length=1, max_length=paths.MAX_PATH_CHARS)
    folder: str | None = Field(default=None, min_length=1, max_length=paths.MAX_PATH_CHARS)
    #: Of a folder only these notes (the dialog's ticks); left out, all of them.
    only: list[str] | None = Field(default=None, max_length=typeset.MAX_NOTES)
    options: OptionsIn = Field(default_factory=OptionsIn)

    @model_validator(mode="after")
    def _one(self) -> ExportIn:
        if (self.path is None) == (self.folder is None):
            raise ValueError("give a note or a folder")
        return self


class PreviewOut(BaseModel):
    #: The pages as PNG, base64.
    pages: list[str]
    #: Notes of a folder the preview did not set (it shows the first few).
    more_notes: int


def _run(body: ExportIn, account: Account, fmt: Literal["pdf", "png"]) -> tuple[bytes | list[bytes], str, int]:
    note = need(account, body.path, rights.READ) if body.path is not None else None
    folder = need(account, body.folder, rights.READ) if body.folder is not None else None
    only = None
    if body.only is not None:
        only = []
        for item in body.only:
            try:
                only.append(paths.parse(item))
            except paths.PathError as exc:
                raise error(exc.code, str(exc), **exc.values) from exc
    values = body.options.model_dump()
    values["language"] = typeset.language_of(account, body.options.language)
    try:
        return typeset.build(account, note=note, folder=folder, only=only, options=typeset.Options(**values), fmt=fmt)
    except typeset.ExportError as exc:
        if exc.code == "typeset_failed":
            LOG.warning("A PDF could not be set: %s", exc.__cause__)
        raise error(exc.code, exc.text, exc.status) from exc


class FolderNotesOut(BaseModel):
    #: The notes of the folder in the order the PDF has them.
    notes: list[str]


@router.get("/notes", response_model=FolderNotesOut)
def folder_notes(folder: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
                 account: Account) -> FolderNotesOut:
    """What a folder's PDF would hold: the dialog lists it to tick."""
    clean = need(account, folder, rights.READ)
    with SessionLocal() as db:
        try:
            files, _title, _crumb = typeset.collect(db, account, note=None, folder=clean, limit=False)
        except typeset.ExportError as exc:
            if exc.code == "nothing_to_export":
                return FolderNotesOut(notes=[])
            raise error(exc.code, exc.text, exc.status) from exc
    return FolderNotesOut(notes=[row.path for row in files])


@router.post("/pdf")
def export_pdf(body: ExportIn, account: Account) -> Response:
    """The PDF as a download."""
    output, title, _ = _run(body, account, "pdf")
    assert isinstance(output, bytes)
    name = typeset.safe_name(title)
    return Response(
        output, media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
            "Cache-Control": "no-store",
        },
    )


@router.post("/preview", response_model=PreviewOut)
def export_preview(body: ExportIn, account: Account) -> PreviewOut:
    """The pages as small pictures, set exactly as the PDF will be."""
    output, _title, more = _run(body, account, "png")
    pages = output if isinstance(output, list) else [output]
    return PreviewOut(pages=[base64.b64encode(page).decode("ascii") for page in pages], more_notes=more)
