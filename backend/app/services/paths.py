"""Paths inside the vault, and file names that work on Windows, macOS and Linux.

Every path the API hands over is a POSIX string relative to the vault, its first part the space:
``Research/Reading/Some note.md``. Two levels of checking:

* ``parse`` for addressing: no way out of the vault, no hidden parts, no control characters. A file somebody else
  created (Obsidian on Linux, Syncthing) may carry a name nexlore would never choose, and it must still be readable.
* ``check_name`` for what nexlore creates or renames to: only names every system can hold, so that a vault synced
  between a Linux server and a Windows laptop never meets a file one side cannot write.

``resolve`` turns a parsed path into a real one and refuses anything that leaves the vault on the way, a symlink or a
Windows junction included.
"""

from __future__ import annotations

import os
import re
import unicodedata
from pathlib import Path, PurePosixPath

from ..config import get_settings

NOTE_SUFFIX = ".md"
#: Longest name of one part, in bytes of UTF-8. Most file systems stop at 255.
MAX_PART_BYTES = 255
#: Longest relative path, in characters.
MAX_PATH_CHARS = 1024
#: What Windows forbids in a name, plus what breaks a wiki link: ``[[a#b|c]]`` and ``^block`` are syntax.
FORBIDDEN = set('<>:"/\\|?*') | set("[]#^")
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
UNTITLED = "Untitled"


class PathError(ValueError):
    """A path or name that nexlore refuses. ``code`` goes to the client, the text to the log."""

    def __init__(self, code: str, text: str) -> None:
        super().__init__(text)
        self.code = code


def vault_root() -> Path:
    root = get_settings().vault_dir
    assert root is not None
    return root


def is_hidden(part: str) -> bool:
    """Dot folders and dot files belong to other programs (``.obsidian``, ``.git``, ``.trash``) or to nexlore's own
    temporary files. The scanner skips them and the API does not reach them."""
    return part.startswith(".")


def parse(raw: str) -> str:
    """A relative path from outside, normalised, or ``PathError``."""
    if not isinstance(raw, str) or not raw:
        raise PathError("path_invalid", "empty path")
    # Not normalised: the disk compares names byte for byte, and a name macOS wrote decomposed (NFD) must be
    # addressed exactly as it lies there. Comparisons go through ``fold``.
    text = raw
    if _CONTROL.search(text):
        raise PathError("path_invalid", "control character in path")
    if "\\" in text:
        raise PathError("path_invalid", "backslash in path")
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise PathError("path_invalid", "absolute path")
    if len(text) > MAX_PATH_CHARS:
        raise PathError("path_too_long", "path too long")
    parts = text.split("/")
    for part in parts:
        if part in ("", ".", ".."):
            raise PathError("path_invalid", "empty or relative part in path")
        if is_hidden(part):
            raise PathError("path_invalid", "hidden part in path")
        if len(part.encode("utf-8")) > MAX_PART_BYTES:
            raise PathError("path_too_long", "name too long")
    return "/".join(parts)


def check_name(name: str) -> str:
    """A single name nexlore may create: portable on every system. Returns it NFC-normalised."""
    name = unicodedata.normalize("NFC", name)
    if not name or name in (".", ".."):
        raise PathError("name_invalid", "empty name")
    if is_hidden(name):
        raise PathError("name_invalid", "name starts with a dot")
    if _CONTROL.search(name) or any(char in FORBIDDEN for char in name):
        raise PathError("name_invalid", "name contains a forbidden character")
    if name != name.rstrip(" .") or name != name.lstrip(" "):
        raise PathError("name_invalid", "name starts with a space or ends with a space or dot")
    if name.split(".")[0].upper().rstrip(" ") in RESERVED:
        raise PathError("name_invalid", "name reserved on Windows")
    if len(name.encode("utf-8")) > MAX_PART_BYTES:
        raise PathError("path_too_long", "name too long")
    return name


def portable_problem(name: str) -> str | None:
    """Why a name found on disk would not survive on another system, or ``None``. For the import report."""
    try:
        check_name(name)
    except PathError as exc:
        return str(exc)
    if name != unicodedata.normalize("NFC", name):
        return "name is not NFC-normalised"
    return None


def safe_name(title: str, suffix: str = NOTE_SUFFIX) -> str:
    """A file name for a title. The title may hold anything; the name keeps what every system allows.

    Forbidden characters become a space, runs of spaces one, a reserved name gets an underscore, and the name is cut
    to fit the byte limit without splitting a character.
    """
    text = unicodedata.normalize("NFC", title)
    text = "".join(" " if char in FORBIDDEN or _CONTROL.match(char) else char for char in text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    if not text:
        text = UNTITLED
    if text.split(".")[0].upper() in RESERVED:
        text += "_"
    budget = MAX_PART_BYTES - len(suffix.encode("utf-8"))
    while len(text.encode("utf-8")) > budget:
        text = text[:-1]
    text = text.rstrip(" .") or UNTITLED
    return text + suffix


def fold(name: str) -> str:
    """How two names compare on a case-insensitive system (Windows, macOS): casefolded and NFC."""
    return unicodedata.normalize("NFC", name).casefold()


def unique_name(directory: Path, name: str, *, taken: set[str] | None = None) -> str:
    """``name``, or ``name 2``, ``name 3`` … so that no file in ``directory`` differs from it only in case."""
    existing = {fold(entry) for entry in os.listdir(directory)} if directory.is_dir() else set()
    if taken:
        existing |= {fold(entry) for entry in taken}
    base, ending = os.path.splitext(name)
    candidate = name
    number = 2
    while fold(candidate) in existing:
        candidate = f"{base} {number}{ending}"
        number += 1
    return candidate


def _is_link(path: Path) -> bool:
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def resolve(rel: str, *, root: Path | None = None) -> Path:
    """The real path of a parsed relative path. Refuses a symlink or junction anywhere on the way."""
    base = root or vault_root()
    path = base.joinpath(*PurePosixPath(rel).parts)
    current = base
    for part in PurePosixPath(rel).parts:
        current = current / part
        if _is_link(current):
            raise PathError("path_invalid", "path runs through a link")
        if not current.exists():
            break
    real_root = os.path.normcase(os.path.realpath(base))
    real = os.path.normcase(os.path.realpath(path))
    if real != real_root and not real.startswith(real_root + os.sep):
        raise PathError("path_invalid", "path leaves the vault")
    return path


def relative(path: Path, *, root: Path | None = None) -> str:
    """The vault-relative POSIX form of a real path below the vault."""
    base = root or vault_root()
    return path.relative_to(base).as_posix()


def space_of(rel: str) -> str:
    return rel.split("/", 1)[0]


def is_note(rel: str) -> bool:
    return rel.lower().endswith(NOTE_SUFFIX)


def stem(rel: str) -> str:
    """The name without folder and without ``.md``; other files keep their extension (Obsidian links them so)."""
    name = rel.rsplit("/", 1)[-1]
    return name[: -len(NOTE_SUFFIX)] if is_note(name) else name
