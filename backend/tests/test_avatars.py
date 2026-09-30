"""Profile pictures: drawn anew as a small square WebP without anything of the file that came, seen only by the account,
the operator and whoever shares a space with it."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.services import avatars

from .conftest import join, make_account, sign_in


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def photo(width: int = 600, height: int = 300, *, gps: bool = True, kind: str = "JPEG") -> bytes:
    """Left half red, right half blue; with a place and a device in its Exif, turned by its orientation (6)."""
    image = Image.new("RGB", (width, height), (220, 30, 30))
    image.paste((30, 30, 220), (width // 2, 0, width, height))
    exif = Image.Exif()
    exif[0x0110] = "Pocket Camera 9"  # model
    exif[0x0112] = 6  # orientation: turned
    if gps:
        exif.get_ifd(0x8825)[2] = (52.0, 31.0, 12.0)
    out = io.BytesIO()
    image.save(out, kind, exif=exif.tobytes())
    return out.getvalue()


def me(client: TestClient) -> dict[str, object]:
    return client.get("/api/auth/me").json()


def test_a_picture_comes_back_small_square_upright_and_without_its_metadata(client: TestClient, account: object) -> None:
    anna = person("anna")
    assert me(anna)["avatar"] is None
    answer = anna.put("/api/auth/avatar", content=photo())
    assert answer.status_code == 200
    stamp = answer.json()["avatar"]
    assert stamp and me(anna)["avatar"] == stamp
    own = anna.get(f"/api/avatars/{me(anna)['id']}")
    assert own.status_code == 200 and own.headers["content-type"] == "image/webp"
    assert "private" in own.headers["cache-control"]
    kept = Image.open(io.BytesIO(own.content))
    assert kept.format == "WEBP" and kept.size == (avatars.SIZE, avatars.SIZE)
    assert not kept.getexif() and "xmp" not in kept.info and "exif" not in kept.info
    assert b"Pocket Camera" not in own.content
    # Turned upright (orientation 6: the red left half is on top now) and cut to its middle.
    top = kept.convert("RGB").getpixel((avatars.SIZE // 2, 10))
    low = kept.convert("RGB").getpixel((avatars.SIZE // 2, avatars.SIZE - 10))
    assert top[0] > 150 > top[2] and low[2] > 150 > low[0], (top, low)


def test_only_pictures_come_in(client: TestClient, account: object) -> None:
    anna = person("anna")
    for body in (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", b"<html>hi</html>", b""):
        answer = anna.put("/api/auth/avatar", content=body)
        assert (answer.status_code, answer.json()["detail"]["code"]) == (422, "avatar_not_a_picture")
    # Looks like a JPEG at the start, is not one after.
    broken = anna.put("/api/auth/avatar", content=b"\xff\xd8\xff\xe0" + b"\x00" * 200)
    assert broken.json()["detail"]["code"] == "avatar_not_a_picture"
    # Kinds the decoder would open but no camera makes (TIFF here; EPS would even start Ghostscript): refused first.
    tiff = io.BytesIO()
    Image.new("RGB", (20, 20)).save(tiff, "TIFF")
    assert anna.put("/api/auth/avatar", content=tiff.getvalue()).json()["detail"]["code"] == "avatar_not_a_picture"
    # Tiny on disk, huge in memory.
    huge = io.BytesIO()
    Image.new("1", (8000, 8000)).save(huge, "PNG")
    assert anna.put("/api/auth/avatar", content=huge.getvalue()).json()["detail"]["code"] == "avatar_too_large"
    assert me(anna)["avatar"] is None
    # A PNG and a WebP are pictures too.
    assert anna.put("/api/auth/avatar", content=photo(kind="PNG")).status_code == 200
    assert anna.put("/api/auth/avatar", content=photo(kind="WEBP")).status_code == 200


def test_seen_by_the_account_the_operator_and_those_who_share_a_space_nobody_else(
    client: TestClient, account: object, vault: Path
) -> None:
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    assert anna.put("/api/auth/avatar", content=photo()).status_code == 200
    address = f"/api/avatars/{me(anna)['id']}"
    assert client.get(address).status_code == 200  # the operator
    # bob shares nothing with anna yet: the same answer as for an account without a picture.
    assert bob.get(address).status_code == 404
    assert bob.get(address).json() == bob.get(f"/api/avatars/{me(carl)['id']}").json()
    assert anna.post("/api/spaces", json={"name": "Garden"}).status_code == 201
    join(anna, "Garden", "bob", "read")
    assert bob.get(address).status_code == 200
    assert carl.get(address).status_code == 404
    # Removed: gone for everyone.
    assert anna.delete("/api/auth/avatar").json()["avatar"] is None
    assert anna.get(address).status_code == 404


@pytest.mark.parametrize("size", [(300, 900), (900, 300)])
def test_a_long_picture_is_cut_to_its_middle_not_squeezed(client: TestClient, account: object, size: tuple[int, int]) -> None:
    """Three bands along its length, green, white, black: the middle one fills the square, corners and all."""
    width, height = size
    image = Image.new("RGB", size, (30, 200, 30))
    third = (width // 3, 0, 2 * width // 3, height) if width > height else (0, height // 3, width, 2 * height // 3)
    image.paste((255, 255, 255), third)
    image.paste((0, 0, 0), (2 * width // 3, 0, width, height) if width > height else (0, 2 * height // 3, width, height))
    out = io.BytesIO()
    image.save(out, "PNG")
    anna = person("anna")
    assert anna.put("/api/auth/avatar", content=out.getvalue()).status_code == 200
    kept = Image.open(io.BytesIO(anna.get(f"/api/avatars/{me(anna)['id']}").content)).convert("RGB")
    assert kept.size == (avatars.SIZE, avatars.SIZE)
    for corner in ((4, 4), (avatars.SIZE - 5, avatars.SIZE - 5)):
        assert min(kept.getpixel(corner)) > 200, kept.getpixel(corner)
