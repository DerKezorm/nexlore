"""The graph over HTTP: the circles of a space, the notes of a part of the map, a note's neighbourhood.

Every route asks for the right to read the space first (``deps.need``); a space the account may not read answers
exactly like one that does not exist, so not even its name or size gets out. Links never cross spaces, so whatever a
route returns about links stays inside the space that was asked about.
"""

from __future__ import annotations

import gzip
import json
import re
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from sqlalchemy import select

from ..config import get_settings
from ..db import SessionLocal
from ..deps import Account, need
from ..errors import error
from ..models import MANAGE, READ, File, Space
from ..services import graphstore, paths, rights

router = APIRouter(prefix="/api/graph", tags=["graph"])

Cloud = Annotated[str, Query(pattern="^(folders|tags|topics)$")]
SpaceName = Annotated[str, Query(min_length=1, max_length=255)]
PathQuery = Annotated[str, Query(min_length=1, max_length=paths.MAX_PATH_CHARS)]
TILE = re.compile(r"^(-?\d{1,3}):(-?\d{1,9}):(-?\d{1,9})$")


def _packed(request: Request, data: dict[str, Any]) -> Response:
    """JSON, compressed when the browser takes gzip: an overview with every link count between groups is a few
    hundred kilobytes for 30,000 notes, and a quarter of that compressed."""
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
    headers = {"Vary": "Accept-Encoding", "Cache-Control": "no-store"}
    if len(body) > 1024 and "gzip" in request.headers.get("accept-encoding", "").lower():
        return Response(gzip.compress(body, 5), media_type="application/json",
                        headers=headers | {"Content-Encoding": "gzip"})
    return Response(body, media_type="application/json", headers=headers)


def _space_id(account: Any, name: str, role: str = READ) -> int:
    if "/" in name:
        raise error("not_found", "Not found.", 404)
    need(account, name, role)
    with SessionLocal() as db:
        space_id = db.scalar(select(Space.id).where(Space.folder == name))
    if space_id is None:
        raise error("not_found", "Not found.", 404)
    return space_id


@router.get("/overview")
def overview(request: Request, account: Account, space: SpaceName, cloud: Cloud = "folders") -> Response:
    """Every circle of the space's map with its place and size, and how many links run between groups. While the
    map is still being worked out (a big space, the first time): ``status`` is ``building`` and nothing else."""
    space_id = _space_id(account, space)
    status = graphstore.ready(space_id, cloud)
    with SessionLocal() as db:
        result = graphstore.overview(db, space_id, cloud) if status == "ready" else {
            "status": "building", "version": 0, "groups": [], "links": []
        }
        result["manage"] = rights.at_least(rights.role_in(db, account, space_id), MANAGE)
    result["open_from"] = graphstore.OPEN_FROM
    result["tile"] = graphstore.TILE
    result["working"] = graphstore.worker.pending(space_id, cloud)
    return _packed(request, result)


@router.get("/tiles")
def tiles(
    request: Request,
    account: Account,
    space: SpaceName,
    t: Annotated[list[str], Query(max_length=graphstore.MAX_TILES)],
    cloud: Cloud = "folders",
) -> Response:
    """Notes that appear at a zoom level in squares of the map (``t=level:x:y``), with their links."""
    space_id = _space_id(account, space)
    wanted: list[tuple[int, int, int]] = []
    for item in t:
        found = TILE.match(item)
        if not found:
            raise error("invalid_input", "The input is not valid.", 422, fields=["t"])
        wanted.append((int(found.group(1)), int(found.group(2)), int(found.group(3))))
    with SessionLocal() as db:
        return _packed(request, graphstore.tiles(db, space_id, cloud, wanted))


def _note(account: Any, path: str) -> tuple[int, int]:
    clean = need(account, path, READ)
    with SessionLocal() as db:
        row = db.execute(
            select(File.id, File.space_id).where(File.path == clean, File.deleted_at.is_(None), File.is_note.is_(True))
        ).first()
    if row is None:
        raise error("not_found", "Not found.", 404)
    return row.id, row.space_id


@router.get("/locate")
def locate(account: Account, path: PathQuery, cloud: Cloud = "folders") -> dict[str, Any]:
    """Where a note stands on the map: for a search hit the graph flies to."""
    file_id, space_id = _note(account, path)
    graphstore.ready(space_id, cloud)
    with SessionLocal() as db:
        found = graphstore.locate(db, file_id, cloud)
    if found is None:
        raise error("not_found", "Not found.", 404)
    return found


@router.get("/local")
def local(
    account: Account,
    path: PathQuery,
    depth: Annotated[int, Query(ge=1, le=3)] = 1,
    limit: Annotated[int, Query(ge=2, le=400)] = 150,
) -> dict[str, Any]:
    """The neighbourhood of a note, up to ``depth`` links away in either direction, for the note page."""
    file_id, space_id = _note(account, path)
    with SessionLocal() as db:
        return graphstore.local(db, file_id, space_id, depth, limit)


@router.post("/topics", status_code=202)
def topics(account: Account, space: SpaceName) -> dict[str, Any]:
    """Work the topics of a space out again. Managers of the space only; the work runs in the background."""
    space_id = _space_id(account, space, MANAGE)
    if get_settings().disable_background:
        graphstore.build(space_id, "topics")
        return {"status": "ready"}
    graphstore.worker.ask(("build", space_id, "topics"))
    return {"status": "building"}
