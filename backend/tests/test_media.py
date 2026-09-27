"""Place and device out of photos and videos, the pictures untouched."""

from __future__ import annotations

import io
import struct
from pathlib import Path

import pillow_heif
import pytest
from PIL import Image, PngImagePlugin

from app.services import media

pillow_heif.register_heif_opener()

XMP = (
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    b'<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="52,31.2N" '
    b'exif:GPSLongitude="13,24.3E"/></rdf:RDF></x:xmpmeta>'
)
SECRETS = [b"PhoneMaker", b"PhoneModel", b"SERIAL-4711", b"LensOf-4711", b"52,31.2N"]


def exif_bytes() -> bytes:
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"
    exif[0x0110] = "PhoneModel"
    exif[0x0112] = 6  # rotated: must survive
    exif[0x0131] = "Camera App 2.0"  # software: stays
    sub = exif.get_ifd(0x8769)
    sub[0xA431] = "SERIAL-4711"
    sub[0xA434] = "LensOf-4711"
    sub[0x9003] = "2026:09:26 10:00:00"
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (52.0, 31.0, 12.0)
    gps[3] = "E"
    gps[4] = (13.0, 24.0, 18.0)
    return exif.tobytes()


def picture() -> Image.Image:
    image = Image.new("RGB", (32, 24))
    for x in range(32):
        for y in range(24):
            image.putpixel((x, y), (x * 8, y * 10, (x + y) * 4))
    return image


def saved(tmp_path: Path, name: str, **options: object) -> Path:
    target = tmp_path / name
    picture().save(target, **options)
    return target


#: The latitude 52° 31' 12" as TIFF writes it (three fractions), in either byte order.
LATITUDE = [struct.pack(order + "6I", 52, 1, 31, 1, 12, 1) for order in "<>"]


def check_clean(path: Path, before: bytes, pixels: bytes) -> Image.Image:
    after = path.read_bytes()
    assert len(after) == len(before), "the file keeps its length"
    assert any(value in before for value in LATITUDE)
    for secret in SECRETS + LATITUDE:
        assert secret not in after, secret
    assert b"Camera App 2.0" in after
    image = Image.open(path)
    image.load()
    assert image.tobytes() == pixels, "the picture itself is untouched"
    exif = image.getexif()
    assert exif.get(0x0112) == 6
    assert not exif.get_ifd(0x8825)
    assert exif.get_ifd(0x8769).get(0x9003) == "2026:09:26 10:00:00"
    return image


@pytest.mark.parametrize(
    ("name", "kind", "options"),
    [
        ("photo.jpg", "jpeg", {"format": "JPEG", "quality": 90}),
        ("photo.webp", "webp", {"format": "WEBP", "lossless": True}),
        ("photo.png", "png", {"format": "PNG"}),
    ],
)
def test_place_and_device_go_the_rest_stays(tmp_path: Path, name: str, kind: str, options: dict) -> None:
    extra = {"xmp": XMP} if kind != "png" else {}
    if kind == "png":
        info = PngImagePlugin.PngInfo()
        info.add_itxt("XML:com.adobe.xmp", XMP.decode())
        extra = {"pnginfo": info}
    path = saved(tmp_path, name, exif=exif_bytes(), **options, **extra)
    before = path.read_bytes()
    assert all(secret in before for secret in SECRETS)
    pixels = Image.open(path).tobytes()
    assert media.sniff(before[:64]) == kind
    removed = media.strip(path, kind)
    assert removed == {media.LOCATION, media.DEVICE}
    check_clean(path, before, pixels)


def test_heic_loses_place_and_device_too(tmp_path: Path) -> None:
    path = tmp_path / "photo.heic"
    picture().save(path, format="HEIF", exif=exif_bytes(), xmp=XMP, quality=90)
    before = path.read_bytes()
    assert media.sniff(before[:64]) == "heic"
    assert b"PhoneMaker" in before and b"52,31.2N" in before
    pixels = Image.open(path).tobytes()
    assert media.strip(path, "heic") == {media.LOCATION, media.DEVICE}
    after = path.read_bytes()
    assert len(after) == len(before)
    for secret in SECRETS:
        assert secret not in after, secret
    image = Image.open(path)
    assert image.tobytes() == pixels
    assert not image.getexif().get_ifd(0x8825)


