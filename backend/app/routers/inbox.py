"""Quick capture into the inbox note of a space (``services/inbox``): needs the right to write in the space."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..deps import Account, need
from ..errors import error
from ..models import WRITE
from ..services import inbox
from ..services.vault import VaultError
from .vault import Actor, actor

router = APIRouter(prefix="/api", tags=["inbox"])


class CaptureIn(BaseModel):
    space: str = Field(min_length=1, max_length=255)
    text: str = Field(max_length=inbox.MAX_CHARS * 2)
    #: The time as the browser's clock says: ``2026-09-29 22:41``.
    stamp: str = Field(pattern=r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
    #: The language the page is shown in: names a new inbox. Empty: the account's.
    language: str = Field(default="", max_length=16)


@router.post("/inbox", summary="Put words on top of the space's inbox note, made when there is none")
def capture(body: CaptureIn, account: Account, who: Annotated[Actor, Depends(actor)]) -> dict[str, str]:
    space = need(account, body.space, WRITE)
    if "/" in space:
        raise error("path_invalid", "Quick capture goes into a space, not a folder.", 422)
    try:
        path = inbox.capture(space, body.text, body.stamp, actor=who, language=body.language or account.language)
    except inbox.InboxError as exc:
        raise error(exc.code, str(exc), exc.status) from exc
    except VaultError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
    return {"path": path}
