"""The tools of block Y: everything the interface can do with notes, folders and spaces, over MCP.

Each tool calls the route the interface calls, with the key's account: the same rights, the same limits, the same
"Not found." for what the account may not read. Two rules on top:

* **No operator powers over MCP.** In the interface an operator may list and set members of every space. A key never
  does: members and public pages need the right to manage the space itself, checked with the key's spaces.
* **What the interface cannot do, no tool does.**

Every tool has a group (``read``, ``change``, ``risky``) that gives its default right (``services/mcp.py``).
"""

from __future__ import annotations

import base64
import binascii
import os
import posixpath
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from fastapi import Request
from sqlalchemy import select

from ..db import SessionLocal
from ..deps import need
from ..models import MANAGE, READ, WRITE, McpKey, Space
from ..services import attachments, looks, paths
from ..services.mcp import Caller
from ..services.vault import Actor
from . import attachments as attachments_routes
from . import bases as bases_routes
from . import cleanup as cleanup_routes
from . import comments as comments_routes
from . import everyday as everyday_routes
from . import favorites as favorites_routes
from . import inbox as inbox_routes
from . import looks as looks_routes
from . import members as members_routes
from . import shares as shares_routes
from . import vault as vault_routes

#: Attachments over MCP, decoded: the JSON body of a request holds at most 16 MB, base64 adds a third.
MAX_UPLOAD = 10 * 1024 * 1024


class ToolError(Exception):
    pass


@dataclass
class Context:
    caller: Caller
    who: Actor
    #: The request the call came with (the MCP call, or the approval in nexlore): public pages need its address.
    request: Request | None


_PATH = {
    "type": "string",
    "maxLength": paths.MAX_PATH_CHARS,
    "description": "A vault path, like 'Space/Folder/Note.md'.",
}
_SPACE = {"type": "string", "maxLength": 255, "description": "The name of a space."}


def _schema(required: list[str], **properties: Any) -> dict[str, Any]:
    return {"type": "object", "required": required, "properties": properties, "additionalProperties": False}


def _is_folder(path: str) -> bool:
    try:
        return paths.resolve(path).is_dir()
    except (paths.PathError, OSError):
        return False


def _now_local() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# --- Reading ----------------------------------------------------------------------------------------------------------


def space_options(ctx: Context, args: dict[str, Any]) -> Any:
    return everyday_routes.get_options(args["space"], ctx.caller.account)


def list_templates(ctx: Context, args: dict[str, Any]) -> Any:
    return everyday_routes.template_list(args["space"], ctx.caller.account)


def list_versions(ctx: Context, args: dict[str, Any]) -> Any:
    rows = vault_routes.versions(args["path"], ctx.caller.account)
    return [
        {
            "version": row.id,
            "at": row.updated_at.isoformat(),
            "source": row.source,
            "author": row.author,
            "size": row.size,
        }
        for row in rows
    ]


def read_version(ctx: Context, args: dict[str, Any]) -> Any:
    found = vault_routes.version(args["version"], ctx.caller.account)
    return {"version": found["id"], "path": found["path"], "content": found["content"]}


def list_tags(ctx: Context, args: dict[str, Any]) -> Any:
    return vault_routes.tags(ctx.caller.account, args.get("space"))


def read_comments(ctx: Context, args: dict[str, Any]) -> Any:
    return comments_routes.listing(args["path"], ctx.caller.account)


def list_attachments(ctx: Context, args: dict[str, Any]) -> Any:
    page = attachments_routes.listing(ctx.caller.account, args["space"], bool(args.get("unused", False)), 200, 0)
    return page.model_dump(mode="json")


def unlinked_mentions(ctx: Context, args: dict[str, Any]) -> Any:
    return cleanup_routes.unlinked(args["path"], ctx.caller.account)


def cleanup_report(ctx: Context, args: dict[str, Any]) -> Any:
    return cleanup_routes.cleanup(args["space"], ctx.caller.account)


def list_trash(ctx: Context, args: dict[str, Any]) -> Any:
    return [
        {"entry": row.id, "path": row.path, "files": row.files, "deleted_at": row.deleted_at.isoformat(), "by": row.by}
        for row in vault_routes.trash(ctx.caller.account)
    ]


