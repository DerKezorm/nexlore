"""Public reading pages: making and withdrawing links (signed in), and the pages themselves (no sign-in).

Making a link takes the right to manage the space: it carries notes out of the house. The operator sees every link
and may withdraw any, and shuts them all at once with ``shares_allowed``. The public routes answer a token that is
unknown, ran out, or belongs to a closed server exactly alike.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Account, DbSession, OperatorAccount, client_ip, need
from ..errors import detail, error
from ..models import MANAGE, OPERATOR, Share, Space
from ..models import Account as AccountRow
from ..security import brake
from ..services import media, paths, rights, settings_service, shares
from .attachments import FILE_POLICY, _delivery
from .auth import secure_cookie

logger = logging.getLogger("nexlore.shares")

router = APIRouter(prefix="/api", tags=["shares"])

Token = Annotated[str, PathParam(min_length=20, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class ShareIn(BaseModel):
    path: str = Field(min_length=1, max_length=paths.MAX_PATH_CHARS)
    days: int | None = None
    password: str = Field(default="", max_length=200)


class ShareOut(BaseModel):
    id: int
    path: str
    folder: bool
    link: str
    by: str | None
    created_at: datetime
    expires_at: datetime | None
    password: bool


def _view(db: DbSession, request: Request, share: Share) -> ShareOut:
    by = db.get(AccountRow, share.created_by) if share.created_by else None
    base = settings_service.public_url(db) or str(request.base_url).rstrip("/")
    return ShareOut(
        id=share.id, path=share.path, folder=share.is_folder, link=f"{base}/s/{share.token}",
        by=by.name if by else None, created_at=share.created_at, expires_at=share.expires_at,
        password=bool(share.password_hash),
    )


def _fail(exc: shares.ShareError) -> HTTPException:
    return error(exc.code, exc.text, exc.status)


@router.post("/shares", response_model=ShareOut, status_code=201, summary="Put a note or a folder on a public page")
def create(payload: ShareIn, request: Request, account: Account, db: DbSession) -> ShareOut:
    if not shares.allowed(db):
        raise error("shares_off", "Public pages are turned off on this server.", 403)
    clean = need(account, payload.path, MANAGE)
    space = rights.space_named(db, paths.space_of(clean))
    if space is None:
        raise error("not_found", "No such file.", 404)
    try:
        share = shares.create(db, space_id=space.id, path=clean, by=account.id, days=payload.days,
                              password=payload.password)
    except shares.ShareError as exc:
        raise _fail(exc) from exc
    return _view(db, request, share)


@router.get("/shares", response_model=list[ShareOut], summary="The public pages of a path, or of a space")
def listing(
    request: Request,
    account: Account,
    db: DbSession,
    path: Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)],
) -> list[ShareOut]:
    """``path``: a note or folder (its own links) or a space name (every link in it)."""
    clean = need(account, path, MANAGE)
    query = select(Share).order_by(Share.created_at)
    query = query.where(Share.path == clean) if "/" in clean else query.join(Space).where(Space.folder == clean)
    return [_view(db, request, share) for share in db.scalars(query)]


@router.delete("/shares/{share_id}", status_code=204, summary="Withdraw a public page")
def withdraw(share_id: int, account: Account, db: DbSession) -> None:
    share = db.get(Share, share_id)
    allowed = share is not None and (
        account.role == OPERATOR or rights.at_least(rights.role_in(db, account, share.space_id), MANAGE)
    )
    if share is None or not allowed:
        raise error("not_found", "No such link.", 404)
    db.delete(share)
    db.commit()
    logger.info("Share withdrawn id=%s by=%s", share_id, account.name)


@router.get("/admin/shares", response_model=list[ShareOut], summary="Every public page, for the operator")
def all_shares(request: Request, _operator: OperatorAccount, db: DbSession) -> list[ShareOut]:
    # The operator sees what is public anyway: it is the operator's server that hands it out.
    return [_view(db, request, share) for share in db.scalars(select(Share).order_by(Share.created_at))]


# --- The public side ------------------------------------------------------------------------------------------------


def _share(db: DbSession, token: str) -> Share:
    share = shares.find(db, token)
    if share is None:
        raise error("not_found", "This page does not exist.", 404)
    return share


def _open(db: DbSession, request: Request, token: str) -> Share:
    share = _share(db, token)
    if not shares.unlocked(share, request.cookies.get(shares.COOKIE_PREFIX + str(share.id))):
        raise error("password_required", "This page needs its password.", 401)
    return share


class UnlockIn(BaseModel):
    password: str = Field(max_length=200)


@router.get("/public/{token}", summary="What a public page shows (no sign-in)")
def public_state(token: Token, request: Request, db: DbSession) -> dict[str, Any]:
    share = _share(db, token)
    open_ = shares.unlocked(share, request.cookies.get(shares.COOKIE_PREFIX + str(share.id)))
    result: dict[str, Any] = {
        "folder": share.is_folder,
        "name": share.path.rsplit("/", 1)[-1],
        "password": bool(share.password_hash),
        "unlocked": open_,
        "expires_at": share.expires_at.isoformat() if share.expires_at else None,
    }
    if open_:
        # Titles and paths only once the password was given: they tell something too.
        result["notes"] = [
            {"path": shares.relative(share, note.path), "title": note.title} for note in shares.notes(db, share)
        ]
    return result


@router.post("/public/{token}/unlock", status_code=204, summary="Give the password of a public page")
def unlock(token: Token, payload: UnlockIn, request: Request, response: Response, db: DbSession) -> None:
    key = "share:" + client_ip(request)
    wait = brake.wait_seconds(key)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=wait),
            headers={"Retry-After": str(wait)},
        )
    share = _share(db, token)
    if not share.password_hash:
        return
    if not shares.check_password(share, payload.password):
        brake.failed(key)
        raise error("wrong_password", "The password is wrong.", 401)
    brake.succeeded(key)
    response.set_cookie(
        shares.COOKIE_PREFIX + str(share.id), shares.pass_value(share), httponly=True, samesite="lax",
        secure=secure_cookie(request), path=f"/api/public/{token}",
        max_age=int((share.expires_at - share.created_at).total_seconds()) if share.expires_at else 30 * 86400,
    )


@router.get("/public/{token}/page", summary="One note of a public page (no sign-in)")
def public_page(
    token: Token,
    request: Request,
    db: DbSession,
    path: Annotated[str | None, Query(max_length=paths.MAX_PATH_CHARS)] = None,
) -> dict[str, Any]:
    share = _open(db, request, token)
    try:
        note = shares.note_at(db, share, path)
        return asdict(shares.page(db, share, note))
    except (shares.ShareError, OSError) as exc:
        raise error("not_found", "No such page.", 404) from exc


@router.get("/public/{token}/file/{file_id}", response_model=None, summary="A file a public note uses (no sign-in)")
def public_file(token: Token, file_id: int, request: Request, db: DbSession, download: bool = False) -> Response:
    share = _open(db, request, token)
    try:
        file = shares.file_for(db, share, file_id)
        full = paths.resolve(file.path)
    except (shares.ShareError, paths.PathError) as exc:
        raise error("not_found", "No such file.", 404) from exc
    if not full.is_file():
        raise error("not_found", "No such file.", 404)
    with open(full, "rb") as handle:
        kind = media.sniff(handle.read(64))
    media_type, shown = _delivery(full, kind, download)
    headers = {"Cache-Control": "private, no-cache", "Content-Security-Policy": FILE_POLICY}
    return FileResponse(
        full, media_type=media_type, headers=headers, filename=full.name,
        content_disposition_type="inline" if shown else "attachment",
    )
