"""Colour themes (``services/themes``) and own CSS (``services/csscheck``), per account.

A theme is referred to as ``nexlore`` (the own look), by the key of one that comes along, or as ``t:<id>``. Anybody
may read a theme that came along, the own ones, the shared ones, and one a readable space sets for its notes; any
other stored theme answers like one that is not there. Only the owner changes a theme.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal
from ..deps import Account, readable_spaces
from ..errors import error
from ..models import Account as AccountRow
from ..models import CssSnippet, Space, Theme
from ..services import csscheck, settings_service, themes
from ..services.spaceopts import options_of

router = APIRouter(prefix="/api", tags=["themes"])

MAX_THEMES = 50
MAX_SNIPPETS = 20


def _space_refs(db: Session, account: Any) -> set[str]:
    readable = readable_spaces(account)
    return {options_of(space).get("theme", "") for space in db.scalars(select(Space).where(Space.id.in_(readable)))}


def colours_of(db: Session, account: Any, ref: str) -> dict[str, Any] | None:
    """The colours behind ``ref`` if the account may read them; None for nexlore's own look and for anything else."""
    if ref in themes.BUILT_IN:
        return themes.BUILT_IN[ref]
    theme_id = themes.id_of(ref)
    if theme_id is None:
        return None
    row = db.get(Theme, theme_id)
    if row is None:
        return None
    if row.account_id == account.id or row.shared or ref in _space_refs(db, account):
        return row.colours
    return None


def _view(row: Theme, owner: str | None = None) -> dict[str, Any]:
    out = {
        "ref": f"t:{row.id}", "id": row.id, "name": row.name, "colours": row.colours, "shared": row.shared,
        "weak": themes.weak_spots(row.colours),
    }
    if owner is not None:
        out["owner"] = owner
    return out