def list_members(ctx: Context, args: dict[str, Any]) -> Any:
    space = need(ctx.caller.account, args["space"], READ)
    if "/" in space:
        raise ToolError("Not found.")
    with SessionLocal() as db:
        space_id = db.scalar(select(Space.id).where(Space.folder == space))
        if space_id is None:
            raise ToolError("Not found.")
        rows = members_routes._members(db, space_id)
        return [{"name": person.name, "role": membership.role} for membership, person in rows]


def list_shares(ctx: Context, args: dict[str, Any]) -> Any:
    space = need(ctx.caller.account, args["space"], MANAGE)
    with SessionLocal() as db:
        if ctx.request is None:
            raise ToolError("Public pages need the address of this server.")
        found = shares_routes.listing(ctx.request, ctx.caller.account, db, space)
        return [row.model_dump(mode="json") for row in found]


# --- Making and changing ----------------------------------------------------------------------------------------------


def create_space(ctx: Context, args: dict[str, Any]) -> Any:
    made = vault_routes.create_space(vault_routes.NameIn(name=args["name"]), ctx.caller.account)
    with SessionLocal() as db:
        key = db.get(McpKey, ctx.caller.key_id)
        # A key limited to some spaces gets the one it made: otherwise it could not even see it.
        if key is not None and key.spaces is not None:
            key.spaces = sorted({*key.spaces, made.id})
            db.commit()
    if ctx.caller.account.key_spaces is not None:
        ctx.caller.account.key_spaces = frozenset({*ctx.caller.account.key_spaces, made.id})
    if args.get("icon") or args.get("color"):
        looks_routes.set_look(
            looks_routes.LookIn(path=made.name, icon=args.get("icon"), color=args.get("color")), ctx.caller.account
        )
    return {"space": made.name, "role": made.role}


def rename_space(ctx: Context, args: dict[str, Any]) -> Any:
    renamed = vault_routes.rename_space(args["space"], vault_routes.NameIn(name=args["name"]), ctx.caller.account,
                                        ctx.who)
    return {"space": renamed["path"], "links_rewritten": renamed["rewritten"]}


def set_space_options(ctx: Context, args: dict[str, Any]) -> Any:
    space = args.pop("space")
    return everyday_routes.put_options(space, everyday_routes.OptionsIn(**args), ctx.caller.account)


def create_folder(ctx: Context, args: dict[str, Any]) -> Any:
    return vault_routes.create_folder(
        vault_routes.FolderIn(parent=args["parent"], name=args["name"]), ctx.caller.account
    )


def _move(ctx: Context, source: str, destination: str) -> Any:
    moved = vault_routes.move(vault_routes.MoveIn(source=source, destination=destination), ctx.caller.account, ctx.who)
    return {"path": moved["path"], "links_rewritten": moved.get("rewritten", 0)}


def _kind(path: str, folder: bool) -> None:
    if _is_folder(path) != folder:
        raise ToolError("This is a note, not a folder." if folder else "This is a folder, not a note.")


def rename_folder(ctx: Context, args: dict[str, Any]) -> Any:
    source = need(ctx.caller.account, args["path"], WRITE)
    if "/" not in source:
        raise ToolError("A space cannot be renamed.")
    _kind(source, True)
    return _move(ctx, source, posixpath.join(posixpath.dirname(source), args["name"]))


def move_folder(ctx: Context, args: dict[str, Any]) -> Any:
    source = need(ctx.caller.account, args["path"], WRITE)
    if "/" not in source:
        raise ToolError("A space cannot be moved.")
    _kind(source, True)
    return _move(ctx, source, posixpath.join(args["into"], posixpath.basename(source)))


def rename_note(ctx: Context, args: dict[str, Any]) -> Any:
    source = need(ctx.caller.account, args["path"], WRITE)
    _kind(source, False)
    name = args["title"].strip()
    if not name.lower().endswith(".md"):
        name += ".md"
    return _move(ctx, source, posixpath.join(posixpath.dirname(source), name))


def move_note(ctx: Context, args: dict[str, Any]) -> Any:
    source = need(ctx.caller.account, args["path"], WRITE)
    _kind(source, False)
    return _move(ctx, source, posixpath.join(args["into"], posixpath.basename(source)))


def create_from_template(ctx: Context, args: dict[str, Any]) -> Any:
    made = vault_routes.create_note(
        vault_routes.CreateIn(folder=args["folder"], title=args["title"], template=args["template"], now=_now_local()),
        ctx.caller.account,
        ctx.who,
    )
    return {"path": made.path, "hash": made.hash}


