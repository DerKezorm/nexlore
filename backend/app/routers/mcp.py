"""MCP over HTTP (``POST /api/mcp``), the keys of an account, and the tools an AI may call.

The protocol is JSON-RPC 2.0 as MCP's "Streamable HTTP" transport has it, without streams: every request gets its
answer as ``application/json``, a notification gets 202. No session is kept; each request names its key.

Walls, in this order: a request that carries an ``Origin`` is refused (browsers send one, MCP clients do not; so no
web page can talk to this with a key it guessed or stole, and DNS rebinding goes nowhere); MCP must be on; the key
must be valid; the key must stay under its rate. The session cookie counts for nothing here.

Every tool reuses the routes of the interface, with the key's account: the same rights, the same "not found" for a
space the account may not read, the same size limits.
"""

from __future__ import annotations

import json
import logging
import posixpath
import secrets
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import __version__
from ..db import SessionLocal
from ..deps import Account, DbSession, need
from ..errors import error
from ..models import WRITE, File, McpKey, Space, Version
from ..services import everyday, inbox, index, logs, mcp, paths, rights, textblocks, vault
from ..services.mcp import Caller, McpError
from ..services.vault import Actor, VaultError
from . import everyday as everyday_routes
from . import search as search_routes
from . import vault as vault_routes

logger = logging.getLogger("nexlore.mcp")

router = APIRouter(tags=["mcp"])

#: Protocol versions this server speaks, newest first.
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
INSTRUCTIONS = (
    "nexlore holds Markdown notes in spaces (the first part of every path). Paths are relative to the vault, "
    "like 'Space/Folder/Note.md'. Read a note before changing it and pass its hash as base_hash: if the note changed "
    "since, your text goes into a conflict copy, nothing is overwritten. Wiki links like [[Note]] stay inside their "
    "space; [[Space/Note]] leads into another one."
)

# --- The tools --------------------------------------------------------------------------------------------------------

_PATH = {"type": "string", "description": "A vault path, like 'Space/Folder/Note.md'."}
_BASE = {"type": "string", "description": "The hash read_note gave for the text your change starts from."}

