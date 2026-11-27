"""nexlore's "What's new" through the shared module wasneu 0.1.0 (``app/vendor/nexwasneu``, since 1.17.0).

The texts are nexlore's: ``app/whatsnew/de.json`` and ``en.json``, one entry per version, every version before the
running one frozen in ``released.json`` (``bauplaene/wasneu/tools/sync.py freeze nexlore`` after each release). The
module serves them (``/api/whats-new``), remembers per account what was read (``Account.whats_new_seen``) and guards
the texts before every release (``tests/nexwasneu``). Configured on import, so that every way that makes an account
(setup, invitation, sign-in provider, the command line) starts it on the running version.
"""

from __future__ import annotations

from pathlib import Path

from ..vendor import nexwasneu

#: The texts, inside the package ``app`` (the Docker image copies ``backend/app`` whole).
FOLDER = Path(__file__).resolve().parent.parent / "whatsnew"
LANGUAGES = ("de", "en")


def _running() -> str:
    from .. import __version__

    return __version__


def configure() -> None:
    nexwasneu.configure(nexwasneu.AppConfig(app_name="nexlore", version=_running, folder=FOLDER, languages=LANGUAGES))


configure()


def seen_for_new_account() -> str:
    """A new account starts on the running version: nobody is greeted with news on the first day."""
    return nexwasneu.seen_for_new_account()
