"""Cover pictures of spaces and folders, for the cover flow: a picture of a fixed shape (``WIDTH`` by ``HEIGHT``,
three by four) shown on the folder's card.

Kept as the hidden file ``.cover.webp`` in the folder itself, so it goes where the folder goes: moving and renaming
take it along, every backup carries it (backups take hidden files), and Obsidian, which leaves hidden files alone,
never shows it. The index does not know it (it skips hidden names), so it is no note, no attachment and no link
target; nobody reaches it but through ``routers/covers``, with the rights of the space.

What comes in is a picture of any kind a phone or camera makes, or an image file already in the vault; what is kept
is drawn anew, upright, cut to the shape at the height one chose (``focus``): nothing of the file that came survives
but its pixels (no place, no device, no script).
"""

from __future__ import annotations

import io
import logging
import os
from pathlib import Path

from . import media

logger = logging.getLogger("nexlore.vault")

NAME = ".cover.webp"
WIDTH = 900
HEIGHT = 1200
#: Larger than any photo a phone takes; above it the file is not even opened.
MAX_BYTES = 30 * 1024 * 1024
#: Pixels of the picture that came (a 1-bit PNG can be tiny on disk and huge in memory).
MAX_PIXELS = 80_000_000
#: What phones and cameras make. The decoder opens more (TIFF, PSD, EPS, which would start Ghostscript): not here.
KINDS = {"jpeg", "png", "webp", "gif", "bmp", "heic", "avif"}


class CoverError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def make(data: bytes, focus: float = 50) -> bytes:
    """The cover as WebP: upright, cut to three by four, ``focus`` (0 top to 100 bottom, likewise left to right for a
    tall picture) choosing which part stays. ``CoverError`` for anything that is not a picture."""
    if len(data) > MAX_BYTES:
        raise CoverError("cover_too_large")
    if media.sniff(data[:64]) not in KINDS:
        raise CoverError("cover_not_a_picture")
    share = min(max(focus, 0.0), 100.0) / 100
    try:
        import pillow_heif
        from PIL import Image, ImageOps

        pillow_heif.register_heif_opener()
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise CoverError("cover_too_large")
            upright = ImageOps.exif_transpose(image).convert("RGB")
            # The focus moves along whichever side is too long for three by four.
            cut = ImageOps.fit(upright, (WIDTH, HEIGHT), Image.Resampling.LANCZOS, centering=(share, share))
            out = io.BytesIO()
            cut.save(out, "WEBP", quality=84, method=4, exif=b"", xmp=b"")
            return out.getvalue()
    except CoverError:
        raise
    except Exception as exc:
        # A broken or hostile picture fails in the decoder's own way.
        logger.info("A cover picture could not be read: %s", type(exc).__name__)
        raise CoverError("cover_not_a_picture") from exc


def file_of(folder: Path) -> Path:
    return folder / NAME


def version(folder: Path) -> int | None:
    """When the cover was set (milliseconds), for the address of the picture; ``None`` without one."""
    try:
        info = os.stat(file_of(folder))
    except OSError:
        return None
    return info.st_mtime_ns // 1_000_000


def gone_below(top: Path) -> int:
    """A folder goes into the trash: the covers in it and below go (as its symbol and colour do), so nothing hidden
    keeps the emptied folders on the disk. Returns how many went."""
    count = 0
    for directory, _subdirs, files in os.walk(top):
        if NAME in files:
            try:
                os.unlink(os.path.join(directory, NAME))
                count += 1
            except OSError:
                continue
    return count
