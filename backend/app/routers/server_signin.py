"""Server › Sign-in (plan "Einstellungen", Anmeldung; konten 1.1.0): the operator's switches with the module's rules
and "Ready for the internet?", which the server checks each time the page opens.

The switches stay where 1.16.0 kept them (``password_login``, ``two_factor_required``, ``passkeys_allowed`` in the
settings, ``KontenStore.sign_in_settings``); the public address keeps its own way (``PUT /api/settings`` with
``public_url``, the module oidc's question when authentik knows the old one). ``PUT /api/settings`` answers the
switches as before and goes through the same rules (``routers/settings.py``).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..config import get_settings
from ..deps import DbSession, OperatorAccount, confirm_operator
from ..models import SIGN_IN_PASSWORD, OidcLink, OidcProvider
from ..models import Account as AccountRow
from ..services import settings_service
from ..services.konten_store import KontenStore
from ..vendor import nexkonten
from ..vendor.nexkonten import readiness, signin
from .auth import fail

router = APIRouter(prefix="/api/server/sign-in", tags=["settings"])

#: Headers a proxy puts in front of a request: one that came from an address not in the trusted list is a proxy nexlore
#: does not know.
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded")


class SignInIn(BaseModel):
    password_login: bool | None = None
    factor_required: bool | None = None
    passkeys_allowed: bool | None = None
    #: The operator's own password: asked when the second factor for everybody goes off.
    current_password: str = Field(default="", max_length=200)


def provider_checked(db: DbSession, operator: AccountRow) -> bool:
    """The operator signs in through a provider whose switch says it checks the second factor itself: switching the
    second factor for everybody on locks nobody out."""
    if operator.sign_in == SIGN_IN_PASSWORD:
        return False
    found = db.scalar(
        select(OidcProvider.id)
        .join(OidcLink, OidcLink.provider_id == OidcProvider.id)
        .where(OidcLink.account_id == operator.id, OidcProvider.enabled.is_(True),
               OidcProvider.trusts_second_factor.is_(True))
        .limit(1)
    )
    return found is not None


def view(db: DbSession, operator: AccountRow) -> dict[str, Any]:
    found = signin.view(KontenStore(db), operator.id, provider_checked=provider_checked(db, operator))
    return {
        **found,
        "public_url": settings_service.public_url(db),
        "operator_has_password": operator.sign_in == SIGN_IN_PASSWORD and bool(operator.password_hash),
    }


def change(db: DbSession, request: Request, operator: AccountRow, *, password_login: bool | None = None,
           factor_required: bool | None = None, passkeys_allowed: bool | None = None,
           current_password: str = "") -> None:
    """The switches through the module (``signin.change``). Turning the second factor for everybody off asks for the
    operator's password once more, counted at the brake like every confirmation (``confirm_operator``)."""
    store = KontenStore(db)
    weaker = factor_required is False and store.sign_in_settings().factor_required
    if weaker:
        confirm_operator(request, db, operator, current_password)
    try:
        signin.change(
            store, operator.id, password_login=password_login, factor_required=factor_required,
            passkeys_allowed=passkeys_allowed, actor_confirmed=weaker,
            provider_checked=provider_checked(db, operator),
        )
    except nexkonten.AccountError as exc:
        raise fail(exc) from exc


@router.get("", summary="The sign-in switches, what may change, and the public address")
def read(operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    return view(db, operator)


@router.put("", summary="Change the sign-in switches (the second factor goes off only with the own password)")
def save(payload: SignInIn, request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    change(db, request, operator, password_login=payload.password_login, factor_required=payload.factor_required,
           passkeys_allowed=payload.passkeys_allowed, current_password=payload.current_password)
    db.refresh(operator)
    return view(db, operator)


@router.get("/readiness", summary="Ready for the internet? What the server checks of itself, point by point")
def ready(request: Request, operator: OperatorAccount, db: DbSession) -> dict[str, Any]:
    settings = get_settings()
    store = KontenStore(db)
    checking = [
        row.label
        for row in db.scalars(
            select(OidcProvider)
            .where(OidcProvider.enabled.is_(True), OidcProvider.trusts_second_factor.is_(True))
            .order_by(OidcProvider.position, OidcProvider.id)
        )
    ]
    forwarded = any(request.headers.get(name) for name in PROXY_HEADERS)
    found = readiness.check(
        public_url=settings_service.public_url(db),
        request_https=request.url.scheme == "https",
        factor_required=store.factor_required(),
        own_factor=signin.has_own_factor(store, operator.id),
        trusted_proxies=[settings.trusted_proxies],
        peer=request.client.host if request.client else "",
        forwarded=bool(forwarded),
        cookie_secure=settings.cookie_secure,
        providers_checking=checking,
    )
    return found.as_dict()
