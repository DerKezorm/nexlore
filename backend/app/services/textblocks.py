"""The block layer on the server: text written from outside the editor keeps what it did not change, byte for byte.

The editor in the browser has its own (``frontend/src/editor/blocks.ts``). Writes that come another way, an AI
over MCP or a plugin, send the whole new text of a note. Such a writer normalises what it did not mean to touch:
Windows line endings become ``\\n``, a byte order mark goes, trailing spaces vanish, the last line loses its line
break. So the new text is laid over the old one line by line: every line that is the same (compared without its line
ending and trailing spaces) comes from the old file exactly as it was; only changed and new lines take the new text,
with the file's own line endings. A note that did not change at all comes back identical.
"""

from __future__ import annotations

from difflib import SequenceMatcher

BOM = b"\xef\xbb\xbf"


def _key(line: str) -> str:
    return line.rstrip("\r\n").rstrip()


def _lines(text: str) -> list[str]:
    """Lines with their endings; the last one without, when the text does not end with a line break."""
    return text.splitlines(keepends=True)


def keep_unchanged(original: bytes, new_text: str) -> bytes:
    """``new_text`` as the file's bytes, with every unchanged line taken from ``original``. ``original`` must be
    UTF-8 (a note that is not is read only, never written from text)."""
    bom = original.startswith(BOM)
    old_text = original[len(BOM) :].decode("utf-8") if bom else original.decode("utf-8")
    newline = "\r\n" if "\r\n" in old_text else "\n"
    old_lines = _lines(old_text)
    normal = new_text.replace("\r\n", "\n").replace("\r", "\n")
    normal = normal.removeprefix("\ufeff")
    new_lines = [line[:-1] + newline if line.endswith("\n") else line for line in _lines(normal)]
    matcher = SequenceMatcher(None, [_key(line) for line in old_lines], [_key(line) for line in new_lines],
                              autojunk=False)
    pieces: list[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        pieces += old_lines[i1:i2] if tag == "equal" else new_lines[j1:j2]
    out: list[str] = []
    for index, piece in enumerate(pieces):
        # An old last line without a line break, now followed by more: it gets one.
        if index < len(pieces) - 1 and not piece.endswith(("\n", "\r")):
            piece += newline
        out.append(piece)
    # The file ended with a line break: it still does, even where the writer dropped it from a changed last line.
    if out and old_text.endswith("\n") and not out[-1].endswith("\n"):
        out[-1] += newline
    data = "".join(out).encode("utf-8")
    return BOM + data if bom else data
