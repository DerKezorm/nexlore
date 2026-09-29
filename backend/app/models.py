"""The data model.

The Markdown files are the truth. What the database holds about them (index, links, tags) can be rebuilt from the
files at any time; the history (``versions``) and the trash cannot, they exist only here.

Every file in the vault has a row in ``files``, notes and other files alike: links point at pictures and PDFs too.
A row keeps its id across renames, so versions and backlinks follow a note wherever it moves. A deleted file keeps
its row with ``deleted_at`` set; that is the trash.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, ClassVar

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator[datetime]):
    """SQLite forgets the time zone. Stored as UTC, read back as UTC with the zone attached."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)


class Space(Base):
    """A folder at the top of the vault. Rights (M4) hang on it; a link leads into another space only with that
    space's name in front."""

    __tablename__ = "spaces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    folder: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: What the space's managers set for everybody in it (M6): where daily notes and templates live.
    #: ``daily_folder``, ``daily_template``, ``template_folder``; missing keys take the defaults of ``everyday``.
    options: Mapped[Any] = mapped_column(JSON, nullable=True)


class File(Base):
    __tablename__ = "files"
    __table_args__ = (
        # One live row per path; trashed rows keep theirs, so a new file may take the place.
        Index("files_live_path", "path", unique=True, sqlite_where=text("deleted_at IS NULL")),
        Index("files_space_name", "space_id", "name_key"),
        Index("files_space_path_key", "space_id", "path_key"),
        Index("files_deleted", "deleted_at"),
        # A file uploaded twice is found by its content.
        Index("files_space_hash", "space_id", "hash"),
        Index("files_owner", "owner"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    #: Relative to the vault, POSIX, byte for byte as on disk (a name from macOS may be NFD): ``Space/Folder/Note.md``.
    path: Mapped[str] = mapped_column(String(1024))
    #: The path NFC-normalised and casefolded, for lookups the way Windows and macOS compare names.
    path_key: Mapped[str] = mapped_column(String(1024))
    #: The name without folder and without ``.md``, casefolded: what ``[[Note]]`` is matched against.
    name_key: Mapped[str] = mapped_column(String(255))
    is_note: Mapped[bool] = mapped_column(Boolean, default=False)
    title: Mapped[str] = mapped_column(String(1024), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    mtime_ns: Mapped[int] = mapped_column(Integer, default=0)
    #: sha256 of the bytes on disk.
    hash: Mapped[str] = mapped_column(String(64), default="")
    front: Mapped[Any] = mapped_column(JSON, nullable=True)
    features: Mapped[Any] = mapped_column(JSON, nullable=True)
    indexed_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: ``app`` when deleted through nexlore, ``external`` when the file vanished from the disk.
    deleted_how: Mapped[str | None] = mapped_column(String(16), nullable=True)
    deleted_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: Files deleted together (a folder) share it and come back together.
    trash_group: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    #: The account that uploaded the file; its size counts against that account's space. Empty for files that came
    #: from elsewhere (the disk, an import).
    owner: Mapped[str | None] = mapped_column(String(255), nullable=True)


class Link(Base):
    __tablename__ = "links"
    __table_args__ = (
        Index("links_space_target_key", "space_id", "target_key"),
        # Covers the graph's reading of every link of a space (who links to whom), without a look into the table.
        Index("links_space_pair", "space_id", "source_id", "target_id"),
        # Links written with the name of another space in front: looked at again when that space's names change.
        Index("links_via_key", "via", "target_key"),
        # Links that lead into another space, out of a space and into one: few, and read whole by the graph (tiles
        # and the bundles between spaces), so these cover every column asked for and hold nothing else.
        Index("links_across_out", "space_id", "source_id", "target_id", "target_space_id",
              sqlite_where=text("target_space_id IS NOT NULL")),
        Index("links_across_in", "target_space_id", "target_id", "source_id", "space_id",
              sqlite_where=text("target_space_id IS NOT NULL")),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), index=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    #: ``wiki``, ``embed``, ``md`` or ``md_embed``.
    kind: Mapped[str] = mapped_column(String(16))
    #: As written, decoded: ``Folder/Note`` of ``[[Folder/Note#Part]]``.
    target: Mapped[str] = mapped_column(String(1024))
    subpath: Mapped[str] = mapped_column(String(1024), default="")
    #: The last part of the target, casefolded, without ``.md``: which links to look at again when a file with that
    #: name appears or goes.
    target_key: Mapped[str] = mapped_column(String(255))
    #: The file the link points at; empty while it points nowhere.
    target_id: Mapped[int | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True, index=True
    )
    line: Mapped[int] = mapped_column(Integer, default=0)
    #: The first part of the target, casefolded, where it could name another space (``[[Team/Note]]``,
    #: ``../Team/Note.md``); empty where the link cannot leave its space. Which space it names is looked up when
    #: the link is resolved: a space can appear after the link was written.
    via: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: The space of the target, set only where it lies in another space than the note that links it. Whoever may
    #: not read that space sees the link as leading nowhere.
    target_space_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (Index("tags_key", "tag_key"),)

    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    #: Casefolded; Obsidian treats #Idea and #idea as one tag.
    tag_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    tag: Mapped[str] = mapped_column(String(255))
    #: Order in the note, front matter first: the first tag is where the note stands in the graph's tag cloud.
    pos: Mapped[int] = mapped_column(Integer, default=0)


class Task(Base):
    """A line with a checkbox, as the Obsidian Tasks plugin writes it (``services/tasks.py``). Rebuilt with the
    note's links and tags whenever the note is indexed; the line itself is the truth."""

    __tablename__ = "tasks"
    __table_args__ = (
        Index("tasks_space_status_due", "space_id", "status", "due"),
        Index("tasks_space_status_scheduled", "space_id", "status", "scheduled"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), index=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    #: From 1, as an editor counts.
    line: Mapped[int] = mapped_column(Integer)
    #: The whole line as written, without its end: what ticking it off compares against before it writes.
    raw: Mapped[str] = mapped_column(String(4000))
    #: open, done or cancelled; ``mark`` is the character between the brackets.
    status: Mapped[str] = mapped_column(String(12))
    mark: Mapped[str] = mapped_column(String(4), default=" ")
    text: Mapped[str] = mapped_column(String(1000), default="")
    #: Dates as written, JJJJ-MM-TT: they sort and compare as text.
    due: Mapped[str | None] = mapped_column(String(10), nullable=True)
    scheduled: Mapped[str | None] = mapped_column(String(10), nullable=True)
    start: Mapped[str | None] = mapped_column(String(10), nullable=True)
    completed: Mapped[str | None] = mapped_column(String(10), nullable=True)
    #: 0 lowest, 1 low, 2 none, 3 medium, 4 high, 5 highest.
    priority: Mapped[int] = mapped_column(Integer, default=2)
    recurrence: Mapped[str | None] = mapped_column(String(200), nullable=True)
    #: The task's own tags, as written, space-separated; ``tag_keys`` casefolded with a space before and after
    #: each, for filtering with LIKE.
    tags: Mapped[str] = mapped_column(String(1000), default="")
    tag_keys: Mapped[str] = mapped_column(String(1000), default="")


class GraphGroup(Base):
    """A circle of the graph: a space, a folder, a tag, a topic, or a bucket of a crowded one. Worked out by
    ``services.graphstore`` for each space and each cloud (``folders``, ``tags``, ``topics``); never the truth,
    always rebuilt from files and links."""

    __tablename__ = "graph_groups"
    __table_args__ = (UniqueConstraint("space_id", "cloud", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    cloud: Mapped[str] = mapped_column(String(8))
    #: Stable within a cloud: ``space``, ``f:<folder path in the space>``, ``t:<tag key>``, ``untagged``,
    #: ``k:<topic>``, ``recent``, and a bucket ``<parent key>|b<note id>`` or ``<parent key>|u<n>``.
    key: Mapped[str] = mapped_column(String(1100))
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: ``space``, ``folder``, ``tag``, ``untagged``, ``topic``, ``recent``, ``unsorted``, ``bucket``, ``unlinked``,
    #: ``range`` (a part of a crowded group's subgroups, by name).
    kind: Mapped[str] = mapped_column(String(12))
    name: Mapped[str] = mapped_column(String(1024), default="")
    #: The note a bucket is named after; its title is looked up when shown, so a rename shows at once.
    anchor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Notes below, and how many of them are daily notes (a group of only daily notes can be hidden).
    total: Mapped[int] = mapped_column(Integer, default=0)
    daily: Mapped[int] = mapped_column(Integer, default=0)
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    r: Mapped[float] = mapped_column(Float, default=0.0)
    rx: Mapped[float] = mapped_column(Float, default=0.0)
    ry: Mapped[float] = mapped_column(Float, default=0.0)
    #: Index into the interface's palette; -1 grey.
    color: Mapped[int] = mapped_column(Integer, default=0)


class GraphNode(Base):
    """Where a note stands in one cloud of the graph, and from which zoom level on it is drawn at all."""

    __tablename__ = "graph_nodes"
    __table_args__ = (Index("graph_nodes_tile", "space_id", "cloud", "level", "x", "y"),)

    cloud: Mapped[str] = mapped_column(String(8), primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    group_id: Mapped[int] = mapped_column(Integer, index=True)
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    r: Mapped[float] = mapped_column(Float, default=5.0)
    rx: Mapped[float] = mapped_column(Float, default=0.0)
    ry: Mapped[float] = mapped_column(Float, default=0.0)
    #: ``floor(log2(zoom))`` at which the note's group starts to open: the browser loads it with that level's tiles.
    level: Mapped[int] = mapped_column(Integer, default=0)
    #: What the note was grouped by (its folder, its first tag, its topic): a change moves it.
    placed: Mapped[str] = mapped_column(String(1100), default="")
    daily: Mapped[bool] = mapped_column(Boolean, default=False)


class GraphState(Base):
    """How far the graph of a space and cloud is: built when, changed when, anything waiting."""

    __tablename__ = "graph_state"

    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), primary_key=True)
    cloud: Mapped[str] = mapped_column(String(8), primary_key=True)
    #: Counts up with every change, so the browser knows its tiles are stale.
    version: Mapped[int] = mapped_column(Integer, default=0)
    #: The last full layout (and for topics: the last time they were worked out).
    built_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The last change that placed or removed notes without a new layout; the night orders the map again after one.
    changed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class MoveJob(Base):
    """A rename or move whose links are still being rewritten, part by part (``vault.move``). Kept in the database,
    so that a server stopped half way carries on at its next start instead of leaving links under the old name."""

    __tablename__ = "move_jobs"
    # A number is never given twice: a job that just ended must not hand its number to the next while the first is
    # still marked as being worked on (``vault._claimed``).
    __table_args__: ClassVar[dict[str, object]] = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    #: Who moved: the versions of the rewritten notes name them.
    author: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: The names the moved files had and have: links written with them are resolved again at the end.
    keys: Mapped[Any] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class MoveJobNote(Base):
    """One note a move still has to look at: its links that pointed at a moved file, by how they were written, and
    whether it moved itself (then its own relative links are rewritten from its new place)."""

    __tablename__ = "move_job_notes"

    job_id: Mapped[int] = mapped_column(ForeignKey("move_jobs.id", ondelete="CASCADE"), primary_key=True)
    note_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    #: The moved notes come first: the note someone renamed shows its new name right away.
    position: Mapped[int] = mapped_column(Integer, default=0)
    moved: Mapped[bool] = mapped_column(Boolean, default=False)
    #: ``[kind, target as written, id of the file it pointed at]`` for every link to rewrite.
    links: Mapped[Any] = mapped_column(JSON)


class Version(Base):
    """A saved state of a note. Content is zlib-compressed; the newest version is the note as nexlore last saw it."""

    __tablename__ = "versions"
    __table_args__ = (Index("versions_file_time", "file_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"))
    #: Where the note was when this version was made.
    path: Mapped[str] = mapped_column(String(1024))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: Saves of one session within a short time are folded into one version; this is the last of them.
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    #: ``initial``, ``app``, ``external``, ``rename``, ``restore``, ``import``.
    source: Mapped[str] = mapped_column(String(16))
    author: Mapped[str | None] = mapped_column(String(255), nullable=True)
    session: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hash: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    content: Mapped[bytes] = mapped_column(LargeBinary)


class Lock(Base):
    """Who is editing a note right now. Held by a heartbeat; a lock that is not renewed runs out by itself."""

    __tablename__ = "locks"

    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    #: The client that holds it: one browser tab.
    holder: Mapped[str] = mapped_column(String(64))
    holder_name: Mapped[str] = mapped_column(String(255), default="")
    acquired_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class TrashBlob(Base):
    """A file other than a note, deleted through nexlore: its bytes, so it can come back. Notes need none, their
    newest version is the content."""

    __tablename__ = "trash_blobs"

    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    content: Mapped[bytes] = mapped_column(LargeBinary)


OPERATOR = "operator"
MEMBER = "member"
ROLES = (OPERATOR, MEMBER)

SIGN_IN_PASSWORD = "password"
SIGN_IN_OIDC = "oidc"

#: Rights in a space, each one including the ones before it: reading; writing (notes, files, the trash);
#: managing (inviting, giving rights, renaming or deleting the space).
READ = "read"
WRITE = "write"
MANAGE = "manage"
SPACE_ROLES = (READ, WRITE, MANAGE)


class Account(Base):
    """A person. The first account is the operator; the others come by invitation or through OIDC."""

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Lower case, the name people sign in with and see in locks and versions.
    name: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(16), default=MEMBER)
    sign_in: Mapped[str] = mapped_column(String(16), default=SIGN_IN_PASSWORD)
    #: Argon2id. Empty for accounts that sign in through OIDC only.
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    oidc_subject: Mapped[str] = mapped_column(String(255), default="")
    #: The interface language chosen in the account menu; empty: the browser's.
    language: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The second factor (``services/totp.py``): the seed encrypted with the server secret, empty while off; the
    #: recovery codes as a JSON list of SHA-256 hashes; the time step of the last code taken (no replay).
    totp_secret_enc: Mapped[str] = mapped_column(Text, default="")
    totp_recovery: Mapped[str] = mapped_column(Text, default="")
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    #: The account's own AI service for its notes (``services/ai.py``): an OpenAI-shaped address, the model, the key
    #: encrypted with the server secret, and whether the account switched it on. Off and empty from the start.
    ai_url: Mapped[str] = mapped_column(String(500), default="")
    ai_model: Mapped[str] = mapped_column(String(200), default="")
    ai_key_enc: Mapped[str] = mapped_column(Text, default="")
    ai_active: Mapped[bool] = mapped_column(Boolean, default=False)
    #: The profile picture (``services/avatars.py``): a square WebP drawn anew, loaded only when asked for; and when it
    #: was set, which makes its address new.
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Not stored. Set on the account an MCP key acts as when the key may see only some spaces (``services/mcp.py``):
    #: ``rights`` then answers for every other space as if it did not exist.
    key_spaces: ClassVar[frozenset[int] | None] = None


class AuthSession(Base):
    """A browser session. Only the hash of the token is stored; the token itself lives in the cookie."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")


class Membership(Base):
    """An account's right in a space. A space without any member belongs to the operator (it came from the disk)."""

    __tablename__ = "memberships"

    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(16), default=READ)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Invite(Base):
    """A link that lets somebody in: into nexlore (a new account) and, when it names a space, into that space with a
    right. Only the hash of the token is stored; used once, then gone."""

    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    space_id: Mapped[int | None] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), nullable=True)
    #: The right in the space; empty for an invitation into nexlore only.
    space_role: Mapped[str] = mapped_column(String(16), default="")
    #: Where the invitation was mailed to, if it was; also a hint for the name.
    email: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class Share(Base):
    """A public reading page for a note or a folder: anybody with the link reads it, nothing else."""

    __tablename__ = "shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: The secret part of the address. Kept, so the link can be copied again; it only ever opens this one share.
    token: Mapped[str] = mapped_column(String(64), unique=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), index=True)
    #: Vault-relative path of the note or folder at the time of sharing; follows renames (``vault.move``).
    path: Mapped[str] = mapped_column(String(1024))
    is_folder: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Argon2id; empty: no password.
    password_hash: Mapped[str] = mapped_column(String(255), default="")


