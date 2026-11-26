"""The operator's own languages: JSON files in ``<data_dir>/locales`` (or ``NEXLORE_LOCALES_DIR``), now from the
shared module ``vendor/nexsprachen`` (sprachen 1.0.0, plan "Einstellungen" E51).

English and German ship inside the frontend. Every further language is one file named after its code (``es.json``,
``pt-BR.json``); what it leaves out falls back to English in the browser. A file for ``en`` or ``de`` is laid over the
shipped texts. The folder stays where it was: every file of before keeps working. The page makes the template from its
own English texts, so the server hands none out.
"""

from __future__ import annotations

from ..config import get_settings
from ..vendor import nexsprachen
from ..vendor.nexsprachen import *  # the names of nexlore's services/locales.py of before

#: The languages nexlore ships, in its order, each named in itself.
BUILT_IN = {"de": "Deutsch", "en": "English"}


def configure() -> None:
    nexsprachen.configure(nexsprachen.AppConfig(
        app_name="nexlore",
        folder=lambda: get_settings().locales_dir,
        built_in=BUILT_IN,
        logger_name="nexlore.locales",
    ))


configure()
