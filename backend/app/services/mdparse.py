"""What the index needs from a note: front matter, tags, links with their exact place, headings, a count of the
Obsidian and plugin features the import report names.

The block structure comes from markdown-it, a CommonMark parser like micromark under remark, which the editor uses.
Both agree on what counts as code, so a ``[[link]]`` inside a code block is a link for neither. Wiki links, embeds,
tags and comments are Obsidian's own syntax and are found in the text that is left after masking: code blocks, HTML
blocks, inline code and ``%% comments %%`` are replaced by spaces of the same length, so every offset found in the
masked text is the offset in the file. Renaming rewrites links at exactly these offsets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote

import yaml
from markdown_it import MarkdownIt

WIKI = "wiki"
EMBED = "embed"
MARKDOWN = "md"
MARKDOWN_EMBED = "md_embed"

#: Blocks only. Inline parsing costs most of the time and the inline syntax that matters is found by hand below.
_BLOCKS = MarkdownIt("commonmark").enable("table").disable("inline")

_FRONT_OPEN = re.compile(r"\A---[ \t]*\r?\n")
_FRONT_CLOSE = re.compile(r"^(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)", re.MULTILINE)
_LINE_BREAK = re.compile(r"\r\n?|\n")
_NOT_NEWLINE = re.compile(r"[^\r\n]")
_BACKTICKS = re.compile(r"(?<!\\)`+")
_BLANK_LINE = re.compile(r"\n[ \t]*\r?\n")
_COMMENT = re.compile(r"%%.*?%%", re.DOTALL)
_WIKI = re.compile(r"(!?)\[\[([^\[\]\r\n]+?)\]\]")
_MD_LINK = re.compile(
    r"(!?)\[((?:[^\[\]\r\n]|\[[^\[\]\r\n]*\])*)\]"  # label, one level of brackets inside
    r"\(\s*(<[^<>\r\n]*>|(?:[^\s()<>]|\([^\s()]*\))+)"  # destination
    r"(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^()]*\)))?\s*\)"  # title
)
#: ``[label]: target``; ``[^1]: text`` is a footnote (Obsidian), not a link to a note called "text".
_REFERENCE = re.compile(r"^ {0,3}\[(?!\^)([^\]\r\n]+)\]:[ \t]*(<[^<>\r\n]*>|\S+)", re.MULTILINE)
_TAG = re.compile(r"(?:(?<=\s)|^)#([\w/-]+)", re.MULTILINE)
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_CALLOUT = re.compile(r"^[ \t]*(?:>[ \t]*)+\[!([\w-]+)\]", re.MULTILINE)
_HIGHLIGHT = re.compile(r"==[^=\r\n]+==")
_INLINE_FIELD = re.compile(r"^[ \t]*(?:[-*+][ \t]+)?[\w][\w -]*::[ \t]", re.MULTILINE)
_TASK = re.compile(r"^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+\[(.)\](?:[ \t]|$)", re.MULTILINE)
_MATH_SPAN = re.compile(r"\$\$.+?\$\$", re.DOTALL)

#: Only when one of these can be in a note does markdown-it have to look at it: a fence, a line indented as code, an
#: HTML block. Most notes have none of them and skip the block parser, which costs most of the time.
_NEEDS_BLOCKS = re.compile(r"```|~~~|^(?:[ \t]*>)*(?: {4}|\t)|^ {0,3}(?:>[ \t]?)*<[A-Za-z/!?]", re.MULTILINE)
#: ATX headings, also inside quotes and callouts. Setext headings (underlined) are not collected.
#: The rest of the line taken whole; the closing #s come off by hand (``_heading_text``). A lazy middle with an
#: optional closing tried every blank as the end: 8,000 characters took 0.8 s, a long line hours (review before 1.0.0).
_HEADING = re.compile(r"^ {0,3}(?:>[ \t]?)*(#{1,6})(?:[ \t]+([^\n]*))?[ \t]*$", re.MULTILINE)
_YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

#: Code block languages that belong to plugins; their content is shown as code and never touched.
#: Code blocks of plugins, by language. A ```tasks block is a query of the Tasks plugin (``tasks`` counts task lines).
PLUGIN_BLOCKS = {"dataview": "dataview", "dataviewjs": "dataviewjs", "tasks": "tasks_queries", "query": "query"}


@dataclass(slots=True)
class LinkRef:
    kind: str
    #: The path part as written, decoded for Markdown links: ``Folder/Note`` of ``[[Folder/Note#Part|shown]]``.
    target: str
    #: ``#Heading`` or ``#^block``, without the ``#``; empty when there is none.
    subpath: str
    #: Where the whole link sits in the file, and where exactly its path part sits (what a rename replaces).
    start: int
    end: int
    target_start: int
    target_end: int
    line: int
    #: For Markdown links: the destination was in ``<…>``, or percent-encoded. A rewrite keeps the style.
    angle: bool = False
    encoded: bool = False


@dataclass(slots=True)
class Parsed:
    front: dict[str, Any] | None = None
    front_error: str | None = None
    #: Offset where the body starts, after the front matter.
    body_start: int = 0
    title: str | None = None
    tags: list[str] = field(default_factory=list)
    #: Where each ``#tag`` stands in the body (without the ``#``), every one, not only the first of a name.
    tag_spans: list[tuple[int, int]] = field(default_factory=list)
    links: list[LinkRef] = field(default_factory=list)
    headings: list[tuple[int, str]] = field(default_factory=list)
    body: str = ""
    features: dict[str, int] = field(default_factory=dict)
    #: Where ``%%…%%`` comments stand (start, end): hidden in reading, left out of anything public.
    comments: list[tuple[int, int]] = field(default_factory=list)
    #: Lines with a checkbox outside code and comments: (line number from 1, the line as written, without its end).
    task_lines: list[tuple[int, str]] = field(default_factory=list)
    #: The text with the front matter, code, comments, formulas and links blanked (spaces, line breaks kept): where
    #: a note's name stands as a plain word. Offsets and lines are those of the file.
    prose: str = ""


def _mask(text: str, spans: list[tuple[int, int]]) -> str:
    """``text`` with each span replaced by spaces, line breaks kept, so offsets and lines stay where they were."""
    if not spans:
        return text
    spans.sort()
    pieces: list[str] = []
    position = 0
    for start, end in spans:
        if end <= position:
            continue
        start = max(start, position)
        pieces.append(text[position:start])
        pieces.append(_NOT_NEWLINE.sub(" ", text[start:end]))
        position = end
    pieces.append(text[position:])
    return "".join(pieces)


def _line_starts(text: str) -> list[int]:
    starts = [0]
    starts.extend(match.end() for match in _LINE_BREAK.finditer(text))
    return starts


#: What front matter may unfold to. YAML aliases let a few hundred bytes stand for millions of values (nine lists of
#: nine references to the one before), and an alias may point at itself; Obsidian's properties never need either.
FRONT_MAX_VALUES = 10_000
FRONT_MAX_DEPTH = 32


class TooBig(Exception):
    pass


def unfolded(value: Any) -> Any:
    """A copy of the loaded YAML as plain values, refused when it unfolds beyond the limits above."""
    budget = [FRONT_MAX_VALUES]

    def copy(item: Any, depth: int) -> Any:
        budget[0] -= 1
        if budget[0] < 0 or depth > FRONT_MAX_DEPTH:
            raise TooBig
        if isinstance(item, dict):
            return {key: copy(inner, depth + 1) for key, inner in item.items()}
        if isinstance(item, list | tuple):
            return [copy(inner, depth + 1) for inner in item]
        return item

    return copy(value, 0)


def _front_matter(text: str, parsed: Parsed) -> None:
    opening = _FRONT_OPEN.match(text)
    if not opening:
        return
    closing = _FRONT_CLOSE.search(text, opening.end())
    if not closing:
        return
    parsed.body_start = closing.end()
    raw = text[opening.end() : closing.start()]
    try:
        value = yaml.load(raw, Loader=_YAML_LOADER) if raw.strip() else {}
        value = unfolded(value)
    except yaml.YAMLError as exc:
        parsed.front_error = str(exc).splitlines()[0][:200]
        return
    except (RecursionError, TooBig):
        parsed.front_error = "front matter is nested too deeply or too large"
        return
    if isinstance(value, dict):
        parsed.front = {str(key): item for key, item in value.items()}
    elif value is not None:
        parsed.front_error = "front matter is not a mapping"


def _front_list(value: Any) -> list[str]:
    """Obsidian takes a list, or one string separated by commas or spaces."""
    if value is None:
        return []
    if isinstance(value, str):
        return [part for part in re.split(r"[,\s]+", value) if part]
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item).strip()]
    return [str(value)]


def _inline_code(text: str) -> list[tuple[int, int]]:
    """Code spans: a run of backticks up to the next run of the same length, within one paragraph."""
    spans: list[tuple[int, int]] = []
    position = 0
    while True:
        opening = _BACKTICKS.search(text, position)
        if not opening:
            return spans
        width = opening.end() - opening.start()
        paragraph_end = _BLANK_LINE.search(text, opening.end())
        limit = paragraph_end.start() if paragraph_end else len(text)
        closing = None
        for candidate in _BACKTICKS.finditer(text, opening.end(), limit):
            if candidate.end() - candidate.start() == width:
                closing = candidate
                break
        if closing is None:
            position = opening.end()
            continue
        spans.append((opening.start(), closing.end()))
        position = closing.end()


def _heading_text(raw: str) -> str:
    """A heading's words without the closing sequence (``## Title ##``), as CommonMark reads it."""
    text = raw.rstrip(" \t\r")
    bare = text.rstrip("#")
    if bare != text and (not bare or bare[-1] in " \t"):
        text = bare
    return text.strip()


