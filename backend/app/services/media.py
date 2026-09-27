"""What a file is, and what an uploaded photo or video tells about where it was taken and with what.

Phones write the place (GPS) and the device (make, model, serial numbers, lens) into every photo and video.
nexlore removes both on upload (the operator can turn that off). Everything else stays, the orientation above all:
a photo taken upright must not come back lying on its side.

Nothing is decoded and encoded again. The metadata is overwritten where it stands, with zeros (binary) or blanks
(XML), so the file keeps its length, every offset inside it stays right, and the picture is byte for byte what the
camera wrote. Where a block of metadata cannot be read with certainty, all of it is blanked: better an image without
its orientation than one that tells where somebody lives.

Covered: JPEG (Exif, XMP, IPTC), PNG (eXIf, XMP), WebP (EXIF, XMP), HEIC/HEIF/AVIF (Exif and XMP items), MP4 and
QuickTime (user data, Apple and Android keys, XMP). GIF and BMP carry no such metadata.
"""

from __future__ import annotations

import logging
import os
import re
import struct
import uuid
import zlib
from pathlib import Path

logger = logging.getLogger("nexlore.media")

LOCATION = "location"
DEVICE = "device"
#: A block that could not be read and was blanked whole.
METADATA = "metadata"
#: Part of the file could not be read (or was too large to read): what could be read was cleaned, the rest may still
#: hold a place or a device. The page says so.
UNCHECKED = "unchecked"

HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1", b"mif2"}
AVIF_BRANDS = {b"avif", b"avis"}
#: Kinds that are pictures a browser shows by itself.
BROWSER_IMAGES = {"jpeg", "png", "gif", "webp", "avif", "bmp"}
VIDEOS = {"mp4", "mov"}
#: Pictures are edited in memory; larger ones are left as they are (and logged).
MAX_IMAGE_BYTES = 256 * 1024 * 1024
#: A movie header larger than this is not read (it would be a very unusual file).
MAX_MOOV_BYTES = 64 * 1024 * 1024