TOOLS: list[dict[str, Any]] = [
    {"name": "list_spaces", "level": "read", "description": "The spaces you may read, with your right in each.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "search", "level": "read",
     "description": "Full text search over notes and PDFs. Every word must occur; words match as prefixes. "
                    "The words found are marked «like this» in the snippet.",
     "inputSchema": {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string"}, "space": {"type": "string"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 50}}}},
    {"name": "search_notes", "level": "read",
     "description": "Search like the search page of nexlore, with operators: words, \"a phrase\", -left_out, "
                    "tag:#x, path:Folder, file:name, task:words, task-todo:, task-done:, line:(a b), section:(a b), "
                    "[property:value]. Gives each note with the lines that fit.",
     "inputSchema": {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}}},
    {"name": "find_notes", "level": "read", "description": "Notes whose title or file name contains the words.",
     "inputSchema": {"type": "object", "required": ["title"], "properties": {
         "title": {"type": "string"}, "space": {"type": "string"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 50}}}},
    {"name": "read_note", "level": "read", "description": "The text of a note, its tags and its hash.",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": _PATH}}},
    {"name": "list_folder", "level": "read", "description": "Folders and files directly in a space or folder.",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": _PATH}}},
    {"name": "note_links", "level": "read", "description": "Where the links of a note lead, and what links to it.",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {"path": _PATH}}},
    {"name": "list_tasks", "level": "read", "description": "Tasks (Obsidian Tasks format) across readable spaces.",
     "inputSchema": {"type": "object", "properties": {
         "status": {"enum": ["open", "done", "all"]}, "when": {"enum": ["overdue", "today", "week", "later", "none"]},
         "space": {"type": "string"}, "tag": {"type": "string"}, "query": {"type": "string"}}}},
    {"name": "propose_change", "level": "draft",
     "description": "Propose a new text for a note. Nothing changes until its owner takes the draft over in nexlore.",
     "inputSchema": {"type": "object", "required": ["path", "content", "base_hash"], "properties": {
         "path": _PATH, "content": {"type": "string"}, "base_hash": _BASE,
         "reason": {"type": "string", "description": "One line: what the draft changes."}}}},
    {"name": "propose_note", "level": "draft", "description": "Propose a new note; it is made when taken over.",
     "inputSchema": {"type": "object", "required": ["folder", "title", "content"], "properties": {
         "folder": _PATH, "title": {"type": "string"}, "content": {"type": "string"}, "reason": {"type": "string"}}}},
    {"name": "write_note", "level": "write",
     "description": "Replace the text of a note. Lines you did not change stay exactly as they were.",
     "inputSchema": {"type": "object", "required": ["path", "content", "base_hash"], "properties": {
         "path": _PATH, "content": {"type": "string"}, "base_hash": _BASE}}},
    {"name": "edit_note", "level": "write",
     "description": "Replace pieces of a note's text. Each 'old' must occur exactly once in the text you read.",
     "inputSchema": {"type": "object", "required": ["path", "base_hash", "edits"], "properties": {
         "path": _PATH, "base_hash": _BASE,
         "edits": {"type": "array", "maxItems": 100, "items": {"type": "object", "required": ["old", "new"],
                   "properties": {"old": {"type": "string"}, "new": {"type": "string"}}}}}}},
    {"name": "complete_task", "level": "write",
     "description": "Tick a task off (or open it again with done=false). Give path, line and raw as list_tasks gave "
                    "them; when the note changed since, the task is found by its text, and nothing is written when it "
                    "is not there exactly once.",
     "inputSchema": {"type": "object", "required": ["path", "line", "raw"], "properties": {
         "path": _PATH, "line": {"type": "integer", "minimum": 1}, "raw": {"type": "string"},
         "done": {"type": "boolean"}}}},
    {"name": "append_to_daily", "level": "write",
     "description": "Add text at the end of the daily note of a space (today's, or of 'date' as YYYY-MM-DD), made "
                    "from the space's template when it is not there yet.",
     "inputSchema": {"type": "object", "required": ["space", "text"], "properties": {
         "space": {"type": "string"}, "text": {"type": "string"},
         "date": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}}}},
    {"name": "create_note", "level": "write", "description": "Make a new note in a space or folder.",
     "inputSchema": {"type": "object", "required": ["folder", "title", "content"], "properties": {
         "folder": _PATH, "title": {"type": "string"}, "content": {"type": "string"}}}},
]
BY_NAME = {tool["name"]: tool for tool in TOOLS}
MAX_TEXT = index.MAX_NOTE_BYTES


class ToolError(Exception):
    pass


def _text(args: dict[str, Any], name: str, *, required: bool = True, limit: int = paths.MAX_PATH_CHARS) -> str:
    value = args.get(name)
    if value is None and not required:
        return ""
    if isinstance(value, str) and required and not value.strip() and name != "content":
        raise ToolError(f"'{name}' must not be empty.")
    if not isinstance(value, str) or len(value) > limit:
        raise ToolError(f"'{name}' must be a text of at most {limit} characters.")
    return value


def _limit(args: dict[str, Any]) -> int:
    value = args.get("limit", 20)
    return value if isinstance(value, int) and 1 <= value <= 50 else 20


def _base(db: Any, file: File, current: bytes, base_hash: str) -> bytes:
    """The text the AI read, from the file or, when it changed since, from the note's versions."""
    if index.digest(current) == base_hash:
        return current
    content = db.scalar(select(Version.content).where(Version.file_id == file.id, Version.hash == base_hash).limit(1))
    if content is None:
        raise ToolError("The note is not at that hash any more, nor in its history. Read it again.")
    import zlib

    return zlib.decompress(content)


def _read_for_change(caller: Caller, path: str, base_hash: str) -> tuple[str, File, bytes]:
    clean = need(caller.account, path, WRITE)
    try:
        file, current = vault.read(clean)
    except VaultError as exc:
        raise ToolError("Not found.") from exc
    if not file.is_note:
        raise ToolError("This file is not a note.")
    try:
        current.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ToolError("The note is not valid UTF-8; it is shown, never written from text.") from exc
    with SessionLocal() as db:
        base = _base(db, file, current, base_hash)
    return clean, file, base


def _save(caller: Caller, client: str, clean: str, data: bytes, base_hash: str) -> dict[str, Any]:
    saved = vault.save(clean, data, base_hash=base_hash, actor=Actor(name=caller.account.name, client=client),
                       source=index.MCP)
    return {"saved": saved.conflict is None, "path": clean, "conflict": saved.conflict, "hash": saved.file.hash}


def _call(caller: Caller, client: str, name: str, args: dict[str, Any]) -> Any:
    account = caller.account
    who = Actor(name=account.name, client=client)
    if name == "list_spaces":
        return [{"name": s.name, "role": s.role, "notes": s.notes} for s in vault_routes.spaces(account)]
    if name == "search":
        hits = vault_routes.search(account, _text(args, "query", limit=200),
                                   _text(args, "space", required=False, limit=255) or None, _limit(args))
        # Not "**": the note may be bold right there, and "****" reads as nothing.
        clean = str.maketrans({vault_routes.HIT_START: "«", vault_routes.HIT_END: "»"})
        return [{"path": h.path, "title": h.title, "snippet": h.snippet.translate(clean)} for h in hits]
    if name == "find_notes":
        found = vault_routes.find_notes(account, _text(args, "title", limit=200),
                                        _text(args, "space", required=False, limit=255) or None, None, _limit(args))
        return [{"path": f.path, "title": f.title} for f in found]
    if name == "read_note":
        note = vault_routes.note(_text(args, "path"), account, who)
        return {"path": note.path, "title": note.title, "content": note.content, "hash": note.hash,
                "tags": note.tags, "readonly": note.readonly}
    if name == "list_folder":
        listing = vault_routes.folder(_text(args, "path"), account, 0, 500)
        return {"folders": [{"path": f.path, "notes": f.notes} for f in listing.folders],
                "files": [{"path": f.path, "title": f.title, "is_note": f.is_note} for f in listing.files],
                "total_files": listing.total_files}
    if name == "note_links":
        links = vault_routes.links(_text(args, "path"), account)
        return {"outgoing": [{"target": o.target, "path": o.path} for o in links.outgoing],
                "backlinks": [{"path": b.path, "title": b.title} for b in links.backlinks]}
    if name == "list_tasks":
        status = args.get("status", "open")
        when = args.get("when")
        if status not in ("open", "done", "all") or when not in (None, "overdue", "today", "week", "later", "none"):
            raise ToolError("'status' or 'when' is not one of the values listed.")
        found = everyday_routes.task_list(
            account, datetime.now().astimezone().date().isoformat(), status, when, None, None, None,
            _text(args, "space", required=False, limit=255) or None, _text(args, "tag", required=False, limit=255)
            or None, _text(args, "query", required=False, limit=200) or None, 0, 100,
        )
        return [{"path": t["path"], "line": t["line"], "raw": t["raw"], "text": t["text"], "status": t["status"],
                 "due": t["due"]} for t in found["items"]]
    if name == "search_notes":
        page = search_routes.search_notes(account, _text(args, "query", limit=500), _limit(args), 0)
        marks = str.maketrans({vault_routes.HIT_START: "«", vault_routes.HIT_END: "»"})
        notes = [{"path": n.path, "title": n.title,
                  "lines": [{"line": ln.line, "text": ln.text.translate(marks)} for ln in n.lines]} for n in page.notes]
        return {"notes": notes, "more": page.more}
    if name == "complete_task":
        rel = need(account, _text(args, "path"), WRITE)
        line = args.get("line")
        done = args.get("done", True)
        if not isinstance(line, int) or line < 1 or not isinstance(done, bool):
            raise ToolError("'line' must be a whole number from 1, 'done' true or false.")
        today = datetime.now().astimezone().date().isoformat()
        try:
            changed = everyday.toggle(rel, line, _text(args, "raw", limit=100_000), done=done, today=today, actor=who)
        except VaultError as exc:
            raise ToolError("Not found." if exc.status == 404 else exc.text) from exc
        return {"path": changed["path"], "line": changed["line"], "raw": changed["raw"],
                "conflict": changed.get("conflict")}
    if name == "append_to_daily":
        space = need(account, _text(args, "space", limit=255), WRITE)
        if "/" in space:
            raise ToolError("Not found.")
        day = _text(args, "date", required=False, limit=10) or datetime.now().astimezone().date().isoformat()
        words = _text(args, "text", limit=MAX_TEXT)
        try:
            daily = everyday.open_daily(space, day, actor=who, may_write=True, language=account.language or "en")
            path = inbox.append(daily.path, words, actor=who, source=index.MCP)
        except (VaultError, inbox.InboxError) as exc:
            raise ToolError("Not found." if getattr(exc, "status", 0) == 404 else str(exc)) from exc
        return {"path": path, "created": daily.created}
    if name in ("propose_change", "write_note", "edit_note"):
        path = _text(args, "path")
        base_hash = _text(args, "base_hash", limit=64)
        clean, file, base = _read_for_change(caller, path, base_hash)
        if name == "edit_note":
            edits = args.get("edits")
            if not isinstance(edits, list) or not edits or len(edits) > 100:
                raise ToolError("'edits' must list 1 to 100 changes.")
            text = base.decode("utf-8").removeprefix("\ufeff").replace("\r\n", "\n")
            for number, edit in enumerate(edits, 1):
                old = edit.get("old") if isinstance(edit, dict) else None
                new = edit.get("new") if isinstance(edit, dict) else None
                if not isinstance(old, str) or not isinstance(new, str) or not old:
                    raise ToolError(f"Change {number} needs 'old' and 'new' as text.")
                old = old.replace("\r\n", "\n")
                if text.count(old) != 1:
                    raise ToolError(f"Change {number}: 'old' occurs {text.count(old)} times; it must occur once.")
                text = text.replace(old, new.replace("\r\n", "\n"))
            content = text
        else:
            content = _text(args, "content", limit=MAX_TEXT)
        data = textblocks.keep_unchanged(base, content)
        if len(data) > MAX_TEXT:
            raise ToolError("A note holds at most 5 MB.")
        if name == "propose_change":
            with SessionLocal() as db:
                draft = mcp.add_draft(db, caller, space_id=file.space_id, path=clean, file_id=file.id,
                                      base_hash=base_hash, content=data,
                                      reason=_text(args, "reason", required=False, limit=500))
            return {"draft": draft.id, "path": clean, "note": "The owner takes it over or throws it away in nexlore."}
        return _save(caller, client, clean, data, base_hash)
    if name in ("propose_note", "create_note"):
        folder = need(account, _text(args, "folder"), WRITE)
        title = _text(args, "title", limit=255).strip()
        content = _text(args, "content", limit=MAX_TEXT).encode("utf-8")
        if name == "create_note":
            try:
                made = vault.create_note(folder, title, content, actor=who, source=index.MCP)
            except VaultError as exc:
                raise ToolError("Not found." if exc.status == 404 else exc.text) from exc
            return {"path": made.path, "hash": made.hash}
        with SessionLocal() as db:
            space_id = db.scalar(select(Space.id).where(Space.folder == paths.space_of(folder)))
            if space_id is None or not paths.resolve(folder).is_dir():
                raise ToolError("Not found.")
            draft = mcp.add_draft(db, caller, space_id=space_id, path=posixpath.join(folder, title), file_id=None,
                                  base_hash="", content=content,
                                  reason=_text(args, "reason", required=False, limit=500))
        return {"draft": draft.id, "folder": folder, "note": "The note is made when its owner takes the draft over."}
    raise ToolError(f"No tool called {name!r}.")


def _tool_result(value: Any, failed: bool = False) -> dict[str, Any]:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": failed}
    if not failed and isinstance(value, dict):
        result["structuredContent"] = value
    return result


def call_tool(caller: Caller, client: str, name: str, args: Any) -> dict[str, Any]:
    tool = BY_NAME.get(name) if isinstance(name, str) else None
    if tool is None or not mcp.at_least(caller.level, tool["level"]):
        # A tool above the key's level is as unknown as one that does not exist.
        return _tool_result(f"No tool called {name!r}.", failed=True)
    if not isinstance(args, dict):
        return _tool_result("'arguments' must be an object.", failed=True)
    logger.info("MCP tool called tool=%s key_id=%s", name, caller.key_id)
    try:
        return _tool_result(_call(caller, client, name, args))
    except ToolError as exc:
        return _tool_result(str(exc), failed=True)
    except McpError as exc:
        return _tool_result(exc.text, failed=True)
    except HTTPException as exc:
        found = exc.detail if isinstance(exc.detail, dict) else {}
        return _tool_result(str(found.get("message") or "Not found."), failed=True)
    except VaultError as exc:
        return _tool_result("Not found." if exc.status == 404 else exc.text, failed=True)


def _error(message_id: Any, code: int, text: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": text}}


def handle(message: Any, caller: Caller, client: str) -> dict[str, Any] | None:
    """One JSON-RPC message: its answer, or None for a notification."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return _error(message.get("id") if isinstance(message, dict) else None, -32600, "Invalid request.")
    method = message["method"]
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    if "id" not in message:
        return None
    message_id = message["id"]
    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return {"jsonrpc": "2.0", "id": message_id, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "nexlore", "version": __version__},
            "instructions": INSTRUCTIONS,
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": message_id, "result": {}}
    if method == "tools/list":
        tools = [{key: value for key, value in tool.items() if key != "level"}
                 for tool in TOOLS if mcp.at_least(caller.level, tool["level"])]
        return {"jsonrpc": "2.0", "id": message_id, "result": {"tools": tools}}
    if method == "tools/call":
        return {"jsonrpc": "2.0", "id": message_id,
                "result": call_tool(caller, client, params.get("name"), params.get("arguments", {}))}
    return _error(message_id, -32601, "Method not found.")


def _refuse(status: int, code: str, text: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"detail": {"code": code, "message": text}}, status_code=status, headers=headers)


@router.post("/api/mcp", summary="MCP (JSON-RPC over HTTP) with a key in Authorization: Bearer")
async def endpoint(request: Request) -> Response:
    if request.headers.get("origin"):
        return _refuse(403, "origin_refused", "MCP is not for web pages.")
    # After initialize, a client names the version it agreed on; one this server does not speak is refused (the
    # transport's rule). Without the header the client is taken to speak the oldest, which is spoken.
    asked = request.headers.get("mcp-protocol-version")
    if asked is not None and asked not in PROTOCOL_VERSIONS:
        return _refuse(400, "protocol_version", "This MCP protocol version is not spoken here.")
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header[:7].lower() == "bearer " else None
    with SessionLocal() as db:
        if not mcp.allowed(db):
            return _refuse(404, "not_found", "Not found.")
        caller = mcp.authenticate(db, token)
    if caller is None:
        return _refuse(401, "key_invalid", "No valid key.", {"WWW-Authenticate": "Bearer"})
    if not mcp.brake(caller.key_id):
        return _refuse(429, "slow_down", "Too many requests with this key. Wait a minute.", {"Retry-After": "60"})
    logs.set_actor(caller.account.name)
    try:
        message = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError, RecursionError):
        # RecursionError: JSON nested deeper than Python's stack, sent to break the server.
        return JSONResponse(_error(None, -32700, "Parse error."), status_code=400)
    # One tab identity per request: MCP writes never hold a lock, and never pass for an editor's tab.
    client = f"mcp-{caller.key_id}-{secrets.token_hex(4)}"
    answer = await run_in_threadpool(handle, message, caller, client)
    if answer is None:
        return Response(status_code=202)
    return JSONResponse(answer)


@router.get("/api/mcp", include_in_schema=False)
def no_stream() -> Response:
    # No server-sent stream: every answer comes with its request.
    return Response(status_code=405, headers={"Allow": "POST"})


# --- Keys, through the interface --------------------------------------------------------------------------------------


class KeyOut(BaseModel):
    id: int
    name: str
    level: str
    prefix: str
    created_at: Any
    last_used_at: Any = None
    #: The names of the spaces the key may see, of those the account may read now; None: all of them.
    spaces: list[str] | None = None


class KeysOut(BaseModel):
    allowed: bool
    max_level: str
    keys: list[KeyOut]


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    level: str = Field(pattern="^(read|draft|write)$")
    #: Ids of spaces; left out: every space the account may read.
    spaces: list[int] | None = Field(default=None, max_length=1000)


class MadeOut(BaseModel):
    key: KeyOut
    #: Shown once, never again.
    token: str


def _key_out(db: Any, account: Any, row: McpKey) -> KeyOut:
    names = None
    if row.spaces is not None:
        # Only spaces the account may still read: one it lost since tells nothing (and the key does not see it).
        readable = rights.readable_ids(db, account)
        wanted = [space_id for space_id in row.spaces if space_id in readable]
        names = sorted(db.scalars(select(Space.folder).where(Space.id.in_(wanted)))) if wanted else []
    return KeyOut(id=row.id, name=row.name, level=row.level, prefix=row.prefix, created_at=row.created_at,
                  last_used_at=row.last_used_at, spaces=names)


@router.get("/api/mcp/keys", response_model=KeysOut)
def keys(account: Account, db: DbSession) -> KeysOut:
    rows = db.scalars(select(McpKey).where(McpKey.account_id == account.id).order_by(McpKey.id)).all()
    return KeysOut(allowed=mcp.allowed(db), max_level=mcp.max_level(db),
                   keys=[_key_out(db, account, row) for row in rows])


@router.post("/api/mcp/keys", response_model=MadeOut, status_code=201)
def make_key(body: KeyIn, account: Account, db: DbSession) -> MadeOut:
    if not mcp.allowed(db):
        raise error("mcp_off", "The operator has not switched MCP on.", 403)
    try:
        row, token = mcp.make_key(db, account, body.name, body.level, body.spaces)
    except McpError as exc:
        raise error(exc.code, exc.text, exc.status) from exc
    return MadeOut(key=_key_out(db, account, row), token=token)


@router.delete("/api/mcp/keys/{key_id}", status_code=204)
def revoke_key(key_id: Annotated[int, Path(ge=1)], account: Account, db: DbSession) -> None:
    row = db.get(McpKey, key_id)
    if row is None or row.account_id != account.id:
        raise error("not_found", "Not found.", 404)
    db.delete(row)
    db.commit()
    logger.info("MCP key revoked key_id=%s", key_id)