class Look(Base):
    """A symbol and a colour of its own for a space or folder (``services/looks``): in the database, never in the
    folders. ``folder`` is the path within the space, "" for the space itself."""

    __tablename__ = "looks"
    __table_args__ = (Index("looks_space_folder", "space_id", "folder", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"))
    folder: Mapped[str] = mapped_column(String(1024), default="")
    icon: Mapped[str | None] = mapped_column(String(80), nullable=True)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)


#: The full-text index, created by ``db.init_db`` (SQLAlchemy has no FTS5 table). rowid is ``files.id``.
FTS_TABLE = "notes_fts"
FTS_CREATE = (
    f"CREATE VIRTUAL TABLE IF NOT EXISTS {FTS_TABLE} USING fts5("
    "title, body, tokenize = 'unicode61 remove_diacritics 2')"
)


class McpKey(Base):
    """A key an account made for AI from outside (MCP, M7). Only the SHA-256 of the token is stored."""

    __tablename__ = "mcp_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    #: ``read``, ``draft`` or ``write`` (``services/mcp.py``).
    level: Mapped[str] = mapped_column(String(8))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: The first characters of the token, to tell keys apart in the interface.
    prefix: Mapped[str] = mapped_column(String(16))
    #: The ids of the spaces the key may see, of those its account may read; empty (None): all of them.
    spaces: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class Favorite(Base):
    """A note or folder an account wants at hand (``services/favorites``): the vault path, per account."""

    __tablename__ = "favorites"
    __table_args__ = (Index("favorites_account_path", "account_id", "path", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1024))


class AiEvent(Base):
    """What went out to an account's AI service, word for word, encrypted: the proof of what left the house. Kept
    14 days (``services/ai.py``), cleared at once on request; a failure is in it too, a request refused before
    sending is not."""

    __tablename__ = "ai_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    model: Mapped[str] = mapped_column(String(200), default="")
    task: Mapped[str] = mapped_column(String(32), default="")
    #: The tone or the language, where the task has one.
    target: Mapped[str] = mapped_column(String(64), default="")
    #: The request body as sent (JSON), encrypted with the server secret under a context of its own.
    body_enc: Mapped[str] = mapped_column(Text, default="")
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    #: The error code when it failed after sending; empty when it worked.
    error: Mapped[str] = mapped_column(String(64), default="")


class Draft(Base):
    """A change an AI proposed over MCP: a new text for a note, or a new note. Only its account sees it."""

    __tablename__ = "drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: The key that made it; kept by name when the key is revoked.
    key_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    key_name: Mapped[str] = mapped_column(String(100), default="")
    space_id: Mapped[int] = mapped_column(ForeignKey("spaces.id", ondelete="CASCADE"), index=True)
    #: The note it changes; empty for a new note, which is made at ``path`` (folder and title).
    file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), nullable=True, index=True)
    path: Mapped[str] = mapped_column(String(1024))
    #: The state of the note the AI read: taking the draft over saves against it.
    base_hash: Mapped[str] = mapped_column(String(64), default="")
    content: Mapped[bytes] = mapped_column(LargeBinary)
    reason: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Plugin(Base):
    """A plugin the operator installed (M7): from the catalog or, behind the latch, a file of one's own. Its code is
    kept here, so a backup holds it; ``approved``: let out, so that people may switch it on for themselves."""

    __tablename__ = "plugins"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    version: Mapped[str] = mapped_column(String(16), default="")
    #: ``catalog`` or ``upload``.
    source: Mapped[str] = mapped_column(String(8), default="catalog")
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    manifest: Mapped[Any] = mapped_column(JSON, nullable=True)
    code: Mapped[str] = mapped_column(Text, default="")
    code_hash: Mapped[str] = mapped_column(String(64), default="")
    installed_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    installed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class PluginUser(Base):
    """Whether an account switched a plugin on for itself."""

    __tablename__ = "plugin_users"

    plugin_id: Mapped[str] = mapped_column(ForeignKey("plugins.id", ondelete="CASCADE"), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Unused: no plugin could reach it (the page offered no way). Kept, because columns are never dropped here.
    data: Mapped[Any] = mapped_column(JSON, nullable=True)