def sniff(head: bytes) -> str | None:
    """The kind of a file by its first bytes (at least 64 of them), never by its name."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM") and len(head) > 14:
        return "bmp"
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head[4:8] == b"ftyp":
        size = struct.unpack(">I", head[:4])[0]
        brands = {head[8:12]} | {head[at : at + 4] for at in range(16, min(size, len(head)) - 3, 4)}
        if brands & AVIF_BRANDS:
            return "avif"
        if brands & HEIF_BRANDS:
            return "heic"
        if head[8:12] == b"qt  ":
            return "mov"
        return "mp4"
    return None


class _Bad(ValueError):
    """A block of metadata that does not read as it should."""


# --- TIFF (the inside of Exif) --------------------------------------------------------------------------------------

_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8}
_GPS = 0x8825
_EXIF = 0x8769
_INTEROP = 0xA005
#: Make, Model, Artist, HostComputer, MakerNote, ImageUniqueID, CameraOwnerName, BodySerialNumber, LensMake,
#: LensModel, LensSerialNumber.
_DEVICE_TAGS = {0x010F, 0x0110, 0x013B, 0x013C, 0x927C, 0xA420, 0xA430, 0xA431, 0xA433, 0xA434, 0xA435}


def _zero(buf: bytearray, start: int, end: int) -> bool:
    """Zeros over a range; whether anything was there. A range given the wrong way round (a broken size field) is
    refused rather than taken as empty."""
    if start < 0 or end < start or end > len(buf):
        raise _Bad
    had = any(buf[start:end])
    buf[start:end] = bytes(end - start)
    return had


def scrub_tiff(buf: bytearray, start: int, end: int) -> set[str]:
    """Remove the place and the device from the TIFF structure in ``buf[start:end]``, in place."""
    if end - start < 8:
        raise _Bad
    order = bytes(buf[start : start + 2])
    if order == b"II":
        fmt = "<"
    elif order == b"MM":
        fmt = ">"
    else:
        raise _Bad

    def u16(at: int) -> int:
        if at < start or at + 2 > end:
            raise _Bad
        return int(struct.unpack_from(fmt + "H", buf, at)[0])

    def u32(at: int) -> int:
        if at < start or at + 4 > end:
            raise _Bad
        return int(struct.unpack_from(fmt + "I", buf, at)[0])

    if u16(start + 2) != 42:
        raise _Bad
    removed: set[str] = set()
    seen: set[int] = set()
    queue: list[tuple[int, str]] = [(u32(start + 4), "main")]
    while queue:
        offset, kind = queue.pop()
        if offset == 0 or offset in seen:
            continue
        if len(seen) > 64:
            raise _Bad
        seen.add(offset)
        at = start + offset
        count = u16(at)
        if count > 2000 or at + 2 + 12 * count + 4 > end:
            raise _Bad
        following = u32(at + 2 + 12 * count)
        for number in range(count):
            entry = at + 2 + 12 * number
            tag, kind_of_value, items = u16(entry), u16(entry + 2), u32(entry + 4)
            size = _TYPE_SIZES.get(kind_of_value)
            if size is None:
                raise _Bad
            length = size * items
            value = entry + 8 if length <= 4 else start + u32(entry + 8)
            if length > 4 and (value < start or value + length > end):
                raise _Bad
            if kind == "gps":
                had = _zero(buf, value, value + length)
                _zero(buf, entry, entry + 12)
                if had:
                    removed.add(LOCATION)
            elif tag == _GPS:
                queue.append((u32(entry + 8), "gps"))
            elif tag in (_EXIF, _INTEROP) and kind_of_value in (4, 13):
                queue.append((u32(entry + 8), "sub"))
            elif tag in _DEVICE_TAGS and _zero(buf, value, value + length):
                removed.add(DEVICE)
        if kind == "gps":
            # No entries left: readers see an empty GPS directory (its entries and values are zeros already).
            struct.pack_into(fmt + "H", buf, at, 0)
        elif kind == "main":
            queue.append((following, "main"))
    return removed


def _scrub_or_blank(buf: bytearray, start: int, end: int) -> set[str]:
    try:
        return scrub_tiff(buf, start, end)
    except _Bad:
        return {METADATA} if _zero(buf, start, end) else set()


# --- XMP ------------------------------------------------------------------------------------------------------------

_XMP_LOCATION = re.compile(rb"gps|location|city|country|latitude|longitude", re.IGNORECASE)
_XMP_DEVICE = re.compile(rb"make|model|serial|lens|owner", re.IGNORECASE)


def blank_xmp(buf: bytearray, start: int, end: int) -> set[str]:
    """An XMP packet that names a place or a device becomes blanks; one that does not stays as it is."""
    packet = bytes(buf[start:end])
    removed = set()
    if _XMP_LOCATION.search(packet):
        removed.add(LOCATION)
    if _XMP_DEVICE.search(packet):
        removed.add(DEVICE)
    if removed:
        buf[start:end] = b" " * (end - start)
    return removed


def _blank_xmp_packets(buf: bytearray, start: int, end: int) -> set[str]:
    removed: set[str] = set()
    at = start
    while True:
        begin = buf.find(b"<x:xmpmeta", at, end)
        if begin < 0:
            return removed
        close = buf.find(b"</x:xmpmeta>", begin, end)
        stop = close + len(b"</x:xmpmeta>") if close >= 0 else end
        removed |= blank_xmp(buf, begin, stop)
        at = stop


# --- Picture formats ------------------------------------------------------------------------------------------------

_XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"
_XMP_EXTENSION = b"http://ns.adobe.com/xmp/extension/\x00"
_PHOTOSHOP = b"Photoshop 3.0\x00"


def _jpeg(buf: bytearray) -> set[str]:
    removed: set[str] = set()
    at = 2
    while at + 4 <= len(buf):
        if buf[at] != 0xFF:
            break
        marker = buf[at + 1]
        if marker == 0xFF:
            at += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            at += 2
            continue
        if marker in (0xDA, 0xD9):  # the picture data begins, or the end
            break
        length = struct.unpack_from(">H", buf, at + 2)[0]
        begin, stop = at + 4, at + 2 + length
        if length < 2 or stop > len(buf):
            break
        if marker == 0xE1 and buf[begin : begin + 6] == b"Exif\x00\x00":
            removed |= _scrub_or_blank(buf, begin + 6, stop)
        elif marker == 0xE1 and buf[begin : begin + len(_XMP_NS)] == _XMP_NS:
            removed |= blank_xmp(buf, begin + len(_XMP_NS), stop)
        elif marker == 0xE1 and buf[begin : begin + len(_XMP_EXTENSION)] == _XMP_EXTENSION:
            removed |= blank_xmp(buf, begin + len(_XMP_EXTENSION), stop)
        elif (
            marker == 0xED
            and buf[begin : begin + len(_PHOTOSHOP)] == _PHOTOSHOP
            and _zero(buf, begin + len(_PHOTOSHOP), stop)
        ):
            # IPTC: city, country, sometimes the photographer. Blanked whole.
            removed.add(METADATA)
        at = stop
    # A motion photo (Pixel, Samsung) carries a whole movie after the picture, with a place of its own.
    return removed | _trailing_movies(buf, at)


def _png(buf: bytearray) -> set[str]:
    removed: set[str] = set()
    at = 8
    while at + 12 <= len(buf):
        length = struct.unpack_from(">I", buf, at)[0]
        kind = bytes(buf[at + 4 : at + 8])
        begin, stop = at + 8, at + 8 + length
        if stop + 4 > len(buf):
            break
        found: set[str] = set()
        if kind == b"eXIf":
            found = _scrub_or_blank(buf, begin, stop)
        elif kind in (b"iTXt", b"tEXt", b"zTXt"):
            keyword_end = buf.find(b"\x00", begin, stop)
            keyword = bytes(buf[begin:keyword_end]) if keyword_end >= 0 else b""
            if keyword == b"XML:com.adobe.xmp":
                # iTXt: keyword, NUL, compression flag, method, language, NUL, translated keyword, NUL, text.
                compressed = kind != b"tEXt" and keyword_end + 1 < stop and buf[keyword_end + 1] == 1
                if compressed or kind == b"zTXt":
                    found = {METADATA} if _zero(buf, keyword_end + 1, stop) else set()
                else:
                    found = _blank_xmp_packets(buf, keyword_end + 1, stop)
            elif keyword.lower().startswith(b"raw profile type"):
                # ImageMagick keeps Exif as hex text here.
                found = {METADATA} if _zero(buf, keyword_end + 1, stop) else set()
        elif kind == b"IEND":
            break
        if found:
            removed |= found
            struct.pack_into(">I", buf, stop, zlib.crc32(buf[at + 4 : stop]) & 0xFFFFFFFF)
        at = stop + 4
    return removed


def _webp(buf: bytearray) -> set[str]:
    removed: set[str] = set()
    end = min(len(buf), 8 + struct.unpack_from("<I", buf, 4)[0])
    at = 12
    while at + 8 <= end:
        kind = bytes(buf[at : at + 4])
        size = struct.unpack_from("<I", buf, at + 4)[0]
        begin, stop = at + 8, at + 8 + size
        if stop > end:
            break
        if kind == b"EXIF":
            skip = 6 if buf[begin : begin + 6] == b"Exif\x00\x00" else 0
            removed |= _scrub_or_blank(buf, begin + skip, stop)
        elif kind == b"XMP ":
            removed |= blank_xmp(buf, begin, stop)
        at = stop + (size & 1)
    return removed


def _boxes(buf: bytes | bytearray, start: int, end: int) -> list[tuple[bytes, int, int, int]]:
    """ISO base media boxes between ``start`` and ``end``: (type, box start, content start, box end)."""
    found = []
    at = start
    while at + 8 <= end:
        size = struct.unpack_from(">I", buf, at)[0]
        kind = bytes(buf[at + 4 : at + 8])
        header = 8
        if size == 1:
            if at + 16 > end:
                break
            size = struct.unpack_from(">Q", buf, at + 8)[0]
            header = 16
        elif size == 0:
            size = end - at
        if size < header or at + size > end:
            break
        found.append((kind, at, at + header, at + size))
        at += size
    return found


def _heif(buf: bytearray) -> set[str]:
    """HEIC, HEIF and AVIF keep Exif and XMP as items: found through the item list and their places in the file."""
    meta = next((box for box in _boxes(buf, 0, len(buf)) if box[0] == b"meta"), None)
    if meta is None:
        return set()
    children = _boxes(buf, meta[2] + 4, meta[3])  # meta is a full box: version and flags first
    items: dict[int, bytes] = {}
    extents: dict[int, list[tuple[int, int, int]]] = {}
    idat = next((box for box in children if box[0] == b"idat"), None)
    for kind, _box, content, stop in children:
        if kind == b"iinf":
            version = buf[content]
            first = content + 4 + (2 if version == 0 else 4)
            for entry_kind, _eb, entry, entry_end in _boxes(buf, first, stop):
                if entry_kind != b"infe" or buf[entry] < 2:
                    continue
                wide = buf[entry] >= 3
                item_id = struct.unpack_from(">I" if wide else ">H", buf, entry + 4)[0]
                type_at = entry + 4 + (4 if wide else 2) + 2
                item_type = bytes(buf[type_at : type_at + 4])
                if item_type == b"mime":
                    # The item's name, then its content type, both ending in a NUL.
                    name_end = buf.find(b"\x00", type_at + 4, entry_end)
                    type_end = buf.find(b"\x00", name_end + 1, entry_end) if name_end >= 0 else -1
                    content_type = bytes(buf[name_end + 1 : type_end]) if type_end >= 0 else b""
                    if b"rdf+xml" in content_type.lower() or b"xmp" in content_type.lower():
                        items[item_id] = b"xmp"
                elif item_type == b"Exif":
                    items[item_id] = b"Exif"
        elif kind == b"iloc":
            version = buf[content]
            sizes = buf[content + 4]
            offset_size, length_size = sizes >> 4, sizes & 15
            more = buf[content + 5]
            base_size, index_size = more >> 4, (more & 15) if version in (1, 2) else 0
            at = content + 6
            count = struct.unpack_from(">H" if version < 2 else ">I", buf, at)[0]
            at += 2 if version < 2 else 4

            def number(width: int, position: int) -> int:
                return int.from_bytes(buf[position : position + width], "big") if width else 0

            for _ in range(count):
                # The count comes from the file: the box's end bounds the loop, not the number.
                if at >= stop:
                    break
                item_id = number(2 if version < 2 else 4, at)
                at += 2 if version < 2 else 4
                method = 0
                if version in (1, 2):
                    method = number(2, at) & 15
                    at += 2
                at += 2  # data reference index
                base = number(base_size, at)
                at += base_size
                extent_count = number(2, at)
                at += 2
                for _extent in range(extent_count):
                    if at >= stop:
                        break
                    at += index_size
                    offset = number(offset_size, at)
                    at += offset_size
                    length = number(length_size, at)
                    at += length_size
                    extents.setdefault(item_id, []).append((method, base + offset, length))
    removed: set[str] = set()
    for item_id, item_kind in items.items():
        for method, offset, length in extents.get(item_id, []):
            if method == 1 and idat is not None:
                start = idat[2] + offset
            elif method == 0:
                start = offset
            else:
                continue
            stop = min(len(buf), start + length) if length else len(buf)
            if start >= stop:
                continue
            if item_kind == b"Exif":
                # The item starts with the distance to the TIFF header ("Exif\0\0" usually sits in between).
                skip = struct.unpack_from(">I", buf, start)[0] if stop - start >= 4 else 0
                removed |= _scrub_or_blank(buf, start + 4 + skip, stop)
            else:
                removed |= blank_xmp(buf, start, stop)
    # Boxes of a movie among the picture's (a motion photo), and a movie appended after them.
    return removed | _scrub_boxes(buf, 0, len(buf)) | _trailing_movies(buf, 12)


# --- Movies ---------------------------------------------------------------------------------------------------------

_XMP_UUID = uuid.UUID("be7acfcb-97a9-42e8-9c71-999491e3afac").bytes
#: QuickTime user data: place (©xyz, 3GPP loci) and device (©mak, ©mod).
_UDTA_LOCATION = {b"\xa9xyz", b"loci"}
_UDTA_DEVICE = {b"\xa9mak", b"\xa9mod"}
_KEY_LOCATION = re.compile(rb"location", re.IGNORECASE)
_KEY_DEVICE = re.compile(rb"\.(make|model|manufacturer|lens_model|camera\.identifier)$", re.IGNORECASE)
_CONTAINERS = {b"moov", b"trak", b"udta", b"mdia", b"minf", b"edts"}


def _meta_children(buf: bytearray, content: int, stop: int) -> int:
    """Where the boxes inside ``meta`` start: MP4 writes it as a full box, QuickTime does not."""
    if buf[content + 4 : content + 8] in (b"hdlr", b"keys", b"ilst"):
        return content
    return content + 4


def _scrub_meta(buf: bytearray, content: int, stop: int) -> set[str]:
    removed: set[str] = set()
    children = _boxes(buf, _meta_children(buf, content, stop), stop)
    private: dict[int, str] = {}
    for kind, _box, inner, end in children:
        if kind == b"keys":
            count = struct.unpack_from(">I", buf, inner + 4)[0]
            at = inner + 8
            for number in range(1, count + 1):
                if at + 8 > end:
                    break
                size = struct.unpack_from(">I", buf, at)[0]
                key = bytes(buf[at + 8 : at + size])
                if _KEY_LOCATION.search(key):
                    private[number] = LOCATION
                elif _KEY_DEVICE.search(key):
                    private[number] = DEVICE
                at += max(size, 8)
    for kind, _box, inner, end in children:
        if kind == b"ilst":
            for item_kind, _ib, item_inner, item_end in _boxes(buf, inner, end):
                number = struct.unpack(">I", item_kind)[0]
                if number in private:
                    for data_kind, _db, data_inner, data_end in _boxes(buf, item_inner, item_end):
                        # A data box: type and locale (8 bytes), then the value.
                        if data_kind == b"data" and _zero(buf, data_inner + 8, data_end):
                            removed.add(private[number])
                elif item_kind in _UDTA_LOCATION and _zero(buf, item_inner, item_end):
                    removed.add(LOCATION)
    return removed


def _scrub_boxes(buf: bytearray, start: int, end: int) -> set[str]:
    removed: set[str] = set()
    for kind, _box, content, stop in _boxes(buf, start, end):
        if kind in _CONTAINERS:
            removed |= _scrub_boxes(buf, content, stop)
        elif kind == b"meta":
            removed |= _scrub_meta(buf, content, stop)
        elif kind in _UDTA_LOCATION:
            if _zero(buf, content, stop):
                removed.add(LOCATION)
        elif kind in _UDTA_DEVICE:
            if _zero(buf, content, stop):
                removed.add(DEVICE)
        elif kind == b"uuid" and buf[content : content + 16] == _XMP_UUID:
            removed |= blank_xmp(buf, content + 16, stop)
        elif kind in _PADDING:
            # Free space may still hold an old movie header, from before the file was rearranged.
            _zero(buf, content, stop)
    return removed


_PADDING = {b"free", b"skip"}


def _trailing_movies(buf: bytearray, start: int) -> set[str]:
    """A movie appended to a picture (a motion photo): found by its ``ftyp`` box, cleaned like a movie."""
    removed: set[str] = set()
    at = start
    while (found := buf.find(b"ftyp", at)) >= 0:
        begin = found - 4
        brand = bytes(buf[found + 4 : found + 8])
        if begin >= start and re.fullmatch(rb"[0-9A-Za-z ]{4}", brand):
            size = struct.unpack_from(">I", buf, begin)[0]
            if 8 <= size <= len(buf) - begin:
                removed |= _scrub_boxes(buf, begin, len(buf))
        at = found + 4
    return removed


#: Top-level boxes of a movie that can hold a place or a device; everything else (the pictures) stays on disk.
_MOVIE_TOP = {b"moov", b"uuid", b"meta", b"udta"} | _PADDING


def _movie(path: Path) -> set[str]:
    """Only the movie header (``moov``) and other small top-level boxes are read and written, one after another;
    one that cannot be read or is too large is reported (``unchecked``), the others are still cleaned."""
    removed: set[str] = set()
    size = path.stat().st_size
    with open(path, "r+b") as handle:
        at = 0
        while at + 8 <= size:
            handle.seek(at)
            header = handle.read(16)
            box_size = struct.unpack_from(">I", header, 0)[0]
            kind = header[4:8]
            if box_size == 1:
                box_size = struct.unpack_from(">Q", header, 8)[0]
            elif box_size == 0:
                box_size = size - at
            if box_size < 8 or at + box_size > size:
                removed.add(UNCHECKED)
                break
            if kind in _MOVIE_TOP and box_size > MAX_MOOV_BYTES:
                if kind not in _PADDING:
                    logger.warning("Movie header too large to check for location, left as it is")
                    removed.add(UNCHECKED)
            elif kind in _MOVIE_TOP:
                handle.seek(at)
                original = handle.read(box_size)
                buf = bytearray(original)
                try:
                    removed |= _scrub_boxes(buf, 0, len(buf))
                except (struct.error, ValueError, IndexError):
                    removed.add(UNCHECKED)
                # What was cleaned before a broken part is kept: zeros never make a movie unreadable.
                if buf != original:
                    handle.seek(at)
                    handle.write(buf)
            at += box_size
    return removed


# --- The way in -----------------------------------------------------------------------------------------------------

_PICTURES = {"jpeg": _jpeg, "png": _png, "webp": _webp, "heic": _heif, "avif": _heif}


def strip(path: Path, kind: str | None) -> set[str]:
    """Remove place and device from the file at ``path``, in place. Returns what was removed (``location``,
    ``device``, ``metadata``). A file that is none of the known kinds is left alone."""
    if kind in VIDEOS:
        try:
            return _movie(path)
        except (OSError, struct.error, ValueError, IndexError) as exc:
            logger.warning("Could not check a movie for its location: %s", type(exc).__name__)
            return {UNCHECKED}
    handler = _PICTURES.get(kind or "")
    if handler is None:
        return set()
    size = path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        logger.warning("Picture too large to check for its location, left as it is bytes=%s", size)
        return {UNCHECKED}
    original = path.read_bytes()
    buf = bytearray(original)
    try:
        removed = handler(buf)
    except (struct.error, ValueError, IndexError) as exc:
        logger.warning("Could not read a picture's metadata to the end: %s", type(exc).__name__)
        # What was cleaned before the broken part is kept: zeros in metadata never break a picture.
        removed = {UNCHECKED}
    if buf != original:
        with open(path, "r+b") as handle:
            handle.write(buf)
            handle.flush()
            os.fsync(handle.fileno())
    return removed


def to_webp(source: Path, target: Path) -> bool:
    """A WebP of a picture browsers cannot show (HEIC), turned upright, without any metadata. False when the
    picture cannot be read. Pillow refuses pictures of absurd pixel counts by itself (decompression bombs); a file
    larger than any photo is not even opened."""
    if source.stat().st_size > MAX_IMAGE_BYTES:
        return False
    try:
        import pillow_heif
        from PIL import Image, ImageOps

        pillow_heif.register_heif_opener()
        with Image.open(source) as image:
            upright = ImageOps.exif_transpose(image)
            profile = image.info.get("icc_profile")
            options: dict[str, object] = {"quality": 85, "method": 4, "exif": b"", "xmp": b""}
            if profile:
                options["icc_profile"] = profile
            upright.save(target, "WEBP", **options)
        return True
    except Exception as exc:  # noqa: BLE001 - a broken or hostile picture fails in the decoder's own way
        logger.warning("Could not make a WebP of a picture: %s", type(exc).__name__)
        return False
