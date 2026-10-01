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
#: A wiki link cut off by the end of the snippet (`[[Beta…`): its words, not its brackets.
_OPEN_WIKI = re.compile(r"!?\[\[(?=[^\]\n]*$)")


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
    out = _OPEN_WIKI.sub("", out)
    out = _LINK.sub(r"\1", out)
    out = _CALLOUT.sub("", out)
    out = _LINE_START.sub("", out)
    out = _PAIRS.sub("", out)
    out = _STAR.sub(r"\1", out)
    out = _UNDER.sub(r"\1", out)
    return _SPACE.sub(" ", out).strip()


def without_title(snippet: str, title: str) -> str:
    """The snippet without the note's title at its start (its first heading, shown right above it already)."""
    plain = snippet.replace("\x02", "").replace("\x03", "")
    if not title or not plain.casefold().startswith(title.casefold()):
        return snippet
    # Walk the marked text until as many visible characters as the title has are behind.
    seen = 0
    for position, char in enumerate(snippet):
        if char in "\x02\x03":
            continue
        seen += 1
        if seen == len(title):
            rest = snippet[position + 1 :]
            opened = snippet[: position + 1].count("\x02") > snippet[: position + 1].count("\x03")
            return (("\x02" if opened else "") + rest).lstrip(" :.-") or snippet
    return snippet