def test_nothing_to_remove_leaves_the_file_as_it_is(tmp_path: Path) -> None:
    exif = Image.Exif()
    exif[0x0112] = 3
    path = saved(tmp_path, "plain.jpg", format="JPEG", exif=exif.tobytes())
    before = path.read_bytes()
    assert media.strip(path, "jpeg") == set()
    assert path.read_bytes() == before


def test_unreadable_exif_is_blanked_whole(tmp_path: Path) -> None:
    path = saved(tmp_path, "broken.jpg", format="JPEG", exif=exif_bytes())
    data = bytearray(path.read_bytes())
    start = data.find(b"Exif\x00\x00") + 6
    # The first directory points far outside the block.
    struct.pack_into("<I", data, start + 4, 0x7FFFFFF0)
    path.write_bytes(bytes(data))
    assert media.strip(path, "jpeg") == {media.METADATA}
    after = path.read_bytes()
    assert b"PhoneMaker" not in after and b"SERIAL-4711" not in after
    Image.open(path).load()


def test_a_cut_off_file_does_not_break_the_upload(tmp_path: Path) -> None:
    path = saved(tmp_path, "cut.png", format="PNG", exif=exif_bytes())
    path.write_bytes(path.read_bytes()[:60])
    assert media.strip(path, "png") <= {media.UNCHECKED, media.METADATA}


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def test_a_movie_loses_place_and_device_its_pictures_stay(tmp_path: Path) -> None:
    keys = [b"com.apple.quicktime.location.ISO6709", b"com.apple.quicktime.make", b"com.apple.quicktime.model",
            b"com.apple.quicktime.software"]
    keys_box = box(b"keys", b"\x00\x00\x00\x00" + struct.pack(">I", len(keys))
                   + b"".join(struct.pack(">I", 8 + len(key)) + b"mdta" + key for key in keys))
    values = [b"+52.5200+013.4050+035.000/", b"PhoneMaker", b"PhoneModel", b"17.0"]
    ilst = box(b"ilst", b"".join(
        box(struct.pack(">I", number), box(b"data", b"\x00\x00\x00\x01\x00\x00\x00\x00" + value))
        for number, value in enumerate(values, start=1)
    ))
    meta = box(b"meta", box(b"hdlr", b"\x00" * 8 + b"mdta" + b"\x00" * 13) + keys_box + ilst)
    udta = box(b"udta", box(b"\xa9xyz", b"\x00\x12\x15\xc7+48.8584+002.2945/") + box(b"\xa9mod", b"\x00\x0aOtherModel"))
    trak = box(b"trak", box(b"tkhd", b"\x00" * 84) + box(b"udta", box(b"\xa9xyz", b"\x00\x10\x15\xc7+40.7+074.0/")))
    moov = box(b"moov", box(b"mvhd", b"\x00" * 100) + meta + udta + trak)
    pictures = box(b"mdat", b"FRAMES" * 1000)
    path = tmp_path / "clip.mov"
    path.write_bytes(box(b"ftyp", b"qt  \x00\x00\x02\x00qt  ") + pictures + moov)
    before = path.read_bytes()
    assert media.sniff(before[:64]) == "mov"
    assert media.strip(path, "mov") == {media.LOCATION, media.DEVICE}
    after = path.read_bytes()
    assert len(after) == len(before)
    for secret in (b"+52.5200", b"PhoneMaker", b"PhoneModel", b"+48.8584", b"OtherModel", b"+40.7"):
        assert secret not in after, secret
    assert b"17.0" in after and b"FRAMES" * 1000 in after


GPS_UDTA = box(b"udta", box(b"\xa9xyz", b"\x00\x12\x15\xc7+48.8584+002.2945/"))


