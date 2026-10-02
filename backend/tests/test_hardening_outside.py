"""Security review before 1.0.0, the parts the reviewers could not finish: pages and pictures from outside."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from PIL import Image

from app.services import linktitle, media

from .test_linktitle import page, world

# --- Titles of pasted links ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("body", [
    b"<title>" * 40_000,
    b"<title " * 40_000,
    b'<meta property="og:title" ' * 10_000,
    b"<meta " * 40_000,
    b"<TITLE>" + b"x" * 250_000,
], ids=["titles", "title-tags", "metas", "meta-tags", "one-long-title"])
def test_a_hostile_page_is_read_in_linear_time(body: bytes) -> None:
    # Before: minutes for 64 KB of unclosed <title>, with the whole server waiting (the pattern held the GIL).
    started = time.perf_counter()
    linktitle._title_of(body, "text/html")
    assert time.perf_counter() - started < 1


@pytest.mark.parametrize(("body", "title"), [
    ("<html><head><TITLE lang='en'>Upper case</TITLE></head>", "Upper case"),
    ("<title>first</title><title>second</title>", "first"),
    ('<meta name="twitter:title" content="Card title">', "Card title"),
    ('<meta content="x"><meta property="og:title" content="Second meta">', "Second meta"),
    ("<title>unclosed", None),
    ("<meta property='og:title' content='no end of the tag'", None),
])
def test_titles_are_found_as_before(body: str, title: str | None) -> None:
    resolve, transport = world({"example.com/p": page(body)})
    assert linktitle.fetch("https://example.com/p", resolve=resolve, transport=transport) == title


# --- Pictures -----------------------------------------------------------------------------------------------------------


def test_no_webp_of_a_picture_with_more_pixels_than_any_phone_takes(tmp_path: Path,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media, "MAX_WEBP_PIXELS", 10_000)
    big, small = tmp_path / "big.png", tmp_path / "small.png"
    Image.new("RGB", (200, 200)).save(big)
    Image.new("RGB", (50, 50)).save(small)
    assert media.to_webp(big, tmp_path / "big.webp") is False
    assert not (tmp_path / "big.webp").exists()
    assert media.to_webp(small, tmp_path / "small.webp") is True
