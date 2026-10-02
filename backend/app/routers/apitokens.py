"""API tokens through the interface: an account's own (My account, Connections) and every token for the operator.

Only with a session: a token never makes, lists or deletes tokens (``require_account`` reads the session cookie).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Path
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Account, DbSession, OperatorAccount
from ..errors import error
from ..models import Account as AccountRow
from ..models import ApiToken, Space, utcnow
from ..services import apitokens, rights
from ..services.apitokens import TokenError

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


def _out(db: Any, account: Any, row: ApiToken) -> TokenOut:
    names = None
    if row.spaces is not None:
        # Only spaces the account may still read: one it lost since tells nothing (and the token does not see it).
        readable = rights.readable_ids(db, account)
        wanted = [space_id for space_id in row.spaces if space_id in readable]
        names = sorted(db.scalars(select(Space.folder).where(Space.id.in_(wanted)))) if wanted else []
    return TokenOut(id=row.id, name=row.name, level=row.level, prefix=row.prefix, created_at=row.created_at,
                    last_used_at=row.last_used_at, expires_at=row.expires_at, blocked=row.blocked_at is not None,
                    spaces=names)


@router.get("/api-tokens", response_model=TokensOut, summary="The own API tokens")
def own_tokens(account: Account, db: DbSession) -> TokensOut:
    rows = db.scalars(select(ApiToken).where(ApiToken.account_id == account.id).order_by(ApiToken.id)).all()
    return TokensOut(allowed=apitokens.allowed(db), tokens=[_out(db, account, row) for row in rows])


@router.post("/api-tokens", response_model=MadeOut, status_code=201, summary="Make an API token; shown once")
def make_token(body: TokenIn, account: Account, db: DbSession) -> MadeOut:
    if not apitokens.allowed(db):
        raise error("api_off", "The operator has not switched API tokens on.", 403)
    try:
        row, secret = apitokens.make(db, account, body.name, body.level, body.spaces, body.days)
    except TokenError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
    return MadeOut(token=_out(db, account, row), secret=secret)


@router.delete("/api-tokens/{token_id}", status_code=204, summary="Delete an own API token")
def delete_token(token_id: Annotated[int, Path(ge=1)], account: Account, db: DbSession) -> None:
    row = db.get(ApiToken, token_id)
    if row is None or row.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    db.delete(row)
    db.commit()
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


@router.get("/admin/api-tokens", response_model=list[AnyTokenOut], summary="Every API token (operator)")
def every_token(_operator: OperatorAccount, db: DbSession) -> list[AnyTokenOut]:
    names = dict(db.execute(select(AccountRow.id, AccountRow.name)).all())
    rows = db.scalars(select(ApiToken).order_by(ApiToken.account_id, ApiToken.id)).all()
    return [AnyTokenOut(id=row.id, account=names.get(row.account_id, ""), name=row.name, level=row.level,
                        prefix=row.prefix, spaces=None if row.spaces is None else len(row.spaces),
                        created_at=row.created_at, last_used_at=row.last_used_at, expires_at=row.expires_at,
                        blocked=row.blocked_at is not None) for row in rows]


@router.post("/admin/api-tokens/{token_id}/block", response_model=AnyTokenOut,
             summary="Block a token for good (operator); its account sees it blocked")
def block_token(token_id: Annotated[int, Path(ge=1)], _operator: OperatorAccount, db: DbSession) -> AnyTokenOut:
    row = db.get(ApiToken, token_id)
    if row is None:
        raise error("not_found", "Not found.", 404)
    if row.blocked_at is None:
        row.blocked_at = utcnow()
        db.commit()
        logger.info("API token blocked by the operator token_id=%s", token_id)
    owner = db.get(AccountRow, row.account_id)
    return AnyTokenOut(id=row.id, account=owner.name if owner else "", name=row.name, level=row.level,
                       prefix=row.prefix, spaces=None if row.spaces is None else len(row.spaces),
                       created_at=row.created_at, last_used_at=row.last_used_at, expires_at=row.expires_at,
                       blocked=True)
