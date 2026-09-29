"""One property of a note's front matter set to a new value, the rest of the file byte for byte as it was: for a cell
changed in a view (``routers/bases``). The property's own line (and its list lines below it) is written anew; a new
property goes last; a note without front matter gets one. Line ends stay as the file has them.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

KEY = re.compile(r"^[^\s:#\-\[\]{},&*!|>'\"%@`][^:\n]*$")


def _scalar(value: Any) -> str:
    if value is None:
        return ""
    dumped = yaml.safe_dump(value, default_flow_style=True, allow_unicode=True, width=10_000).strip()
    return dumped.removesuffix("\n...").removesuffix("...").strip()


def set_property(content: str, key: str, value: Any) -> str:
    if not KEY.match(key) or len(key) > 100:
        raise ValueError("not a property name")
    newline = "\r\n" if "\r\n" in content else "\n"
    bom = "\ufeff" if content.startswith("\ufeff") else ""
    body = content[len(bom) :]
    line = f"{key}: {_scalar(value)}".rstrip()
    lines = body.split(newline)
    if lines and lines[0].strip() == "---":
        end = next((index for index in range(1, len(lines)) if lines[index].strip() in ("---", "...")), None)
        if end is not None:
            for index in range(1, end):
                current = lines[index]
                name = (
                    current.split(":", 1)[0].strip()
                    if ":" in current and not current.startswith((" ", "\t", "-"))
                    else None
                )
                if name is not None and name.strip("'\"") == key:
                    stop = index + 1
                    # The list lines and the folded lines of the old value go with it.
                    while stop < end and (lines[stop].startswith((" ", "\t")) or lines[stop].lstrip().startswith("- ")):
                        stop += 1
                    lines[index:stop] = [line]
                    return bom + newline.join(lines)
            lines.insert(end, line)
            return bom + newline.join(lines)
    return bom + newline.join(["---", line, "---", ""]) + body
