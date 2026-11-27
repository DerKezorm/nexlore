"""Who is asking.

Every route under ``/api`` except setup, sign-in, invitations, the public reading pages, languages and health needs
the session cookie. Changing requests need ``X-Nexlore-Client`` on top (``GuardMiddleware``): a page on another site
can make a browser send a form with the cookie, but not a request with a header of its own.
"""

from __future__ import annotations

import ipaddress
import logging
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import SessionLocal, get_db
from .errors import detail, error
from .models import OPERATOR, SIGN_IN_PASSWORD, AuthSession, OidcLink, OidcProvider, utcnow
from .models import Account as AccountRow
from .security import SESSION_COOKIE, hash_token, session_account, session_via
from .services import accounts, logs, paths, rights, totp
from .vendor.nexkonten.brake import BRAKE, DOOR_CONFIRM, door_key
from .vendor.nexkonten.common import FRESH_SIGN_IN_MINUTES, fresh_sign_in

DbSession = Annotated[Session, Depends(get_db)]

logger = logging.getLogger("nexlore.auth")


@lru_cache(maxsize=4)
def _trusted_networks(spec: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    networks = []
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue
    return tuple(networks)


def parse_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The address in a peer or a forwarded hop, without port, brackets or zone; IPv4 in IPv6 dress unwrapped."""
    text = text.strip()
    candidates = [text]
    if text.startswith("[") and "]" in text:
        candidates.insert(0, text[1 : text.index("]")])
    elif text.count(":") == 1:
        candidates.insert(0, text.split(":")[0])
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate.split("%")[0])
        except ValueError:
            continue
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            return address.ipv4_mapped
        return address
    return None


def normal_address(text: str) -> str:
    """One sender, one spelling, for the brake: IPv6 as its /64 (one connection usually holds a whole /64). Before,
    every port and every way of writing an address counted as a new sender."""
    address = parse_address(text)
    if address is None:
        return text.strip()[:64]
    if isinstance(address, ipaddress.IPv6Address) and not address.is_loopback:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def is_trusted_proxy(text: str) -> bool:
    networks = _trusted_networks(get_settings().trusted_proxies)
    address = parse_address(text) if networks else None
    return address is not None and any(address in network for network in networks)


_warned_unknown_proxy = False


def behind_unknown_proxy(request: Request) -> bool:
    """A request that came through a proxy nexlore was not told to believe: all senders look alike then."""
    global _warned_unknown_proxy
    if not request.headers.get("x-forwarded-for") or _trusted_networks(get_settings().trusted_proxies):
        return False
    if not _warned_unknown_proxy:
        _warned_unknown_proxy = True
        logger.warning("Requests arrive with X-Forwarded-For, but NEXLORE_TRUSTED_PROXIES is not set: every sender "
                       "looks like the proxy. Set it to the proxy's address so the sign-in brake can tell them apart.")
    return True


def client_ip(request: Request) -> str:
    """The sender's address, for the brake. ``X-Forwarded-For`` counts only from a configured trusted proxy, and
    then its rightmost hop that is not itself a trusted proxy: everything left of it the sender wrote itself."""
    peer = request.client.host if request.client else "-"
    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded or not is_trusted_proxy(peer):
        return normal_address(peer)
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(hops):
        if not is_trusted_proxy(hop):
            return normal_address(hop)
    return normal_address(hops[0] if hops else peer)


#: What an account that must set up its second factor may still reach: itself, the way out, and the setup.
SETUP_ONLY_PATHS = {
    "/api/auth/me", "/api/auth/logout", "/api/auth/totp/begin", "/api/auth/totp/setup", "/api/auth/totp/confirm",
    "/api/auth/passkeys", "/api/auth/passkeys/begin", "/api/auth/passkeys/finish",
    # The shared key module: an account that owes its second factor still makes keys; they rest until it has one
    # (``authenticate`` refuses them), and the card says so.
    "/api/connections/keys",
}


def require_account(request: Request) -> AccountRow:
    """The signed-in account, detached from the database session (routes open their own)."""
    with SessionLocal() as db:
        account = session_account(db, request.cookies.get(SESSION_COOKIE))
        if account is None:
            raise error("sign_in_required", "Sign in first.", 401)
        if request.url.path not in SETUP_ONLY_PATHS and totp.setup_required(
            db, account, session_via(db, request.cookies.get(SESSION_COOKIE))
        ):
            raise error("second_factor_setup_required", "Set up your second factor first.", 403)
        db.expunge(account)
    logs.set_actor(account.name)
    return account


def require_operator(request: Request, account: Annotated[AccountRow, Depends(require_account)]) -> AccountRow:
    if account.role != OPERATOR:
        raise error("operator_only", "Only the operator may do this.", 403)
    networks = _trusted_networks(get_settings().operator_networks)
    if networks:
        try:
            sender = ipaddress.ip_address(client_ip(request).split("/")[0])
        except ValueError:
            sender = None
        # An IPv6 sender stands as its /64 here: its network's first address is inside the operator's networks
        # exactly when the /64 is (they are not smaller than /64 in a home network).
        if sender is None or not any(sender in network for network in networks):
            raise error("operator_network", "The operator's settings are open only from the home network.", 403)
    return account


Account = Annotated[AccountRow, Depends(require_account)]
OperatorAccount = Annotated[AccountRow, Depends(require_operator)]


# --- The password once more, while signed in ------------------------------------------------------------------------
#
# Changing the password or linking the account to a provider asks for the password again, and a wrong answer counts
# the way it does at sign-in: otherwise a stolen cookie would be a place to guess without limit. The count is the
# shared module's (``confirm:<account>``, five free), the same the module's own doors use: a route of nexlore's own
# and one of the module never count apart.


def _reauth_keys(account: AccountRow) -> tuple[str, ...]:
    return (door_key(DOOR_CONFIRM, account.id),)


def reauth_guard(request: Request, account: AccountRow) -> None:
    """One password typed to confirm: refused while the account is locked or its count waits; counted as a failure
    until ``reauth_succeeded`` takes it back."""
    if accounts.is_locked(account):
        raise error("account_locked", "Too many failed attempts. Try again later.", 429)
    wait = BRAKE.claim(_reauth_keys(account))
    if wait > 0:
        seconds = max(1, int(wait + 0.999))
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=seconds),
            headers={"Retry-After": str(seconds)},
        )


def reauth_failed(request: Request, db: Session, account: AccountRow) -> None:
    accounts.note_failure(db, account)


def reauth_succeeded(request: Request, db: Session, account: AccountRow) -> None:
    BRAKE.succeeded(_reauth_keys(account))
    accounts.note_success(db, account)


#: How old the session of an account that signs in through a provider may be for an operator act: the shared
#: module's window (``nexkonten.common.FRESH_SIGN_IN_MINUTES``, five minutes).
OPERATOR_FRESH_MINUTES = FRESH_SIGN_IN_MINUTES


def _session_row(request: Request, db: Session) -> AuthSession | None:
    cookie = request.cookies.get(SESSION_COOKIE)
    header = request.headers.get("authorization", "")
    if not cookie or header[:7].lower() == "bearer ":
        return None
    return db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(cookie)))


def fresh_from_provider(request: Request, db: Session, row: AccountRow) -> None:
    """An account without a password here proves it is still them by a sign-in at the provider younger than
    ``OPERATOR_FRESH_MINUTES``: the browser session must be that new. Otherwise the refusal names the account's
    providers, and the page sends the browser there and back. A token (a paired device, an MCP key) is never
    enough."""
    session = _session_row(request, db)
    if session is not None and session.account_id == row.id and fresh_sign_in(session.created_at, utcnow()):
        return
    providers = [
        {"slug": entry.slug, "label": entry.label}
        for entry in db.scalars(
            select(OidcProvider)
            .join(OidcLink, OidcLink.provider_id == OidcProvider.id)
            .where(OidcLink.account_id == row.id, OidcProvider.enabled.is_(True))
            .order_by(OidcProvider.position, OidcProvider.id)
        )
    ]
    raise error("fresh_sign_in_required", "Sign in at your provider again first: this needs a sign-in from the "
                f"last {OPERATOR_FRESH_MINUTES} minutes.", 403, minutes=OPERATOR_FRESH_MINUTES, providers=providers)


def confirm_fresh_session(request: Request, db: Session, account: AccountRow) -> None:
    """The browser session is younger than ``OPERATOR_FRESH_MINUTES``: the person signed in just now (after a new
    password through a link, "Disconnect all" asks no password again, but a stolen older session is not enough)."""
    session = _session_row(request, db)
    if session is not None and session.account_id == account.id and fresh_sign_in(session.created_at, utcnow()):
        return
    raise error("fresh_sign_in_required", "Sign in again first: this needs a sign-in from the last "
                f"{OPERATOR_FRESH_MINUTES} minutes.", 403, minutes=OPERATOR_FRESH_MINUTES, providers=[])


def confirm_operator(request: Request, db: Session, operator: AccountRow, password: str) -> None:
    """The operator's password once more, before an act a stolen session must not be enough for: carrying a backup
    away, making a reset link for another account, taking its second factor, changing a role, renaming, blocking or
    deleting an account. An operator who signs in through a provider has no password here; it needs a sign-in at the
    provider from the last few minutes instead (``fresh_from_provider``, the shared account module's rule; 1.16.0
    asked it nothing)."""
    row = db.get(AccountRow, operator.id)
    assert row is not None
    if row.sign_in != SIGN_IN_PASSWORD or not row.password_hash:
        fresh_from_provider(request, db, row)
        return
    reauth_guard(request, row)
    if not accounts.check_password(row, password):
        reauth_failed(request, db, row)
        raise error("wrong_password", "The current password is wrong.", 401)
    reauth_succeeded(request, db, row)


# --- Rights in a space -----------------------------------------------------------------------------------------------


def need(account: AccountRow, rel: str, role: str) -> str:
    """The right ``role`` in the space of the vault path ``rel`` (a space name works too), or the error. A space the
    account may not read answers exactly like one that does not exist. Returns the parsed path."""
    try:
        clean = paths.parse(rel)
    except paths.PathError as exc:
        raise error(exc.code, str(exc), **exc.values) from exc
    with SessionLocal() as db:
        try:
            rights.check(db, account, clean, role)
        except rights.RightsError as exc:
            raise error(exc.code, exc.text, exc.status) from exc
    return clean


def readable_spaces(account: AccountRow, need_role: str = rights.READ) -> set[int]:
    """The ids of every space the account has at least ``need_role`` in."""
    with SessionLocal() as db:
        if need_role == rights.READ:
            return rights.readable_ids(db, account)
        return {
            space_id
            for space_id in rights.readable_ids(db, account)
            if rights.at_least(rights.role_in(db, account, space_id), need_role)
        }
