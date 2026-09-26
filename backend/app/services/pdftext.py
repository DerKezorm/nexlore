"""The text of a PDF, for the search.

A PDF is a program of drawing instructions more than a text, and one from outside can be built to make a reader
work for hours. So the reading is bounded: files above a size are not read at all, and reading stops after a number
of pages, of characters, or of seconds, whichever comes first. What was read until then is searched. Encrypted
files without a password are left out. pypdf's own warnings stay out of the log: they can quote the file.

This runs inside index workers (``prepare``), so it opens no database and reads no settings.
"""

from __future__ import annotations

import io
import logging
import time

#: Larger files are indexed by name only.
MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 2000
MAX_CHARS = 2_000_000
MAX_SECONDS = 20.0

logging.getLogger("pypdf").setLevel(logging.CRITICAL)


def extract(data: bytes) -> tuple[str | None, dict[str, int]]:
    """(text or None, features for the import report and the file page)."""
    if len(data) > MAX_BYTES:
        return None, {"pdf_too_large": 1}
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted and not reader.decrypt(""):
            return None, {"pdf_encrypted": 1}
        began = time.monotonic()
        parts: list[str] = []
        total = 0
        features: dict[str, int] = {"pdf_pages": len(reader.pages)}
        for number, page in enumerate(reader.pages):
            if number >= MAX_PAGES or total >= MAX_CHARS or time.monotonic() - began > MAX_SECONDS:
                features["pdf_cut"] = 1
                break
            text = page.extract_text() or ""
            parts.append(text)
            total += len(text)
        text = "\n".join(parts)[:MAX_CHARS].replace("\x00", "")
        return (text if text.strip() else None), features
    except Exception:  # noqa: BLE001 - any file from outside may break the reader in its own way
        return None, {"pdf_unreadable": 1}
