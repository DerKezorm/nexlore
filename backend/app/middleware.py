"""Request id, timing and security headers for every request."""

from __future__ import annotations

import json
import logging
import re
import secrets
import sqlite3
import time
from collections.abc import Callable
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from .services import logs

logger = logging.getLogger("nexlore.api")


def _database_busy(exc: BaseException) -> bool:
    """SQLite's "database is locked" (or "busy"), however deep in the chain of causes."""
    seen: BaseException | None = exc
    while seen is not None:
        if isinstance(seen, sqlite3.OperationalError) and ("locked" in str(seen) or "busy" in str(seen)):
            return True
        # SQLAlchemy keeps the driver's error as ``orig`` (and as the cause, when it raised it itself).
        seen = getattr(seen, "orig", None) or seen.__cause__ or seen.__context__
    return False


#: Paths whose calls explain nothing but fill the log.
QUIET_PATHS = ("/api/health", "/api/logs")
SLOW_MS = 3000
#: What takes long by nature: backups grow with the vault.
SLOW_EXPECTED = ("/api/backups",)

#: The editor and the graph set inline styles, hence 'unsafe-inline' for styles only. Scripts stay strict.
#: ``blob:`` for images: a pasted picture is shown before it is uploaded.
CSP = (
    b"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
    b"connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
)
SECURITY_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"content-security-policy", CSP),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
    (b"x-frame-options", b"DENY"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
)


class RequestContextMiddleware:
    """Pure ASGI, so streaming responses and WebSockets are not buffered."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        request_id = secrets.token_hex(3)
        scope.setdefault("state", {})["request_id"] = request_id
        token = logs.bind_request(request_id)
        start = time.perf_counter()
        status = 0
        path = scope.get("path", "?")

        async def send_wrapper(message: dict) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("ascii")))
                headers.extend(SECURITY_HEADERS)
            await send(message)

        method = scope.get("method", "WS")
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            duration = (time.perf_counter() - start) * 1000
            logger.exception("Unhandled error on %s %s after %dms", method, path, duration)
            raise
        else:
            if scope["type"] != "http":
                return
            duration = (time.perf_counter() - start) * 1000
            if status >= 500:
                logger.error("%s %s -> %s in %dms", method, path, status, duration)
            elif duration >= SLOW_MS and not path.startswith(QUIET_PATHS + SLOW_EXPECTED):
                logger.warning("Slow request: %s %s -> %s in %dms", method, path, status, duration)
            elif not path.startswith(QUIET_PATHS):
                logger.debug("%s %s -> %s in %dms", method, path, status, duration)
        finally:
            logs.unbind_request(token)


#: Methods that change something. They must name their browser tab (see ``GuardMiddleware``).
CHANGING = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CLIENT_HEADER = b"x-nexlore-client"
CLIENT_PATTERN = re.compile(rb"^[A-Za-z0-9_-]{8,64}$")
#: Largest body an ordinary request may carry: a note is at most 5 MB of text, JSON adds a little.
MAX_BODY = 16 * 1024 * 1024
#: Where a larger body is expected, with its own limit checked while streaming. An upload's limit is the operator's
#: setting, checked by the route while the file arrives; this is only the ceiling above every setting.
LARGE_BODIES = {"/api/import": 4 * 1024**3, "/api/attachments": 1024**4}


class BodyTooLarge(Exception):
    pass


def _refuse(status: int, code: str, text: str) -> tuple[dict, dict]:
    body = json.dumps({"detail": {"code": code, "message": text}}).encode()
    start = {
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    }
    return start, {"type": "http.response.body", "body": body}


class GuardMiddleware:
    """Two walls in front of every route, including routes still to come.

    * **A change must name its tab** in ``X-Nexlore-Client``. Locks belong to a tab; without the header two callers
      would share one identity and could release each other's lock. And a page on another site can make a browser
      send a form, but not a request with a header of its own (that needs CORS, which nexlore does not allow): so
      the header is the wall against cross-site requests too, the more so while the open test access stands in for
      accounts.
    * **A body has a size limit** before anything reads it: the declared length is checked first, and a body sent
      without one is counted while it arrives.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        if scope.get("method") in CHANGING and not CLIENT_PATTERN.match(headers.get(CLIENT_HEADER, b"")):
            for message in _refuse(400, "client_required", "Changes need the header X-Nexlore-Client."):
                await send(message)
            return
        limit = LARGE_BODIES.get(scope["path"], MAX_BODY)
        declared = headers.get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            for message in _refuse(413, "too_large", "The request is too large."):
                await send(message)
            return
        received = 0
        overflow = False

        async def counting_receive() -> dict:
            nonlocal received, overflow
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    overflow = True
                    raise BodyTooLarge
            return message

        started = False

        async def tracking_send(message: dict) -> None:
            nonlocal started
            # The framework turns the aborted read into an answer of its own (400); the caller gets the true one.
            if overflow:
                if message["type"] == "http.response.start" and not started:
                    started = True
                    for refusal in _refuse(413, "too_large", "The request is too large."):
                        await send(refusal)
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except BodyTooLarge:
            if not started:
                for message in _refuse(413, "too_large", "The request is too large."):
                    await send(message)


async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or "-"
    if _database_busy(exc):
        # The database stayed busy past the wait (SQLite's busy timeout): a moment later it works. The browser gets
        # something to say and to retry instead of "went wrong".
        return JSONResponse(
            status_code=503,
            content={"detail": {"code": "busy", "message": "nexlore is busy. Try again in a moment.",
                                "request_id": request_id}},
            headers={"X-Request-Id": request_id, "Retry-After": "2"},
        )
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "code": "internal_error",
                "message": f"Something went wrong on the server. Request id: {request_id}",
                "request_id": request_id,
            }
        },
        headers={"X-Request-Id": request_id},
    )
