"""The operator's own languages, for the language menu: the routes of the shared module ``vendor/nexsprachen``
(sprachen 1.0.0) under ``/api/locales``, as before.

Readable without signing in: the sign-in page is shown in the chosen language too, and the texts are the same for
everybody. Adding and removing is the operator's. The list names the built-in languages too now (``built_in``,
``own``); every caller of before skips the built-in codes already.
"""

from __future__ import annotations

from ..deps import require_operator
from ..services import locales  # noqa: F401 (configures the module before the routes are used)
from ..vendor.nexsprachen import api

router = api.router(operator=require_operator)