def test_a_broken_part_of_a_movie_does_not_keep_the_place_of_the_rest(tmp_path: Path) -> None:
    broken = box(b"ilst", box(struct.pack(">I", 1), box(b"data", b"\x00\x00")))
    keys = box(b"keys", b"\x00\x00\x00\x00" + struct.pack(">I", 1) + struct.pack(">I", 44) + b"mdta"
               + b"com.apple.quicktime.location.ISO6709")
    moov = box(b"moov", box(b"meta", box(b"hdlr", b"\x00" * 8 + b"mdta" + b"\x00" * 13) + keys + broken))
    path = tmp_path / "broken.mov"
    path.write_bytes(box(b"ftyp", b"qt  \x00\x00\x02\x00qt  ") + moov + GPS_UDTA + box(b"mdat", b"x" * 100))
    assert media.strip(path, "mov") == {media.LOCATION, media.UNCHECKED}
    assert b"+48.8584" not in path.read_bytes()


def test_a_movie_header_too_large_to_read_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media, "MAX_MOOV_BYTES", 64)
    path = tmp_path / "big.mp4"
    path.write_bytes(box(b"ftyp", b"isom\x00\x00\x02\x00isom") + box(b"moov", b"\x00" * 100 + GPS_UDTA))
    assert media.UNCHECKED in media.strip(path, "mp4")


def test_free_space_in_a_movie_is_cleared(tmp_path: Path) -> None:
    # A header moved to the front leaves the old one behind in a free box.
    path = tmp_path / "moved.mp4"
    path.write_bytes(box(b"ftyp", b"isom\x00\x00\x02\x00isom") + box(b"moov", b"\x00" * 16) + box(b"free", GPS_UDTA))
    media.strip(path, "mp4")
    assert b"+48.8584" not in path.read_bytes()


@pytest.mark.parametrize(("fmt", "kind"), [("JPEG", "jpeg"), ("HEIF", "heic")])
def test_the_movie_of_a_motion_photo_loses_its_place_too(tmp_path: Path, fmt: str, kind: str) -> None:
    out = io.BytesIO()
    picture().save(out, format=fmt)
    movie = box(b"ftyp", b"isom\x00\x00\x02\x00isom") + box(b"moov", GPS_UDTA) + box(b"mdat", b"frames")
    path = tmp_path / f"motion.{kind}"
    # Samsung writes a marker before the movie that is not a box.
    path.write_bytes(out.getvalue() + b"MotionPhoto_Data" + movie)
    assert media.LOCATION in media.strip(path, kind)
    assert b"+48.8584" not in path.read_bytes() and b"frames" in path.read_bytes()


def test_a_hostile_item_count_does_not_hold_the_upload(tmp_path: Path) -> None:
    import time

    # Twenty million items claimed in a few bytes: without the bound about twenty seconds, with 0xFFFFFFFF hours.
    iloc = box(b"iloc", bytes([2, 0, 0, 0, 0x44, 0x00]) + struct.pack(">I", 20_000_000))
    meta = box(b"meta", b"\x00\x00\x00\x00" + box(b"hdlr", b"\x00" * 24) + iloc)
    path = tmp_path / "loop.heic"
    path.write_bytes(box(b"ftyp", b"heic\x00\x00\x00\x00mif1heic") + meta)
    began = time.monotonic()
    media.strip(path, "heic")
    assert time.monotonic() - began < 1


def test_kinds_are_told_by_content_not_by_name() -> None:
    def png() -> bytes:
        out = io.BytesIO()
        picture().save(out, format="PNG")
        return out.getvalue()

    assert media.sniff(png()[:64]) == "png"
    assert media.sniff(b"%PDF-1.7\n...") == "pdf"
    assert media.sniff(b"<html><script>") is None
    assert media.sniff(b"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf") == "avif"
    assert media.sniff(b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1heic") == "heic"
    assert media.sniff(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2") == "mp4"
