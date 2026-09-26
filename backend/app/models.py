"""The data model.

The Markdown files are the truth. What the database holds about them (index, links, tags) can be rebuilt from the
files at any time; the history (``versions``) and the trash cannot, they exist only here.

Every file in the vault has a row in ``files``, notes and other files alike: links point at pictures and PDFs too.
A row keeps its id across renames, so versions and backlinks follow a note wherever it moves. A deleted file keeps
its row with ``deleted_at`` set; that is the trash.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
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
    """A folder at the top of the vault. Rights (M4) hang on it; links never cross from one space into another."""

    __tablename__ = "spaces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    folder: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


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
    __table_args__ = (Index("links_space_target_key", "space_id", "target_key"),)

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


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (Index("tags_key", "tag_key"),)

    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    #: Casefolded; Obsidian treats #Idea and #idea as one tag.
    tag_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    tag: Mapped[str] = mapped_column(String(255))


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


#: The full-text index, created by ``db.init_db`` (SQLAlchemy has no FTS5 table). rowid is ``files.id``.
FTS_TABLE = "notes_fts"
FTS_CREATE = (
    f"CREATE VIRTUAL TABLE IF NOT EXISTS {FTS_TABLE} USING fts5("
    "title, body, tokenize = 'unicode61 remove_diacritics 2')"
)