def set_property(ctx: Context, args: dict[str, Any]) -> Any:
    return bases_routes.change_cell(
        bases_routes.CellIn(path=args["path"], key=args["key"], value=args.get("value")), ctx.caller.account, ctx.who
    )


def merge_notes(ctx: Context, args: dict[str, Any]) -> Any:
    return vault_routes.merge(
        vault_routes.MergeIn(source=args["source"], target=args["target"]), ctx.caller.account, ctx.who
    )


def restore_version(ctx: Context, args: dict[str, Any]) -> Any:
    return vault_routes.restore_version(args["version"], ctx.caller.account, ctx.who)


def restore_from_trash(ctx: Context, args: dict[str, Any]) -> Any:
    return vault_routes.restore_trash(args["entry"], ctx.caller.account, ctx.who)


def rename_tag(ctx: Context, args: dict[str, Any]) -> Any:
    renamed = vault_routes.tag_rename(
        vault_routes.TagRenameIn(old=args["old"], new=args["new"]), ctx.caller.account, ctx.who
    )
    return renamed.model_dump(mode="json")


def add_comment(ctx: Context, args: dict[str, Any]) -> Any:
    return comments_routes.start(
        comments_routes.StartIn(
            path=args["path"],
            quote=args["quote"],
            before=args.get("before", ""),
            after=args.get("after", ""),
            body=args["body"],
        ),
        ctx.caller.account,
    )


def reply_comment(ctx: Context, args: dict[str, Any]) -> Any:
    return comments_routes.reply(
        args["thread"], comments_routes.BodyIn(path=args["path"], body=args["body"]), ctx.caller.account
    )


def resolve_comment(ctx: Context, args: dict[str, Any]) -> Any:
    comments_routes.resolve(
        args["thread"], comments_routes.ResolveIn(path=args["path"], done=args.get("done", True)), ctx.caller.account
    )
    return {"thread": args["thread"], "done": args.get("done", True)}


def capture_to_inbox(ctx: Context, args: dict[str, Any]) -> Any:
    stamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    return inbox_routes.capture(
        inbox_routes.CaptureIn(
            space=args["space"], text=args["text"], stamp=stamp, language=ctx.caller.account.language or ""
        ),
        ctx.caller.account,
        ctx.who,
    )


def link_mention(ctx: Context, args: dict[str, Any]) -> Any:
    return cleanup_routes.link(
        cleanup_routes.LinkIn(
            source=args["source"], target=args["target"], line=args["line"], column=args["column"], words=args["words"]
        ),
        ctx.caller.account,
        ctx.who,
    )


def set_favorite(ctx: Context, args: dict[str, Any]) -> Any:
    favorites_routes.set_favorite(
        favorites_routes.FavoriteIn(path=args["path"], on=args.get("on", True)), ctx.caller.account
    )
    return {"path": args["path"], "on": args.get("on", True)}


