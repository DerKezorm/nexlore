"""Tables the shared account module (``vendor/nexkonten``, ``vendor/nexpost``) needs beyond the accounts of 1.16.0.

Everything here is new and starts empty on a database of 1.16.0; nothing of before is renamed or dropped
(``services/konten_wanderung.py``).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ForeignKey, Integer, LargeBinary, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class FormerName(Base):
    """A username an account had before (or one of an account deleted for good, ``account_id`` None): nobody else
    takes it, and calendar or other background programs may still sign in with it (``login.background_account``)."""

    __tablename__ = "former_names"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class SetupClaim(Base):
    """The setup, once per database: one row with id 1; a second setup fails at the primary key, also from another
    process."""

    __tablename__ = "setup_claims"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class Passkey(Base):
    """A passkey (WebAuthn) of an account, as nexdiary and nexpaper keep them: the credential's id and public key,
    the counter that only goes forward, the name the person gave."""

    __tablename__ = "passkeys"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    credential_id: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    public_key: Mapped[bytes] = mapped_column(LargeBinary)
    sign_count: Mapped[int] = mapped_column(Integer, default=0)
    name: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class FailedUnknown(Base):
    """Wrong sign-ins that named no account, one counter row: the store writes it as costly as a failure at an
    account, so that the time of an answer tells nobody which names exist."""

    __tablename__ = "failed_unknown"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)


class MailOutbox(Base):
    """System mail waiting to go out (``vendor/nexpost``): the letter as JSON, tries and the next one, the last
    error. A mail that went out or was given up stays for the operator's page a while (``services/post_store``)."""

    __tablename__ = "mail_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    letter: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    next_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    sent_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    error: Mapped[str] = mapped_column(String(500), default="")
    #: A letter that may go out only once (post 1.1.0: ``daily:<account>:<day>``); empty for every other one. The
    #: letter's headers stand in its JSON (``letter_data``).
    key: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True, index=True)


class PasswordReset(Base):
    """A link for a new password: "Forgot your password?" (``self``), the operator's (``operator``) or the emergency
    command's (``server``). One open link per account; only the hash of the token is kept. New with the shared
    account module: 1.16.0 let the operator set passwords instead."""

    __tablename__ = "password_resets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    origin: Mapped[str] = mapped_column(String(16), default="operator", server_default=text("'operator'"))
