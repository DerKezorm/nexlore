"""Dependencies shared by the routers."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

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