def _count(features: dict[str, int], key: str, amount: int = 1) -> None:
    if amount:
        features[key] = features.get(key, 0) + amount


def _templater_count(text: str) -> int:
    """How many ``<% … %>`` there are. Searched by hand: a pattern would look for the end anew from every ``<%`` and,
    with many ``<%`` and no ``%>``, take time growing with the square of the note (40 KB held the server 15 s)."""
    count, at = 0, 0
    while (start := text.find("<%", at)) != -1:
        end = text.find("%>", start + 2)
        if end == -1:
            break
        count += 1
        at = end + 2
    return count


def aliases_of(front: Any) -> list[str]:
    """A note's other names from its front matter: Obsidian's ``aliases`` (a list, or one text), older vaults'
    ``alias``. Numbers count as text; anything else (a map, a list in a list) is not a name."""
    if not isinstance(front, dict):
        return []
    names: list[str] = []
    for key in ("aliases", "alias"):
        value = front.get(key)
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, str | int | float) and not isinstance(item, bool) and str(item).strip():
                names.append(str(item).strip())
    return names[:50]


def _split_wiki(inner: str, inner_start: int) -> tuple[str, str, int, int]:
    """``Folder/Note#Part|shown`` into target and subpath, with the target's offsets in the file."""
    path_part = inner.split("|", 1)[0].removesuffix("\\")  # [[Note\|shown]] inside a table
    target, _, subpath = path_part.partition("#")
    stripped = target.strip()
    lead = len(target) - len(target.lstrip())
    start = inner_start + lead
    return stripped, subpath.strip(), start, start + len(stripped)


