"""API tokens through the interface: an account's own (My account, Connections) and every token for the operator.

Only with a session: a token never makes, lists or deletes tokens (``require_account`` reads the session cookie).
The old ways, answering as before; behind them the shared key module (``keys.listing/make/revoke/overview/block``),
as the cards under ``/api/connections``.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path
from pydantic import BaseModel, Field

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..services.schluessel_store import CONFIG, SchluesselStore, nexschluessel, old_id, old_refusal

keys = nexschluessel.keys

logger = logging.getLogger("nexlore.api")

router = APIRouter(prefix="/api", tags=["api tokens"])


class TokenOut(BaseModel):
    id: int
    name: str
    level: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    #: The operator blocked it: it answers like none, for good.
    blocked: bool = False
    #: The names of the spaces the token may see, of those the account may read now; None: all of them.
    spaces: list[str] | None = None


class TokensOut(BaseModel):
    allowed: bool
    tokens: list[TokenOut]


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    level: str = Field(pattern="^(read|write)$")
    #: Ids of spaces; left out: every space the account may read, now and later.
    spaces: list[int] | None = Field(default=None, max_length=1000)
    #: 30, 90 or 365; left out: never runs out.
    days: int | None = None


class MadeOut(BaseModel):
    token: TokenOut
    #: Shown once, never again.
    secret: str


def _names(entry: dict) -> list[str] | None:
    """The names of the spaces of a key, of those the account may read now (a space it lost since tells nothing)."""
    if entry["areas"] is None:
        return None
    return sorted(area["name"] for area in entry["areas"] if area["name"] is not None)


def _out(entry: dict) -> TokenOut:
    return TokenOut(id=old_id(entry["id"], "api"), name=entry["name"], level=entry["right"], prefix=entry["prefix"],
                    created_at=entry["created_at"], last_used_at=entry["last_used_at"],
                    expires_at=entry["expires_at"], blocked=entry["blocked"], spaces=_names(entry))


def _refused(exc: nexschluessel.KeyRefused) -> Exception:
    code, text, status = old_refusal(exc, "api")
    return error(code, text, status)


@router.get("/api-tokens", response_model=TokensOut, summary="The own API tokens")
def own_tokens(account: Account, db: DbSession) -> TokensOut:
    found = keys.listing(SchluesselStore(db), CONFIG, account.id)
    own = sorted((entry for entry in found["keys"] if entry["kind"] == "api"),
                 key=lambda entry: old_id(entry["id"], "api"))
    return TokensOut(allowed=found["api"], tokens=[_out(entry) for entry in own])


@router.post("/api-tokens", response_model=MadeOut, status_code=201, summary="Make an API token; shown once")
def make_token(body: TokenIn, account: Account, db: DbSession) -> MadeOut:
    store = SchluesselStore(db)
    if not store.switch("api"):
        raise error("api_off", "The operator has not switched the programming interface (API) on.", 403)
    try:
        made = keys.make(store, CONFIG, account.id, kind="api", name=body.name.strip() or "API", right=body.level,
                         areas=body.spaces, days=body.days)
    except nexschluessel.KeyRefused as exc:
        raise _refused(exc) from exc
    entry = keys.entry(made.key, CONFIG, store.areas_of(account.id, "api"))
    logger.info("API token made token_id=%s level=%s spaces=%s days=%s", old_id(made.key.id, "api"), body.level,
                "all" if body.spaces is None else len(made.key.areas or []), body.days or "never")
    return MadeOut(token=_out(entry), secret=made.secret)


@router.delete("/api-tokens/{token_id}", status_code=204, summary="Delete an own API token")
def delete_token(token_id: Annotated[int, Path(ge=1)], account: Account, db: DbSession) -> None:
    try:
        keys.revoke(SchluesselStore(db), CONFIG, account.id, f"api-{token_id}")
    except nexschluessel.KeyRefused as exc:
        raise _refused(exc) from exc
    logger.info("API token deleted token_id=%s", token_id)


# --- The operator ----------------------------------------------------------------------------------------------------


class AnyTokenOut(BaseModel):
    id: int
    account: str
    name: str
    level: str
    prefix: str
    #: How many spaces it is limited to; None: all its account may read.
    spaces: int | None = None
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    blocked: bool = False


def _any(entry: dict) -> AnyTokenOut:
    # Since schluessel E36 the operator sees no start of a key: the old field stays, empty (plan E40).
    return AnyTokenOut(id=old_id(entry["id"], "api"), account=entry["account"]["name"], name=entry["name"],
                       level=entry["right"], prefix="", spaces=entry["areas"],
                       created_at=entry["created_at"], last_used_at=entry["last_used_at"],
                       expires_at=entry["expires_at"], blocked=entry["blocked"])


@router.get("/admin/api-tokens", response_model=list[AnyTokenOut], summary="Every API token (operator)")
def every_token(_operator: OperatorAccount, db: DbSession) -> list[AnyTokenOut]:
    found = [entry for entry in keys.overview(SchluesselStore(db), CONFIG) if entry["kind"] == "api"]
    found.sort(key=lambda entry: (entry["account"]["id"], old_id(entry["id"], "api")))
    return [_any(entry) for entry in found]


@router.post("/admin/api-tokens/{token_id}/block", response_model=AnyTokenOut,
             summary="Block a token (operator); its account sees it blocked")
def block_token(token_id: Annotated[int, Path(ge=1)], _operator: OperatorAccount, db: DbSession) -> AnyTokenOut:
    store = SchluesselStore(db)
    was = store.key(f"api-{token_id}")
    try:
        entry = keys.block(store, CONFIG, f"api-{token_id}")
    except nexschluessel.KeyRefused as exc:
        raise _refused(exc) from exc
    if was is not None and was.blocked_at is None:
        logger.info("API token blocked by the operator token_id=%s", token_id)
    return _any(entry)
