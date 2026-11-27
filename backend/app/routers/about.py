"""Version and license (open to anybody), and whether a newer nexlore is out: the routes of the shared module
``vendor/nexupdates`` (updates 0.1.1) under ``/api/about``.

The state and the daily check belong to the operator (U2, U15): a member gets the same form as before with every field
empty and ``hidden`` true, and never makes a question go out. The names of 1.16.0 in the API's description stay
(operationIds, summaries, schemas; E53).
"""

from __future__ import annotations

from typing import Any

from ..deps import require_account, require_operator
from ..models import OPERATOR
from ..services import updates
from ..vendor.nexupdates import api

REPO_URL = updates.REPO_URL

#: What the summaries said in 1.16.0 (the module's are nexnotes').
SUMMARIES = {
    "about": "About nexlore",
    "update_state": "Whether a newer nexlore is out (asked once a day)",
    "check_now": "Ask now, also with the daily check off",
    "switch": "Switch the daily check",
}


def _is_operator(account: Any) -> bool:
    return getattr(account, "role", None) == OPERATOR


router = api.router(account=require_account, operator=require_operator, is_operator=_is_operator,
                    summaries=SUMMARIES)
