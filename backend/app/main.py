"""Entry point: the FastAPI app, routers, background tasks, the built frontend."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import get_settings
from .db import SessionLocal, init_db
from .errors import detail
from .middleware import GuardMiddleware, RequestContextMiddleware, unhandled_error
from .routers import about, attachments, auth, drafts, everyday, graph, health, imports, members, oidc, shares
from .routers import ai as ai_router
from .routers import avatars as avatars_router
from .routers import backups as backups_router
from .routers import favorites as favorites_router
from .routers import locales as locales_router
from .routers import logs as logs_router
from .routers import looks as looks_router
from .routers import mcp as mcp_router
from .routers import plugins as plugins_router
from .routers import recent as recent_router
from .routers import settings as settings_router
from .routers import themes as themes_router
from .routers import totp as totp_router
from .routers import vault as vault_router
from .services import backups, graphstore, locales, logs, settings_service, totp, watcher

logger = logging.getLogger("nexlore")

ROUTERS = [
    health, about, locales_router, logs_router, auth, totp_router, oidc, members, settings_router, vault_router,
    attachments, imports, backups_router, shares, graph, everyday, mcp_router, drafts, plugins_router, looks_router,
    ai_router, favorites_router, avatars_router, recent_router, themes_router,
]


def _read_log_mode() -> tuple[str, datetime | None]:
    with SessionLocal() as db:
        mode = settings_service.get(db, "log_mode")
        raw = settings_service.get(db, "log_mode_until")
    until = datetime.fromisoformat(raw).astimezone(UTC) if raw else None
    return str(mode or logs.DEFAULT_MODE), until


def _write_log_mode(mode: str, until: datetime | None) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"log_mode": mode, "log_mode_until": until.isoformat() if until else None})


async def _sweep_forever(stop: asyncio.Event) -> None:
    """Enrolments and sign-ins waiting for their second factor run out; what ran out goes from memory."""
    while not stop.is_set():
        totp.sweep()
        try:
            await asyncio.wait_for(stop.wait(), 60)
        except TimeoutError:
            continue


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    logs.setup()
    backups.apply_pending()
    init_db()
    logs.attach_store(_read_log_mode, _write_log_mode)
    logs.apply_stored_mode()
    settings = get_settings()
    for directory in (settings.vault_dir, settings.locales_dir):
        if directory is not None:
            directory.mkdir(parents=True, exist_ok=True)
    added = locales.available()
    if added:
        logger.info("Languages added by the operator: %s", ", ".join(locale.code for locale in added))
    stop = asyncio.Event()
    tasks: list[asyncio.Task[None]] = []
    settings.resolved_secret_key()
    if not settings.disable_background:
        tasks.append(asyncio.create_task(logs.run_forever(stop)))
        tasks.append(asyncio.create_task(watcher.scan_forever(stop)))
        tasks.append(asyncio.create_task(watcher.watch(stop)))
        tasks.append(asyncio.create_task(backups.run_forever(stop)))
        tasks.append(asyncio.create_task(_sweep_forever(stop)))
        graphstore.worker.start()
    logger.info("nexlore %s started vault=%s", __version__, settings.vault_dir)
    try:
        yield
    finally:
        stop.set()
        graphstore.worker.stop()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("nexlore stopped")


app = FastAPI(
    title="nexlore",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs" if get_settings().api_docs else None,
    openapi_url="/api/openapi.json" if get_settings().api_docs else None,
    redoc_url=None,
)
# Added last, runs first: the request id and headers wrap everything, the guard sits inside it.
app.add_middleware(GuardMiddleware)
app.add_middleware(RequestContextMiddleware)


@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    fields = [".".join(str(part) for part in error.get("loc", ()) if part != "body") for error in exc.errors()]
    return JSONResponse(
        status_code=422, content={"detail": detail("invalid_input", "The input is not valid.", fields=fields)}
    )


@app.exception_handler(OverflowError)
async def _too_large_a_number(_request: Request, _exc: OverflowError) -> JSONResponse:
    # A number past what SQLite holds (an id like 99999999999999999999 in the address): not a fault of the server.
    return JSONResponse(status_code=422, content={"detail": detail("invalid_input", "The input is not valid.")})


app.add_exception_handler(Exception, unhandled_error)

for module in ROUTERS:
    app.include_router(module.router)


def _mount_frontend(target: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    if not index.exists():
        return
    if (dist / "assets").is_dir():
        target.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    root = dist.resolve()
    start_page = index.resolve()

    @target.get("/{path:path}", include_in_schema=False, response_model=None)
    def spa(path: str) -> FileResponse | JSONResponse:
        if path == "api" or path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": detail("not_found", "Not found.")})
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and root in candidate.parents and candidate != start_page:
            if path == "sw.js":
                # The service worker: always the newest, and allowed to act for the whole app.
                return FileResponse(candidate, media_type="text/javascript", headers={"Cache-Control": "no-cache"})
            if path.endswith(".webmanifest"):
                return FileResponse(candidate, media_type="application/manifest+json")
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


_mount_frontend(app, get_settings().frontend_dist)
