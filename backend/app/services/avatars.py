"""Profile pictures: what comes in is a picture of any kind a phone or camera makes; what is kept is a square WebP of
``SIZE`` pixels, drawn anew. Nothing of the file that came survives but its pixels: no place, no device, no hidden
second picture, no script in an SVG (an SVG is not taken at all).

Kept in the database next to the account (a few kilobytes), so every backup carries it and nothing lies beside.
Seen by the account itself, the operator, and whoever shares a space with it; anyone else is told there is none.
"""

from __future__ import annotations

import io
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from ..models import OPERATOR, Account, Membership
from . import media

logger = logging.getLogger("nexlore.accounts")

SIZE = 256
#: Larger than any photo a phone takes; above it the file is not even opened.
MAX_BYTES = 20 * 1024 * 1024
#: Pixels of the picture that came (a 1-bit PNG can be tiny on disk and huge in memory).
MAX_PIXELS = 50_000_000
#: What phones and cameras make. The decoder opens more (TIFF, PSD, EPS, which would start Ghostscript): not here.
KINDS = {"jpeg", "png", "webp", "gif", "bmp", "heic", "avif"}


class AvatarError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def make(data: bytes) -> bytes:
    """The square WebP of a picture, upright and cut to its middle. ``AvatarError`` for anything else."""
    if len(data) > MAX_BYTES:
        raise AvatarError("avatar_too_large")
    if media.sniff(data[:64]) not in KINDS:
        raise AvatarError("avatar_not_a_picture")
    try:
        import pillow_heif
        from PIL import Image, ImageOps

        pillow_heif.register_heif_opener()
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise AvatarError("avatar_too_large")
            upright = ImageOps.exif_transpose(image)
            square = ImageOps.fit(upright.convert("RGBA"), (SIZE, SIZE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            square.save(out, "WEBP", quality=85, method=4, exif=b"", xmp=b"")
            return out.getvalue()
    except AvatarError:
        raise
    except Exception as exc:
        # A broken or hostile picture fails in the decoder's own way.
        logger.info("A profile picture could not be read: %s", type(exc).__name__)
        raise AvatarError("avatar_not_a_picture") from exc


def may_see(db: Session, viewer: Account, owner_id: int) -> bool:
    """The account itself, the operator, and whoever shares a space with it."""
    if viewer.id == owner_id or viewer.role == OPERATOR:
        return True
    theirs = aliased(Membership)
    shared = db.execute(
        select(Membership.space_id)
        .join(theirs, theirs.space_id == Membership.space_id)
        .where(Membership.account_id == viewer.id, theirs.account_id == owner_id)
        .limit(1)
    ).first()
    return shared is not None
