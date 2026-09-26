"""Settings from the environment, prefix ``NEXLORE_``.

What the operator changes at runtime (log level and, later, sign-in rules and backups) lives in the database, see
``services/settings_service.py``. Only what must be known before the first start is here.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NEXLORE_",
        env_file=(PROJECT_DIR / ".env", BACKEND_DIR / ".env"),
        extra="ignore",
    )

    #: Database, logs, backups and the operator's own language files.
    data_dir: Path = PROJECT_DIR / "data"
    #: The notes themselves, as Markdown files. Empty: ``<data_dir>/vault``. Can live elsewhere, for example on a
    #: folder that Obsidian or Syncthing also works on.
    vault_dir: Path | None = None
    #: Extra languages as JSON files, one per language (``es.json``). Empty: ``<data_dir>/locales``.
    locales_dir: Path | None = None
    disable_background: bool = False
    frontend_dist: Path = PROJECT_DIR / "frontend" / "dist"
    #: Overrides the stored log level; the emergency exit when the app does not even start.
    log_level: str = ""
    #: Serves /api/docs and /api/openapi.json. Off by default.
    api_docs: bool = False
    #: ⚠️ Until accounts exist (M4): lets anybody who reaches the app read and change the notes, as the account
    #: "local". For a test server on the own network with invented notes only. Off by default; then every note
    #: route answers 401.
    unsafe_open_access: bool = False
    #: The watcher misses changes on some network shares and container mounts; polling always sees them.
    watch_polling: bool = False
    #: Seconds between two full scans of the vault, the safety net under the watcher. 0 turns it off.
    scan_interval: int = 300

    @field_validator("data_dir", "frontend_dist", "vault_dir", "locales_dir")
    @classmethod
    def _relative_to_project(cls, value: Path | None) -> Path | None:
        # A relative path means the project, not whatever directory the process was started from.
        if value is None or value == Path(""):
            return None
        return value if value.is_absolute() else PROJECT_DIR / value

    @model_validator(mode="after")
    def _defaults_inside_data(self) -> Settings:
        if self.vault_dir is None:
            self.vault_dir = self.data_dir / "vault"
        if self.locales_dir is None:
            self.locales_dir = self.data_dir / "locales"
        return self

    @property
    def database_path(self) -> Path:
        return self.data_dir / "nexlore.db"


@lru_cache
def get_settings() -> Settings:
    return Settings()
