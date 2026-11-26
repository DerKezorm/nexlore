"""Entry point: the FastAPI app, routers, background tasks, the built frontend."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, private
from .config import get_settings
from .db import SessionLocal, init_db
from .deps import require_account, require_operator
from .errors import detail
from .middleware import ForwardedSchemeMiddleware, GuardMiddleware, RequestContextMiddleware, unhandled_error
from .routers import about, accounts, attachments, auth, drafts, everyday, graph, health, imports, members, oidc, shares
from .routers import ai as ai_router
from .routers import apitokens as apitokens_router
from .routers import app1 as app1_router
from .routers import app_pairing as app_pairing_router
from .routers import avatars as avatars_router
from .routers import backups as backups_router
from .routers import bases as bases_router
from .routers import canvas as canvas_router
from .routers import cleanup as cleanup_router
from .routers import comments as comments_router
from .routers import connections as connections_router
from .routers import covers as covers_router
from .routers import export as export_router
from .routers import favorites as favorites_router
from .routers import feed as feed_router
from .routers import inbox as inbox_router
from .routers import ink as ink_router
from .routers import linktitle as linktitle_router
from .routers import locales as locales_router
from .routers import logs as logs_router
from .routers import looks as looks_router
from .routers import lore as lore_router
from .routers import mcp as mcp_router
from .routers import news as news_router
from .routers import notify as notify_router
from .routers import oauth as oauth_router
from .routers import passkeys as passkeys_router
from .routers import plugins as plugins_router
from .routers import presence as presence_router
from .routers import proposals as proposals_router
from .routers import recent as recent_router
from .routers import search as search_router
from .routers import server_mail as server_mail_router
from .routers import server_signin as server_signin_router
from .routers import settings as settings_router
from .routers import themes as themes_router
from .routers import totp as totp_router
from .routers import v1 as v1_router
from .routers import vault as vault_router
from .security import HashingBusy, purge_sessions
from .services import (
    backups,
    graphstore,
    ki_store,
    locales,
    logs,
    notify,
    oidc_store,
    post_store,
    settings_service,
    totp,
    updates,
    watcher,
)
from .services.konten_store import KontenStore
from .vendor import nexoidc
from .vendor.nexki import api as ki_api
from .vendor.nexkonten import factor as konten_factor
from .vendor.nexkonten import setup as konten_setup

logger = logging.getLogger("nexlore")

ROUTERS = [
    health, about, locales_router, logs_router, auth, totp_router, passkeys_router, oidc, accounts, members,
    settings_router, server_signin_router, server_mail_router, vault_router,
    attachments, imports, backups_router, shares, graph, everyday, mcp_router, drafts, plugins_router, looks_router,
    ai_router, favorites_router, avatars_router, recent_router, themes_router, search_router, news_router,
    proposals_router, bases_router, canvas_router, ink_router, cleanup_router, inbox_router, feed_router,
    comments_router, presence_router, linktitle_router, oauth_router, notify_router, apitokens_router, v1_router,
    lore_router,
    export_router, covers_router, app_pairing_router, app1_router, connections_router,
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


def _purge_deleted_accounts() -> None:
    from .vendor.nexkonten import manage

    with SessionLocal() as db:
        manage.purge_due(KontenStore(db))


async def _sweep_forever(stop: asyncio.Event) -> None:
    """Enrolments and sign-ins waiting for their second factor run out; what ran out goes from memory, ended
    sessions from the database once an hour (they stayed until someone showed them again), and so do accounts deleted
    30 days ago (the shared account module, ``manage.purge_due``)."""
    rounds = 0
    while not stop.is_set():
        totp.sweep()
        # System mail waiting in the outbox goes out (the shared post module), in a thread: SMTP blocks.
        try:
            await asyncio.to_thread(post_store.run_due)
        except Exception:
            logger.exception("Outbox round failed")
        if rounds % 60 == 0:
            with SessionLocal() as db:
                purge_sessions(db)
            try:
                await asyncio.to_thread(_purge_deleted_accounts)
            except Exception:
                logger.exception("Removing deleted accounts for good failed")
        rounds += 1
        try:
            await asyncio.wait_for(stop.wait(), 60)
        except TimeoutError:
            continue


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    logs.setup()
    # The own languages on the folder of the settings; what a stopped upload left goes (sprachen 1.0.0).
    locales.start()
    # Whether a newer nexlore is out: the shared module on nexlore's settings and bell.
    updates.configure()
    # The shared backup module on this data folder (a test may have moved it since the import); a staged restore is
    # swapped in before anything opens the database.
    backups.configure()
    # What a stopped copy left (hidden parts, empty archives under the module's names) goes first.
    backups.tidy_at_start()
    backups.apply_pending()
    init_db()
    # What the shared AI module needs of an older installation, written once where never stored (K17).
    ki_store.adopt()
    # The single sign-in provider of the settings becomes the entry "oidc" of the list, once (backup first).
    oidc_store.migrate_settings()
    # The TLS context of the sign-in module is read once, in a thread, so that the first sign-in does not wait for it.
    await nexoidc.warm()
    private.tighten_all()
    backups.warn_at_start()
    # A restore that failed at this start: the operators hear it once (the page says it too).
    backups.report_failed_restore()
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
        tasks.append(asyncio.create_task(notify.run_forever(stop)))
        # Whether a newer nexlore is out (the shared module updates): a look every hour, the network at most once a
        # day and never while the daily check is off; the operators hear of a version once.
        tasks.append(asyncio.create_task(updates.run_forever(stop)))
        tasks.append(asyncio.create_task(_sweep_forever(stop)))
        graphstore.worker.start()
    logger.info("nexlore %s started vault=%s", __version__, settings.vault_dir)
    with SessionLocal() as db:
        konten_setup.announce_setup(KontenStore(db))
    # NEXLORE_SECOND_FACTOR_OFF: a warning in the log while the emergency hammer holds.
    konten_factor.announce_switched_off()
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
app.add_middleware(ForwardedSchemeMiddleware)
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


@app.exception_handler(HashingBusy)
async def _hashing_busy(_request: Request, _exc: HashingBusy) -> JSONResponse:
    # Every slot for checking a password stayed taken for 15 s: many sign-ins at once, as in a flood of guesses.
    return JSONResponse(status_code=503, headers={"Retry-After": "5"},
                        content={"detail": detail("busy", "The server is busy. Try again in a moment.")})


@app.exception_handler(UnicodeEncodeError)
async def _not_unicode(_request: Request, _exc: UnicodeEncodeError) -> JSONResponse:
    # JSON may carry a lone surrogate ("\ud800"); no file name, path or database text can hold it.
    return JSONResponse(status_code=422, content={"detail": detail("invalid_input", "The input is not valid.")})


@app.exception_handler(StarletteHTTPException)
async def _plain_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    # FastAPI's own 400 for a body that is not JSON carries only a text; give it a code like every other answer.
    if exc.status_code == 400 and isinstance(exc.detail, str):
        return JSONResponse(status_code=400, content={"detail": detail("invalid_input", "The input is not valid.")})
    return await http_exception_handler(request, exc)


app.add_exception_handler(Exception, unhandled_error)

for module in ROUTERS:
    app.include_router(module.router)
# The shared MCP module (mcp 1.1.0): ``POST /api/mcp``, OAuth for programs, the pages under ``/api/connections/mcp``.
app.include_router(mcp_router.module_router)
# The shared AI module (ki 0.1.0): Server › KI-Anbieter (``/api/server/ai``) and Mein Konto › KI (``/api/me/ai``).
app.include_router(ki_api.router(config=ki_store.CONFIG, store=ki_store.store, account=require_account,
                                 operator=require_operator))

# The shared sign-in module learns who it runs in before the first request (vendor/nexoidc).
oidc_store.configure()


#: The PDF frame (``frontend/pdfview.html``): a sandbox without an origin of its own, scripts only from nexlore itself
#: (and its worker from a blob), WebAssembly for pdf.js's image decoders, and no network at all. The page hands it
#: the PDF; a PDF can carry code (fonts, forms), and whatever pdf.js does with it stays in here.
PDF_FRAME_POLICY = (
    "sandbox allow-scripts; default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src blob:; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'none'; "
    "frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
)


class _AppFiles(StaticFiles):
    """The app's scripts and styles. They name their content and hold nothing private, so a frame without an origin
    (the PDF frame) may load them: module scripts are always fetched with CORS, and its origin is "null"."""

    def file_response(self, *args: Any, **kwargs: Any) -> Any:
        response = super().file_response(*args, **kwargs)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response


#: Files of frontend/public without a hash in their name that change with an update: the mark, the icons, the
#: manifest and the theme script. They are asked for again before use (no-cache), like the service worker. Without
#: that, Chrome installed a sister app's web app with the old icon from its own cache after a new mark, even after
#: uninstalling it. test_basics.py checks that every file of public/ is covered.
ALWAYS_ASK = frozenset({"logo.svg", "manifest.webmanifest", "theme.js"})
ALWAYS_ASK_FOLDERS = ("icons/",)


def _asked_again(path: str) -> bool:
    return path in ALWAYS_ASK or path.startswith(ALWAYS_ASK_FOLDERS)


def _mount_frontend(target: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    if not index.exists():
        return
    if (dist / "assets").is_dir():
        target.mount("/assets", _AppFiles(directory=dist / "assets"), name="assets")
    root = dist.resolve()
    start_page = index.resolve()
    pdf_frame = (dist / "pdfview.html").resolve()

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
                return FileResponse(candidate, media_type="application/manifest+json",
                                    headers={"Cache-Control": "no-cache"})
            if candidate == pdf_frame:
                return FileResponse(candidate, media_type="text/html", headers={
                    "Content-Security-Policy": PDF_FRAME_POLICY, "X-Frame-Options": "SAMEORIGIN",
                    "Cache-Control": "no-cache",
                })
            if _asked_again(path):
                return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


_mount_frontend(app, get_settings().frontend_dist)