@router.get("/themes", summary="The themes that come along, the own ones and the ones others share")
def listing(account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        mine = db.scalars(select(Theme).where(Theme.account_id == account.id).order_by(Theme.id)).all()
        shared = db.execute(
            select(Theme, AccountRow.name)
            .join(AccountRow, AccountRow.id == Theme.account_id)
            .where(Theme.shared.is_(True), Theme.account_id != account.id)
            .order_by(Theme.name, Theme.id)
        ).all()
        return {
            "built_in": [{"ref": key, "colours": colours} for key, colours in themes.BUILT_IN.items()],
            "mine": [_view(row) for row in mine],
            "shared": [_view(row, owner) for row, owner in shared],
        }


@router.get("/themes/{ref}", summary="The colours of one theme")
def one(ref: str, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        colours = colours_of(db, account, ref)
    if colours is None:
        raise error("not_found", "Not found.", 404)
    return {"ref": ref, "colours": colours}


class ThemeIn(BaseModel):
    name: str = Field(min_length=1, max_length=themes.NAME_MAX)
    colours: dict[str, Any]
    shared: bool = False


class ThemeChange(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=themes.NAME_MAX)
    colours: dict[str, Any] | None = None
    shared: bool | None = None


def _checked(name: str | None, colours: dict[str, Any] | None) -> tuple[str | None, dict[str, Any] | None]:
    try:
        return (
            themes.check_name(name) if name is not None else None,
            themes.check_colours(colours) if colours is not None else None,
        )
    except themes.ThemeError as exc:
        raise error("bad_theme", str(exc), 422) from exc


@router.post("/themes", status_code=201, summary="Keep a new theme (made here or taken in from a file)")
def create(body: ThemeIn, account: Account) -> dict[str, Any]:
    name, colours = _checked(body.name, body.colours)
    with SessionLocal() as db:
        count = db.scalar(select(func.count()).select_from(Theme).where(Theme.account_id == account.id)) or 0
        if count >= MAX_THEMES:
            raise error("too_many_themes", "Too many themes.", 422, max=MAX_THEMES)
        row = Theme(account_id=account.id, name=name, colours=colours, shared=body.shared)
        db.add(row)
        db.commit()
        return _view(row)


def _own(db: Session, account: Any, theme_id: int) -> Theme:
    row = db.get(Theme, theme_id)
    if row is None or row.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    return row


@router.put("/themes/{theme_id}", summary="Change an own theme: name, colours, shared or not")
def change(theme_id: int, body: ThemeChange, account: Account) -> dict[str, Any]:
    name, colours = _checked(body.name, body.colours)
    with SessionLocal() as db:
        row = _own(db, account, theme_id)
        if name is not None:
            row.name = name
        if colours is not None:
            row.colours = colours
        if body.shared is not None:
            row.shared = body.shared
        row.changed_at = datetime.now(UTC)
        db.commit()
        return _view(row)


@router.delete("/themes/{theme_id}", status_code=204, summary="Remove an own theme (who chose it gets nexlore's look)")
def remove(theme_id: int, account: Account) -> None:
    with SessionLocal() as db:
        db.delete(_own(db, account, theme_id))
        db.commit()


# --- Own CSS ------------------------------------------------------------------------------------------------------


class SnippetIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    css: str = Field(default="", max_length=csscheck.MAX_CHARS)
    enabled: bool = True


class SnippetChange(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    css: str | None = Field(default=None, max_length=csscheck.MAX_CHARS)
    enabled: bool | None = None


def css_allowed(db: Session) -> bool:
    return bool(settings_service.get(db, "custom_css_allowed"))


def own_css(db: Session, account_id: int) -> list[str]:
    """The enabled snippets of an account, each for a style element of its own (a block one leaves open then cannot
    take in the next); empty when own CSS is not allowed."""
    if not css_allowed(db):
        return []
    rows = db.scalars(
        select(CssSnippet)
        .where(CssSnippet.account_id == account_id, CssSnippet.enabled.is_(True))
        .order_by(CssSnippet.id)
    ).all()
    # Checked once more on the way out: a snippet stored under older rules must not pass newer ones.
    return [row.css for row in rows if not csscheck.check(row.css)]


def _snippet(row: CssSnippet) -> dict[str, Any]:
    return {"id": row.id, "name": row.name, "css": row.css, "enabled": row.enabled}


def _css_or_fail(css: str) -> str:
    problems = csscheck.check(css)
    if problems:
        raise error(
            "bad_css", "This CSS is not allowed here.", 422,
            problems=[{"line": problem.line, "what": problem.what} for problem in problems[:20]],
        )
    return css


@router.get("/css-snippets", summary="The own CSS snippets, and whether the operator allows own CSS")
def snippets(account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        rows = db.scalars(select(CssSnippet).where(CssSnippet.account_id == account.id).order_by(CssSnippet.id)).all()
        return {"allowed": css_allowed(db), "snippets": [_snippet(row) for row in rows]}


@router.post("/css-snippets", status_code=201, summary="Keep a new CSS snippet")
def add_snippet(body: SnippetIn, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        if not css_allowed(db):
            raise error("css_not_allowed", "The operator has not allowed own CSS.", 403)
        count = db.scalar(select(func.count()).select_from(CssSnippet).where(CssSnippet.account_id == account.id)) or 0
        if count >= MAX_SNIPPETS:
            raise error("too_many_snippets", "Too many snippets.", 422, max=MAX_SNIPPETS)
        css = _css_or_fail(body.css)
        row = CssSnippet(account_id=account.id, name=body.name.strip(), css=css, enabled=body.enabled)
        db.add(row)
        db.commit()
        return _snippet(row)


def _own_snippet(db: Session, account: Any, snippet_id: int) -> CssSnippet:
    row = db.get(CssSnippet, snippet_id)
    if row is None or row.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    return row


@router.put("/css-snippets/{snippet_id}", summary="Change an own CSS snippet, or switch it on or off")
def change_snippet(snippet_id: int, body: SnippetChange, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        if not css_allowed(db):
            raise error("css_not_allowed", "The operator has not allowed own CSS.", 403)
        row = _own_snippet(db, account, snippet_id)
        if body.name is not None:
            row.name = body.name.strip()
        if body.css is not None:
            row.css = _css_or_fail(body.css)
        if body.enabled is not None:
            row.enabled = body.enabled
        row.changed_at = datetime.now(UTC)
        db.commit()
        return _snippet(row)


@router.delete("/css-snippets/{snippet_id}", status_code=204, summary="Remove an own CSS snippet")
def remove_snippet(snippet_id: int, account: Account) -> None:
    with SessionLocal() as db:
        db.delete(_own_snippet(db, account, snippet_id))
        db.commit()
