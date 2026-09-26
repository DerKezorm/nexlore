"""Dependencies shared by the routers."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .errors import error

DbSession = Annotated[Session, Depends(get_db)]


def require_operator() -> str:
    """The operator, by name.

    Accounts arrive in M4. Until then nobody is the operator, so every operator route answers 401: a route that
    exists without a guard would be open to whoever finds the address. The tests stand in for the operator by
    overriding this dependency.
    """
    raise error("sign_in_required", "Sign in first.", 401)


OperatorAccount = Annotated[str, Depends(require_operator)]


#: The name changes go under while the open test access stands in for accounts.
OPEN_ACCESS_ACCOUNT = "local"


def require_account() -> str:
    """The signed-in account, by name.

    Accounts arrive in M4. Until then only ``NEXLORE_UNSAFE_OPEN_ACCESS`` lets anybody in, as ``local``; without it
    every note route answers 401. Tests stand in by overriding this dependency.
    """
    if get_settings().unsafe_open_access:
        return OPEN_ACCESS_ACCOUNT
    raise error("sign_in_required", "Sign in first.", 401)


Account = Annotated[str, Depends(require_account)]
