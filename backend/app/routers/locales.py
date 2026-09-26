"""The operator's own languages, for the language menu.

Readable without signing in: the sign-in page is shown in the chosen language too, and the texts are the same for
everybody.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..errors import detail
from ..services import locales

router = APIRouter(prefix="/api/locales", tags=["locales"])


class LocaleEntry(BaseModel):
    code: str
    name: str
    keys: int


@router.get("", response_model=list[LocaleEntry], summary="Languages the operator added")
def list_locales() -> list[locales.Locale]:
    return locales.available()


@router.get("/{code}", summary="The texts of one added language", response_model=None)
def read_locale(code: str) -> dict[str, Any] | JSONResponse:
    if not locales.valid_code(code):
        return JSONResponse(status_code=404, content={"detail": detail("not_found", "Not found.")})
    try:
        return locales.load(code)
    except FileNotFoundError:
        return JSONResponse(status_code=404, content={"detail": detail("not_found", "Not found.")})
    except (locales.LocaleError, OSError):
        return JSONResponse(
            status_code=422, content={"detail": detail("locale_unusable", "This language file cannot be used.")}
        )