def upload_attachment(ctx: Context, args: dict[str, Any]) -> Any:
    note, folder = args.get("note"), args.get("folder")
    if (note is None) == (folder is None):
        raise ToolError("Give either 'note' or 'folder'.")
    need(ctx.caller.account, note if note is not None else folder, WRITE)
    try:
        data = base64.b64decode(args["data"], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ToolError("'data' is not base64.") from exc
    if not data:
        raise ToolError("The file is empty.")
    if len(data) > MAX_UPLOAD:
        raise ToolError("A file over MCP holds at most 10 MB; larger ones go through the interface.")
    plan = attachments.plan(note=note, folder=folder, name=args["name"], pasted=False, actor=ctx.who)
    attachments.check_size(plan, len(data))
    created = not plan.directory.exists()
    received = attachments.temporary(plan)
    try:
        with open(received, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        result = attachments.finish(plan, received, len(data), ctx.who)
    finally:
        received.unlink(missing_ok=True)
        if created:
            try:
                plan.directory.rmdir()
            except OSError:
                pass
    return asdict(result)


# --- Deleting, sharing, members ---------------------------------------------------------------------------------------


def _trash(ctx: Context, path: str, folder: bool) -> Any:
    clean = need(ctx.caller.account, path, WRITE)
    if "/" not in clean:
        raise ToolError("A whole space goes with delete_space.")
    _kind(clean, folder)
    return vault_routes.delete(clean, ctx.caller.account, ctx.who, [])


def trash_note(ctx: Context, args: dict[str, Any]) -> Any:
    return _trash(ctx, args["path"], False)


def trash_folder(ctx: Context, args: dict[str, Any]) -> Any:
    return _trash(ctx, args["path"], True)


def delete_space(ctx: Context, args: dict[str, Any]) -> Any:
    space = need(ctx.caller.account, args["space"], MANAGE)
    if "/" in space:
        raise ToolError("Not found.")
    return vault_routes.delete(space, ctx.caller.account, ctx.who, [])


def empty_trash(ctx: Context, args: dict[str, Any]) -> Any:
    entries = vault_routes.trash(ctx.caller.account)
    wanted = args.get("entry")
    if wanted is not None:
        entries = [entry for entry in entries if entry.id == wanted]
        if not entries:
            raise ToolError("Not found.")
    removed = 0
    for entry in entries:
        removed += vault_routes.purge_trash(entry.id, ctx.caller.account)["files"]
    return {"entries": len(entries), "files": removed}


def _managed_space(ctx: Context, name: str) -> str:
    space = need(ctx.caller.account, name, MANAGE)
    if "/" in space:
        raise ToolError("Not found.")
    return space


def invite_member(ctx: Context, args: dict[str, Any]) -> Any:
    return set_member_role(ctx, args)


def set_member_role(ctx: Context, args: dict[str, Any]) -> Any:
    from fastapi import Response

    space = _managed_space(ctx, args["space"])
    with SessionLocal() as db:
        return members_routes.set_member(
            space, args["person"], members_routes.MemberIn(role=args["role"]), ctx.caller.account, db, Response()
        )


def remove_member(ctx: Context, args: dict[str, Any]) -> Any:
    space = _managed_space(ctx, args["space"])
    with SessionLocal() as db:
        members_routes.remove_member(space, args["person"], ctx.caller.account, db)
    return {"space": space, "removed": args["person"]}


def create_share(ctx: Context, args: dict[str, Any]) -> Any:
    if ctx.request is None:
        raise ToolError("Public pages need the address of this server.")
    need(ctx.caller.account, args["path"], MANAGE)
    with SessionLocal() as db:
        made = shares_routes.create(
            shares_routes.ShareIn(path=args["path"], days=args.get("days"), password=args.get("password", "")),
            ctx.request,
            ctx.caller.account,
            db,
        )
    return made.model_dump(mode="json")


def remove_share(ctx: Context, args: dict[str, Any]) -> Any:
    with SessionLocal() as db:
        shares_routes.withdraw(args["share"], ctx.caller.account, db)
    return {"share": args["share"], "removed": True}


# --- The list ---------------------------------------------------------------------------------------------------------


def _tool(name: str, group: str, level: str, description: str, schema: dict[str, Any], run: Any) -> dict[str, Any]:
    return {"name": name, "group": group, "level": level, "description": description, "inputSchema": schema, "run": run}


_THREAD = {"type": "integer", "minimum": 1, "description": "The thread, as read_comments gave it."}
_ROLE = {"enum": ["read", "write", "manage"]}

EXTRA_TOOLS: list[dict[str, Any]] = [
    _tool(
        "space_options",
        "read",
        "read",
        "Where a space keeps its daily notes and templates, and their format.",
        _schema(["space"], space=_SPACE),
        space_options,
    ),
    _tool(
        "list_templates", "read", "read", "The templates of a space.", _schema(["space"], space=_SPACE), list_templates
    ),
    _tool(
        "list_versions",
        "read",
        "read",
        "The versions of a note, newest first.",
        _schema(["path"], path=_PATH),
        list_versions,
    ),
    _tool(
        "read_version",
        "read",
        "read",
        "The text of one version of a note.",
        _schema(["version"], version={"type": "integer", "minimum": 1}),
        read_version,
    ),
    _tool(
        "list_tags",
        "read",
        "read",
        "The tags in the readable spaces (or one space) with how often they occur.",
        _schema([], space=_SPACE),
        list_tags,
    ),
    _tool(
        "read_comments",
        "read",
        "read",
        "The comment threads of a note, open ones first.",
        _schema(["path"], path=_PATH),
        read_comments,
    ),
    _tool(
        "list_attachments",
        "read",
        "read",
        "The files in a space that are not notes, with how many notes link each.",
        _schema(["space"], space=_SPACE, unused={"type": "boolean"}),
        list_attachments,
    ),
    _tool(
        "unlinked_mentions",
        "read",
        "read",
        "Where other notes name this note without linking it.",
        _schema(["path"], path=_PATH),
        unlinked_mentions,
    ),
    _tool(
        "cleanup_report",
        "read",
        "read",
        "Notes of a space without any link in or out, and links that lead nowhere.",
        _schema(["space"], space=_SPACE),
        cleanup_report,
    ),
    _tool(
        "list_trash", "read", "read", "What lies in the trash of the spaces you may write in.", _schema([]), list_trash
    ),
    _tool(
        "list_members",
        "read",
        "read",
        "Who is in a space, with their right.",
        _schema(["space"], space=_SPACE),
        list_members,
    ),
    _tool(
        "list_shares",
        "read",
        "read",
        "The public pages of a space you manage.",
        _schema(["space"], space=_SPACE),
        list_shares,
    ),
    _tool(
        "create_space",
        "change",
        "write",
        "Make a new space; you manage it, as with the button 'New space'. Optional: a symbol ('l:' and a Lucide "
            "name, like 'l:shield') and one of the colours of nexlore.",
        _schema(
            ["name"],
            name={"type": "string", "maxLength": 255},
            icon={"type": "string", "maxLength": 80},
            color={"enum": list(looks.COLORS)},
        ),
        create_space,
    ),
    _tool(
        "rename_space",
        "change",
        "write",
        "Give a space another name (manage right); links that name the space in front follow, in every space.",
        _schema(["space", "name"], space=_SPACE, name={"type": "string", "maxLength": 255}),
        rename_space,
    ),
    _tool(
        "set_space_options",
        "change",
        "write",
        "Set where a space keeps its daily notes and templates (manage right).",
        _schema(
            ["space"],
            space=_SPACE,
            daily_folder={"type": "string", "maxLength": 1024},
            daily_template={"type": "string", "maxLength": 1024},
            template_folder={"type": "string", "maxLength": 1024},
            daily_format={"type": "string", "maxLength": 80},
        ),
        set_space_options,
    ),
    _tool(
        "create_folder",
        "change",
        "write",
        "Make a folder in a space or folder.",
        _schema(["parent", "name"], parent=_PATH, name={"type": "string", "maxLength": 255}),
        create_folder,
    ),
    _tool(
        "rename_folder",
        "change",
        "write",
        "Rename a folder; links to what is in it follow.",
        _schema(["path", "name"], path=_PATH, name={"type": "string", "maxLength": 255}),
        rename_folder,
    ),
    _tool(
        "move_folder",
        "change",
        "write",
        "Move a folder into another folder of the same space; links follow.",
        _schema(["path", "into"], path=_PATH, into=_PATH),
        move_folder,
    ),
    _tool(
        "rename_note",
        "change",
        "write",
        "Rename a note; links to it follow.",
        _schema(["path", "title"], path=_PATH, title={"type": "string", "maxLength": 255}),
        rename_note,
    ),
    _tool(
        "move_note",
        "change",
        "write",
        "Move a note into another folder of the same space; links follow.",
        _schema(["path", "into"], path=_PATH, into=_PATH),
        move_note,
    ),
    _tool(
        "create_from_template",
        "change",
        "write",
        "Make a new note from a template of its space.",
        _schema(
            ["folder", "title", "template"], folder=_PATH, title={"type": "string", "maxLength": 255}, template=_PATH
        ),
        create_from_template,
    ),
    _tool(
        "set_property",
        "change",
        "write",
        "Set one property in the front matter of a note; the rest of the file stays as it is. null removes it.",
        _schema(["path", "key"], path=_PATH, key={"type": "string", "maxLength": 110}, value={}),
        set_property,
    ),
    _tool(
        "merge_notes",
        "change",
        "write",
        "Merge a note into another: its text goes to the end of the target, links follow, it goes to the trash.",
        _schema(["source", "target"], source=_PATH, target=_PATH),
        merge_notes,
    ),
    _tool(
        "restore_version",
        "change",
        "write",
        "Bring a version of a note back as its current text.",
        _schema(["version"], version={"type": "integer", "minimum": 1}),
        restore_version,
    ),
    _tool(
        "restore_from_trash",
        "change",
        "write",
        "Bring an entry of the trash back to where it was.",
        _schema(["entry"], entry={"type": "string", "maxLength": 64}),
        restore_from_trash,
    ),
    _tool(
        "rename_tag",
        "change",
        "write",
        "Rename a tag in every note of the spaces you may write in.",
        _schema(["old", "new"], old={"type": "string", "maxLength": 255}, new={"type": "string", "maxLength": 255}),
        rename_tag,
    ),
    _tool(
        "add_comment",
        "change",
        "write",
        "Start a comment thread on words of a note (quote, with up to 40 characters before and after to find them).",
        _schema(
            ["path", "quote", "body"],
            path=_PATH,
            quote={"type": "string", "maxLength": 500},
            before={"type": "string", "maxLength": 80},
            after={"type": "string", "maxLength": 80},
            body={"type": "string", "maxLength": 5000},
        ),
        add_comment,
    ),
    _tool(
        "reply_comment",
        "change",
        "write",
        "Answer in a comment thread.",
        _schema(["path", "thread", "body"], path=_PATH, thread=_THREAD, body={"type": "string", "maxLength": 5000}),
        reply_comment,
    ),
    _tool(
        "resolve_comment",
        "change",
        "write",
        "Close a comment thread (done=false opens it again).",
        _schema(["path", "thread"], path=_PATH, thread=_THREAD, done={"type": "boolean"}),
        resolve_comment,
    ),
    _tool(
        "capture_to_inbox",
        "change",
        "write",
        "Put text on top of the inbox note of a space, with the time.",
        _schema(["space", "text"], space=_SPACE, text={"type": "string", "maxLength": 20000}),
        capture_to_inbox,
    ),
    _tool(
        "upload_attachment",
        "change",
        "write",
        "Upload a file (base64, at most 10 MB) next to a note or into a folder. Place and device are taken out of "
        "photos when the server is set so.",
        _schema(
            ["name", "data"],
            name={"type": "string", "maxLength": 255},
            data={"type": "string"},
            note=_PATH,
            folder=_PATH,
        ),
        upload_attachment,
    ),
    _tool(
        "link_mention",
        "change",
        "write",
        "Turn a mention found by unlinked_mentions into a link.",
        _schema(
            ["source", "target", "line", "column", "words"],
            source=_PATH,
            target=_PATH,
            line={"type": "integer", "minimum": 1},
            column={"type": "integer", "minimum": 0},
            words={"type": "string", "maxLength": 1024},
        ),
        link_mention,
    ),
    _tool(
        "set_favorite",
        "change",
        "write",
        "Make a note or folder a favorite of your account, or not any more.",
        _schema(["path"], path=_PATH, on={"type": "boolean"}),
        set_favorite,
    ),
    _tool(
        "trash_note",
        "risky",
        "write",
        "Put a note into the trash (it can be brought back for 30 days).",
        _schema(["path"], path=_PATH),
        trash_note,
    ),
    _tool(
        "trash_folder",
        "risky",
        "write",
        "Put a folder with everything in it into the trash (30 days).",
        _schema(["path"], path=_PATH),
        trash_folder,
    ),
    _tool(
        "empty_trash",
        "risky",
        "write",
        "Delete trash entries for good: one 'entry', or all you may write.",
        _schema([], entry={"type": "string", "maxLength": 64}),
        empty_trash,
    ),
    _tool(
        "delete_space",
        "risky",
        "write",
        "Put a whole space into the trash (manage right).",
        _schema(["space"], space=_SPACE),
        delete_space,
    ),
    _tool(
        "invite_member",
        "risky",
        "write",
        "Invite an account by its name into a space you manage.",
        _schema(["space", "person", "role"], space=_SPACE, person={"type": "string", "maxLength": 64}, role=_ROLE),
        invite_member,
    ),
    _tool(
        "set_member_role",
        "risky",
        "write",
        "Change the right of a member of a space you manage.",
        _schema(["space", "person", "role"], space=_SPACE, person={"type": "string", "maxLength": 64}, role=_ROLE),
        set_member_role,
    ),
    _tool(
        "remove_member",
        "risky",
        "write",
        "Take an account out of a space you manage.",
        _schema(["space", "person"], space=_SPACE, person={"type": "string", "maxLength": 64}),
        remove_member,
    ),
    _tool(
        "create_share",
        "risky",
        "write",
        "Put a note or folder on a public page (when the server allows them). Optional: days until it ends, password.",
        _schema(
            ["path"],
            path=_PATH,
            days={"type": "integer", "minimum": 1, "maximum": 365},
            password={"type": "string", "maxLength": 200},
        ),
        create_share,
    ),
    _tool(
        "remove_share",
        "risky",
        "write",
        "End a public page.",
        _schema(["share"], share={"type": "integer", "minimum": 1}),
        remove_share,
    ),
]
