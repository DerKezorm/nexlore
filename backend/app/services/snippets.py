"""
Search snippets as text: the index holds the Markdown of a note, and a snippet cut from it showed "**Graph**" with its
stars. Here the marks of Markdown and of Obsidian go, the words stay, and so do the hit marks (control characters that
note text never contains). A snippet may start or end inside a construct; what is left of one is taken as text.
"""
from __future__ import annotations

import re

_WIKI = re.compile(r"!?\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]")
_LINK = re.compile(r"!?\[([^\]\n]*)\]\([^)\n]*\)")
_CALLOUT = re.compile(r"\[![\w-]+\][+-]?")
_LINE_START = re.compile(r"(?m)^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?)+")
_PAIRS = re.compile(r"\*\*|__|==|~~|%%|`+")
_STAR = re.compile(r"(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])")
_UNDER = re.compile(r"(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])")
_SPACE = re.compile(r"\s+")


def _wiki(match: re.Match[str]) -> str:
    target, alias = match.group(1), match.group(2)
    if alias is not None and alias.strip():
        return alias
    # "Note#Heading" reads as "Note › Heading", as the editor shows it.
    name = target.rsplit("/", 1)[-1]
    name = re.sub(r"\.md$", "", name, flags=re.IGNORECASE)
    return name.replace("#^", " › ").replace("#", " › ")


def plain(snippet: str) -> str:
    """The snippet without the syntax of Markdown, on one line."""
    out = _WIKI.sub(_wiki, snippet)
    out = _LINK.sub(r"\1", out)
    out = _CALLOUT.sub("", out)
    out = _LINE_START.sub("", out)
    out = _PAIRS.sub("", out)
    out = _STAR.sub(r"\1", out)
    out = _UNDER.sub(r"\1", out)
    return _SPACE.sub(" ", out).strip()
