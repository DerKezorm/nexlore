"""Views over notes (``services/bases``): a ``.base`` file or a ``base`` code block in a note, shown as a table, cards,
a list or a board. Reading needs the right to read the file or note; changing a cell (a property of a note) or the
view itself needs the right to write. The notes shown are those of the view's own space.
"""

from __future__ import annotations

import posixpath
from dataclasses import asdict
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import Account, need
from ..errors import error
from ..models import READ, WRITE, File, Space
from ..services import bases, frontedit, index, paths, vault
from ..services.vault import VaultError
from .vault import ActorDep

router = APIRouter(prefix="/api", tags=["bases"])


def _space(db: Any, rel: str) -> Space:
    space = db.scalar(select(Space).where(Space.folder == paths.space_of(rel)))
    if space is None:
        raise error("not_found", "Not found.", 404)
    return space


def _is_base(rel: str) -> bool:
    return rel.lower().endswith(".base")


def _answer(result: bases.Result) -> dict[str, Any]:
    return {
        **{key: value for key, value in asdict(result).items() if key != "columns"},
        "columns": [{"key": column.key, "label": column.label} for column in result.columns],
    }


@router.get("/bases/view", summary="One view of a .base file, with its rows")
def view_file(
    account: Account,
    path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
    view: Annotated[int, Query(ge=0, le=100)] = 0,
) -> dict[str, Any]:
    clean = need(account, path, READ)
    if not _is_base(clean):
        raise error("not_a_view", "This is no view.", 422)
    try:
        data = paths.vault_root().joinpath(*clean.split("/")).read_bytes()
    except OSError as exc:
        raise error("not_found", "Not found.", 404) from exc
    try:
        config = bases.read(index.decode(data))
    except bases.BaseError as exc:
        raise error("bad_view", str(exc), 422) from exc
    with SessionLocal() as db:
        space = _space(db, clean)
        result = bases.run(db, config, space.id, space.folder, view)
        answer = _answer(result)
        answer["hash"] = index.digest(data)
        answer["text"] = index.decode(data)
        return answer


class BlockIn(BaseModel):
    #: The note the code block stands in; its space is the one the view looks at.
    source: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    text: str = Field(max_length=bases.MAX_TEXT)
    view: int = Field(default=0, ge=0, le=100)


@router.post("/bases/block", summary="One view of a base code block in a note")
def view_block(body: BlockIn, account: Account) -> dict[str, Any]:
    clean = need(account, body.source, READ)
    try:
        config = bases.read(body.text)
    except bases.BaseError as exc:
        raise error("bad_view", str(exc), 422) from exc
    with SessionLocal() as db:
        space = _space(db, clean)
        return _answer(bases.run(db, config, space.id, space.folder, body.view))


class CellIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    #: ``note.status`` or ``status``; file and formula values are not written.
    key: str = Field(min_length=1, max_length=110)
    value: Any = None


def _cell_value(value: Any) -> Any:
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str) and len(value) <= 2000:
        return value
    texts = isinstance(value, list) and all(isinstance(item, str) and len(item) <= 500 for item in value)
    if texts and len(value) <= 200:
        return value
    raise error("bad_value", "A value is text, a number, yes or no, or a list of texts.", 422)


@router.put("/bases/cell", summary="Change one property of a note from a view")
def change_cell(body: CellIn, account: Account, who: ActorDep) -> dict[str, Any]:
    clean = need(account, body.path, WRITE)
    key = body.key.removeprefix("note.")
    if body.key.startswith(("file.", "formula.")):
        raise error("read_only_cell", "This value follows from the note; it is not written.", 422)
    value = _cell_value(body.value)
    try:
        file, data = vault.read(clean)
        content = index.decode(data)
        changed = frontedit.set_property(content, key, value)
    except ValueError as exc:
        raise error("bad_property", "This is no property name.", 422) from exc
    except VaultError as exc:
        raise error("not_found" if exc.status == 404 else exc.code, exc.text, exc.status) from exc
    try:
        saved = vault.save(clean, changed.encode("utf-8"), base_hash=file.hash, actor=who)
    except VaultError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
    return {"path": clean, "conflict": saved.conflict}


class NewBaseIn(BaseModel):
    folder: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    name: str = Field(min_length=1, max_length=200)


@router.post("/bases", status_code=201, summary="Make a new view in a folder")
def create(body: NewBaseIn, account: Account, who: ActorDep) -> dict[str, Any]:
    folder = need(account, body.folder, WRITE).rstrip("/")
    name = body.name.strip().removesuffix(".base")
    try:
        paths.check_name(name)
    except ValueError as exc:
        raise error("bad_name", "This name cannot be a file name.", 422) from exc
    inside = folder.split("/", 1)[1] if "/" in folder else ""
    text = bases.DEFAULT.replace("{folder}", inside.replace('"', "")).encode("utf-8")
    rel = posixpath.join(folder, name + ".base")
    full = paths.vault_root().joinpath(*rel.split("/"))
    if full.exists():
        raise error("exists", "There is a file of this name already.", 409)
    full.parent.mkdir(parents=True, exist_ok=True)
    with index.guard, SessionLocal() as db:
        stat = vault.atomic_write(full, text)
        index.record(db, rel, text, stat, source=index.APP, author=who.name, known_new=True)
        db.commit()
    return {"path": rel}


class BaseTextIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    text: str = Field(max_length=bases.MAX_TEXT)
    base_hash: str = Field(min_length=64, max_length=64)


@router.put("/bases/file", summary="Save a view's YAML")
def save_text(body: BaseTextIn, account: Account, who: ActorDep) -> dict[str, Any]:
    clean = need(account, body.path, WRITE)
    if not _is_base(clean):
        raise error("not_a_view", "This is no view.", 422)
    try:
        bases.read(body.text)
    except bases.BaseError as exc:
        raise error("bad_view", str(exc), 422) from exc
    full = paths.vault_root().joinpath(*clean.split("/"))
    data = body.text.encode("utf-8")
    with index.guard, SessionLocal() as db:
        file = db.scalar(select(File).where(File.path == clean, File.deleted_at.is_(None)))
        if file is None or not full.exists():
            raise error("not_found", "Not found.", 404)
        if index.digest(full.read_bytes()) != body.base_hash:
            raise error("changed", "The view changed in between; load it again.", 409)
        stat = vault.atomic_write(full, data)
        index.record(db, clean, data, stat, source=index.APP, author=who.name, file=file)
        db.commit()
    return {"path": clean, "hash": index.digest(data)}