def _decode(destination: str) -> tuple[str, bool]:
    decoded = unquote(destination) if "%" in destination else destination
    return decoded, decoded != destination


def parse(text: str) -> Parsed:
    parsed = Parsed()
    features = parsed.features
    _front_matter(text, parsed)
    front = parsed.front or {}
    title = front.get("title")
    if isinstance(title, str | int | float) and str(title).strip():
        parsed.title = str(title).strip()

    starts = _line_starts(text)
    masked_spans: list[tuple[int, int]] = []
    if parsed.body_start:
        masked_spans.append((0, parsed.body_start))

    # Blocks. The front matter is blanked first so that markdown-it does not read its "---" as a rule or heading.
    source = _mask(text, [(0, parsed.body_start)]) if parsed.body_start else text
    # Asked of the body alone: the blanked front matter would look like lines indented as code.
    if _NEEDS_BLOCKS.search(text, parsed.body_start):
        for token in _BLOCKS.parse(source):
            if token.type not in ("fence", "code_block", "html_block") or not token.map:
                continue
            begin, finish = token.map
            masked_spans.append((starts[begin], starts[finish] if finish < len(starts) else len(text)))
            if token.type == "fence":
                language = token.info.strip().split(" ", 1)[0].lower()
                _count(features, "code_blocks")
                if language in PLUGIN_BLOCKS:
                    _count(features, PLUGIN_BLOCKS[language])
                elif language == "mermaid":
                    _count(features, "mermaid")

    masked = _mask(text, list(masked_spans))
    code_spans = _inline_code(masked)
    for start, end in code_spans:
        inner = masked[start:end].strip("`").lstrip()
        if inner.startswith(("=", "$=")):
            _count(features, "dataview_inline")
    masked = _mask(masked, code_spans)
    comments = [(match.start(), match.end()) for match in _COMMENT.finditer(masked)]
    parsed.comments = comments
    _count(features, "comments", len(comments))
    masked = _mask(masked, comments)
    # $$ … $$ is a formula (KaTeX in Obsidian): nothing inside is a link or a tag.
    math = [(match.start(), match.end()) for match in _MATH_SPAN.finditer(masked)]
    _count(features, "math_blocks", len(math))
    masked = _mask(masked, math)
    parsed.headings = [(len(match.group(1)), _heading_text(match.group(2) or "")) for match in _HEADING.finditer(masked)]

    def line_of(offset: int) -> int:
        low, high = 0, len(starts) - 1
        while low < high:
            middle = (low + high + 1) // 2
            if starts[middle] <= offset:
                low = middle
            else:
                high = middle - 1
        return low + 1

    link_spans: list[tuple[int, int]] = []
    for match in _WIKI.finditer(masked):
        inner = match.group(2)
        target, subpath, target_start, target_end = _split_wiki(inner, match.start(2))
        if not target:
            # `[[#Heading]]`: a place in the same note, like `[x](#heading)` below; no link to another note, and
            # none to nothing (it stood among the links to nothing when cleaning up).
            continue
        kind = EMBED if match.group(1) else WIKI
        parsed.links.append(
            LinkRef(kind, target, subpath, match.start(), match.end(), target_start, target_end, line_of(match.start()))
        )
        link_spans.append((match.start(), match.end()))
    masked = _mask(masked, link_spans)

    link_spans = []
    for match in _MD_LINK.finditer(masked):
        raw = match.group(3)
        angle = raw.startswith("<")
        destination = raw[1:-1] if angle else raw
        link_spans.append((match.start(), match.end()))
        if not destination or _SCHEME.match(destination):
            continue
        path_part, _, subpath = destination.partition("#")
        decoded, encoded = _decode(path_part)
        if not decoded:
            continue  # [x](#heading): a place in the same note
        target_start = match.start(3) + (1 if angle else 0)
        kind = MARKDOWN_EMBED if match.group(1) else MARKDOWN
        parsed.links.append(
            LinkRef(
                kind, decoded, unquote(subpath), match.start(), match.end(), target_start,
                target_start + len(path_part), line_of(match.start()), angle, encoded,
            )
        )
    for match in _REFERENCE.finditer(masked):
        raw = match.group(2)
        angle = raw.startswith("<")
        destination = raw[1:-1] if angle else raw
        if not destination or _SCHEME.match(destination):
            continue
        path_part, _, subpath = destination.partition("#")
        decoded, encoded = _decode(path_part)
        if decoded:
            target_start = match.start(2) + (1 if angle else 0)
            parsed.links.append(
                LinkRef(
                    MARKDOWN, decoded, unquote(subpath), match.start(), match.end(), target_start,
                    target_start + len(path_part), line_of(match.start()), angle, encoded,
                )
            )
        link_spans.append((match.start(), match.end()))
    masked = _mask(masked, link_spans)
    parsed.links.sort(key=lambda link: link.start)
    parsed.prose = masked

    seen: set[str] = set()
    for raw_tag in [*_front_list(front.get("tags")), *_front_list(front.get("tag"))]:
        tag = raw_tag.lstrip("#").strip()
        if tag and tag.casefold() not in seen:
            seen.add(tag.casefold())
            parsed.tags.append(tag)
    for match in _TAG.finditer(masked):
        tag = match.group(1).rstrip("/")
        if not tag or tag.replace("/", "").isdigit():
            continue
        parsed.tag_spans.append((match.start(1), match.start(1) + len(tag)))
        if tag.casefold() in seen:
            continue
        seen.add(tag.casefold())
        parsed.tags.append(tag)

    _count(features, "callouts", len(_CALLOUT.findall(masked)))
    _count(features, "highlights", len(_HIGHLIGHT.findall(masked)))
    _count(features, "dataview_fields", len(_INLINE_FIELD.findall(masked)))
    tasks = []
    for match in _TASK.finditer(masked):
        tasks.append(match.group(1))
        number = line_of(match.start())
        end = starts[number] if number < len(starts) else len(text)
        parsed.task_lines.append((number, text[starts[number - 1] : end].rstrip("\r\n")))
    _count(features, "tasks", len(tasks))
    _count(features, "tasks_open", sum(1 for mark in tasks if mark == " "))
    _count(features, "templater", _templater_count(text))
    _count(features, "embeds", sum(1 for link in parsed.links if link.kind in (EMBED, MARKDOWN_EMBED)))
    if "excalidraw-plugin" in front:
        _count(features, "excalidraw")
    if parsed.front_error:
        _count(features, "front_matter_errors")

    parsed.body = text[parsed.body_start :]
    return parsed
