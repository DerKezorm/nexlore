"""Version and license."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import __version__

router = APIRouter(prefix="/api/about", tags=["about"])

REPO_URL = "https://github.com/DerKezorm/nexlore"


@router.get("", summary="About nexlore")
def about() -> dict[str, Any]:
    return {"version": __version__, "license": "AGPL-3.0", "repo_url": REPO_URL}
