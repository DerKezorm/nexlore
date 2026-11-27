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

#: The names nexlore's routes had in its description of the interface before the module (``/api/openapi.json`` with
#: ``NEXLORE_API_DOCS``): a snapshot or a generated client keeps working. The template is new and keeps the module's.
OPERATION_IDS = {
    "list": "list_locales_api_locales_get",
    "read": "read_locale_api_locales__code__get",
    "upload": "upload_locale_api_locales__code__put",
    "remove": "delete_locale_api_locales__code__delete",
}
SUMMARIES = {
    "list": "Languages the operator added",
    "read": "The texts of one added language",
    "upload": "Add or replace a language (operator)",
    "remove": "Remove an added language (operator)",
}
#: One schema ``LocaleEntry`` for the list and the upload, as before (the list's entries now with ``built_in`` and
#: ``own``).
SCHEMA_NAMES = {"LanguageEntry": "LocaleEntry", "LocaleEntry": "LocaleEntry"}

router = api.router(
    operator=require_operator, operation_ids=OPERATION_IDS, summaries=SUMMARIES, schema_names=SCHEMA_NAMES
)
