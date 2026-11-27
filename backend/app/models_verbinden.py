"""The tables of the shared module verbinden (``vendor/nexverbinden``, plan "Entwurf Apps verbinden"): a connection with
another nex app made by one click and a consent (both directions in one row), a started connection, a code of a
consent, spent tokens and revocations that wait for the partner. New beside everything of before: nexlore had no
connection with another nex app. Only SHA-256 of what nexlore hands out; what the partner handed out is sealed with
the server's key."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class AppConnection(Base):
    __tablename__ = "vb_connections"
    __table_args__ = (UniqueConstraint("account_id", "partner", name="uq_vb_connection_partner"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    partner: Mapped[str] = mapped_column(String(32))
    partner_base: Mapped[str] = mapped_column(String(500))
    partner_account: Mapped[str] = mapped_column(String(200), default="")
    uses: Mapped[Any] = mapped_column(JSON, default=list)
    grants: Mapped[Any] = mapped_column(JSON, default=list)
    areas_granted: Mapped[Any] = mapped_column(JSON, nullable=True)
    areas_used: Mapped[Any] = mapped_column(JSON, nullable=True)
    #: What the partner gave nexlore (its access and refresh token), sealed.
    held: Mapped[str] = mapped_column(Text)
    issued_access_hash: Mapped[str] = mapped_column(String(64), unique=True)
    issued_refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    issued_access_expires: Mapped[datetime] = mapped_column(UtcDateTime)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    ok_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    state: Mapped[str] = mapped_column(String(16), default="connected")
    stale_since: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    problem: Mapped[str | None] = mapped_column(String(64), nullable=True)
    partner_version: Mapped[str] = mapped_column(String(40), default="")


class AppConnectionPending(Base):
    __tablename__ = "vb_pending"

    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    partner: Mapped[str] = mapped_column(String(32))
    partner_base: Mapped[str] = mapped_column(String(500))
    verifier: Mapped[str] = mapped_column(String(200))
    areas_granted: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class AppConnectionCode(Base):
    __tablename__ = "vb_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    partner: Mapped[str] = mapped_column(String(32))
    partner_base: Mapped[str] = mapped_column(String(500))
    redirect_uri: Mapped[str] = mapped_column(String(2048))
    challenge: Mapped[str] = mapped_column(String(200))
    areas_granted: Mapped[Any] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class AppConnectionSpent(Base):
    __tablename__ = "vb_spent"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(64), index=True)
    at: Mapped[int] = mapped_column(Integer)


class AppConnectionWaiting(Base):
    __tablename__ = "vb_waiting"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer)
    partner_base: Mapped[str] = mapped_column(String(500))
    #: The token to revoke at the partner, sealed.
    token: Mapped[str] = mapped_column(Text)
    since: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
