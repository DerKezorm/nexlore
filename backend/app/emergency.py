"""The emergency command, inside the container, without an operator signed in (the shared account module,
``resets.server_reset_link``):

    python -m app.emergency reset-link <username or email> [--days 1|7|30]

prints a link with which that account sets a new password (the operator who forgot theirs, or the only one). The link
works once; whoever uses it signs in afresh, the account hears at the next sign-in that the server made it.
"""

from __future__ import annotations

import argparse
import sys

from .db import SessionLocal, init_db
from .services import settings_service
from .services.konten_store import KontenStore
from .vendor import nexkonten
from .vendor.nexkonten import resets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.emergency", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    link = commands.add_parser("reset-link", help="a link to set a new password for one account")
    link.add_argument("who", help="the username or the email address")
    link.add_argument("--days", type=int, default=1, choices=resets.OPERATOR_DAYS)
    args = parser.parse_args(argv)
    init_db()
    with SessionLocal() as db:
        try:
            made = resets.server_reset_link(KontenStore(db), args.who, days=args.days)
        except nexkonten.AccountError as exc:
            print(f"Refused: {exc.message}", file=sys.stderr)
            return 1
        base = settings_service.public_url(db) or "<the address of nexlore>"
    print(f"{base}/reset/{made.token}")
    print(f"Valid until {made.expires_at.isoformat(timespec='minutes')} (once).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
