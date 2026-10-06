"""Notes as PDF: a note or a folder of notes set on paper by Typst, on the server.

Markdown is read with markdown-it (the reading view's rules: wiki links and embeds, callouts, ``==highlights==``,
``%%comments%%`` left out, formulas, footnotes, task lists, a line break stays a line break) and written as Typst.
**Every word of a note goes to Typst as a string, never as markup**: ``#"…"`` in content, so nothing a note says can
run as Typst code. Typst's root is a temporary folder that holds the source and copies of the pictures the reader may
see, nothing else; it reads no font of the machine and nothing from the net (the one package, mitex for LaTeX
formulas, comes with nexlore).

What leads where follows the rights of the account: an embedded note or a picture from a space it may not read is
left out like one that does not exist; a link to a note in the same PDF can be clicked, any other stays text.
"""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import unquote

from markdown_it import MarkdownIt
from markdown_it.rules_inline import StateInline
from markdown_it.tree import SyntaxTreeNode
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.footnote import footnote_plugin
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import SessionLocal, sort_key
from ..models import Account, File, Space
from . import appearance, index, mdparse, paths, rights, vault
from .typeset_worker import TypesetFailed, compile_apart, compile_here

APP_DIR = Path(__file__).resolve().parent.parent
FONTS = APP_DIR / "fonts"
PACKAGES = APP_DIR / "typst" / "packages"

#: Tests set this: Typst runs in the test's own process (a new process for every PDF would only cost time there).
INLINE = False

#: At most this many notes in one PDF, and this many characters of them together.
MAX_NOTES = 300
MAX_CHARS = 4_000_000
#: A preview shows the pages of at most this many notes (the rest is counted).
PREVIEW_NOTES = 6
PREVIEW_PPI = 48.0
#: Two PDFs at a time; a third waits.
_SLOTS = threading.BoundedSemaphore(2)

#: Pictures Typst can draw. HEIC has its WebP next to it (``attachments.finish``); others become their name.
PICTURES = {".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".gif": "gif", ".webp": "webp", ".svg": "svg"}

#: Text fonts of the app (``appearance.FONT_TEXT``) and their family names in ``app/fonts``.
TEXT_FAMILIES = {
    "inter": "Inter",
    "atkinson": "Atkinson Hyperlegible Next",
    "plex": "IBM Plex Sans",
    "literata": "Literata",
    "source-serif": "Source Serif 4",
}
SERIF = "Source Serif 4"
CODE_FAMILY = "JetBrains Mono"
EMOJI = "Noto Emoji"

#: The colours of callouts, by type (Obsidian's types; an unknown type is a note).
CALLOUT_COLOURS = {
    "note": "#3b82f6", "abstract": "#06b6d4", "summary": "#06b6d4", "tldr": "#06b6d4", "info": "#3b82f6",
    "todo": "#3b82f6", "tip": "#0d9488", "hint": "#0d9488", "important": "#0d9488", "success": "#16a34a",
    "check": "#16a34a", "done": "#16a34a", "question": "#d97706", "help": "#d97706", "faq": "#d97706",
    "warning": "#ea580c", "caution": "#ea580c", "attention": "#ea580c", "failure": "#dc2626", "fail": "#dc2626",
    "missing": "#dc2626", "danger": "#dc2626", "error": "#dc2626", "bug": "#dc2626", "example": "#7c3aed",
    "quote": "#6b7280", "cite": "#6b7280",
}

TEXTS = {
    "de": {
        "contents": "Inhalt", "page": "Seite {page} von {pages}", "changed": "geändert am {date}",
        "from": "aus {name}", "pdf_page": "{name}, Seite {page}", "diagram": "Diagramm",
        "notes": "{count} Notizen", "date": "%d.%m.%Y",
    },
    "en": {
        "contents": "Contents", "page": "Page {page} of {pages}", "changed": "changed {date}",
        "from": "from {name}", "pdf_page": "{name}, page {page}", "diagram": "Diagram",
        "notes": "{count} notes", "date": "%Y-%m-%d",
    },
}


class ExportError(Exception):
    def __init__(self, code: str, text: str, status: int = 422) -> None:
        super().__init__(text)
        self.code = code
        self.text = text
        self.status = status


@dataclass(slots=True)
class Options:
    paper: Literal["a4", "letter"] = "a4"
    landscape: bool = False
    properties: bool = True
    embeds: bool = True
    links: Literal["footnote", "text"] = "footnote"
    header: bool = True
    footer: bool = True
    font: Literal["app", "serif"] = "app"
    #: Folder: a table of contents at the front, every note on a page of its own.
    contents: bool = True
    new_page: bool = True
    language: Literal["de", "en"] = "en"


@dataclass(slots=True)
class Source:
    """One note of the PDF: where it lies, its text, the file it is."""

    file_id: int
    space_id: int
    path: str
    title: str
    text: str
    modified: datetime


# --- Typst writing ------------------------------------------------------------------------------------------------

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def string(value: str) -> str:
    """A Typst string literal: ``"…"`` with ``\\`` and ``"`` escaped, control characters as ``\\u{…}``. What a note
    says reaches Typst only this way."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", "\\n").replace("\r", "").replace("\t", "\\t")
    return '"' + _CONTROL.sub(lambda found: f"\\u{{{ord(found.group()):x}}}", escaped) + '"'


def words(value: str) -> str:
    """Text in content: ``#"…"``. Empty text writes nothing."""
    return "#" + string(value) if value else ""


def content(markup: str) -> str:
    """Typst content in brackets."""
    return "[" + markup + "]"


# --- Reading Markdown --------------------------------------------------------------------------------------------

_WIKI = re.compile(r"(!?)\[\[([^\[\]\r\n]+?)\]\]")


def _wiki_rule(state: StateInline, silent: bool) -> bool:
    """``[[target|alias]]`` and ``![[target]]`` as one token, before markdown-it sees brackets."""
    found = _WIKI.match(state.src, state.pos)
    if not found:
        return False
    if not silent:
        inner = found.group(2).replace("\\|", "|")
        target, _, alias = inner.partition("|")
        token = state.push("wikilink", "", 0)
        token.meta = {"embed": bool(found.group(1)), "target": target.strip(), "alias": alias.strip()}
        token.content = found.group(0)
    state.pos = found.end()
    return True


def _mark_rule(state: StateInline, silent: bool) -> bool:
    """``==highlight==`` on one line."""
    src, start = state.src, state.pos
    if not src.startswith("==", start) or src.startswith("===", start):
        return False
    end = src.find("==", start + 2)
    if end < 0 or end == start + 2 or "\n" in src[start:end]:
        return False
    if not silent:
        old_max = state.posMax
        state.push("mark_open", "mark", 1)
        state.pos, state.posMax = start + 2, end
        state.md.inline.tokenize(state)
        state.push("mark_close", "mark", -1)
        state.posMax = old_max
    state.pos = end + 2
    return True


def _reader() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"breaks": True, "html": True}).enable(["table", "strikethrough"])
    md.use(footnote_plugin, inline=True)
    md.use(dollarmath_plugin, allow_space=False, allow_digits=False, double_inline=True)
    md.inline.ruler.before("link", "wikilink", _wiki_rule)
    md.inline.ruler.before("emphasis", "mark", _mark_rule)
    return md


_MD = _reader()


def _without_comments(text: str) -> tuple[str, Any]:
    """The body of a note without its front matter and with ``%%comments%%`` blanked (they stay at home), and the
    front matter for the properties box."""
    parsed = mdparse.parse(text)
    out: list[str] = []
    at = parsed.body_start
    for start, end in parsed.comments:
        if end <= at:
            continue
        before = text[at:max(at, start)]
        out.append(before)
        # A comment over several lines keeps its line breaks, so the paragraphs around it stay apart.
        out.append("\n" * text.count("\n", max(at, start), end))
        at = end
        # "and %%aside%% and": one blank stays, not two.
        if before.endswith(" ") and text[at:at + 1] == " ":
            at += 1
    out.append(text[at:])
    return "".join(out), parsed.front


# --- From the tree to Typst --------------------------------------------------------------------------------------

_CALLOUT_HEAD = re.compile(r"^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$")
_LANG = re.compile(r"^[A-Za-z0-9_+#.-]{1,32}$")
_PAGE = re.compile(r"(?:^|&)page=(\d{1,6})")
_SIZE = re.compile(r"^(\d{1,5})(?:x(\d{1,5}))?$")


@dataclass
class Book:
    """Everything a PDF is made of while it is written: the notes, what links may lead to, the pictures."""

    db: Session
    readable: set[int]
    options: Options
    texts: dict[str, str]
    root: Path
    #: File id → label of the note in this PDF.
    labels: dict[int, str] = field(default_factory=dict)
    #: File id → the name of its copy under ``root``.
    pictures: dict[int, str] = field(default_factory=dict)
    names: dict[int, index.Names] = field(default_factory=dict)

    def picture(self, file: File) -> str | None:
        """The copy of a picture under the root, made once."""
        if file.id in self.pictures:
            return self.pictures[file.id]
        kind = PICTURES.get(PurePosixPath(file.path).suffix.lower())
        if kind is None:
            return None
        try:
            source = paths.resolve(file.path)
        except paths.PathError:
            return None
        name = f"p{len(self.pictures) + 1}.{kind}"
        try:
            shutil.copyfile(source, self.root / name)
        except OSError:
            return None
        self.pictures[file.id] = name
        return name

    def resolve(self, kind: str, target: str, source: Source) -> File | None:
        """Where a link of ``source`` leads, for this account: a file it may read, or None."""
        names = self.names.get(source.space_id)
        if names is None:
            names = self.names[source.space_id] = index.Names(self.db, source.space_id, preload=False)
        found = index.resolve(kind, target, source.path, names)
        if found is None:
            return None
        row = self.db.get(File, found)
        if row is None or row.deleted_at is not None or row.space_id not in self.readable:
            return None
        return row


class Writer:
    """One note to Typst. ``depth`` 1 is a note embedded in another: its own embeds of notes stay links."""

    def __init__(self, book: Book, source: Source, *, depth: int = 0) -> None:
        self.book = book
        self.source = source
        self.depth = depth
        self.shift = 1
        self.footnotes: dict[int, SyntaxTreeNode] = {}
        self.used_footnotes: set[int] = set()

    # -- blocks --

    def note(self, text: str, *, shift: int = 1) -> str:
        """The body of a note. Its headings go ``shift`` levels down (level 1 is the note's title)."""
        self.shift = shift
        tokens = _MD.parse(text)
        tree = SyntaxTreeNode(tokens)
        for node in tree.walk():
            if node.type == "footnote_block":
                for item in node.children:
                    if item.type == "footnote":
                        self.footnotes[int(item.meta.get("id", -1))] = item
        nodes = list(tree.children)
        # "# Backup-Strategie" at the top of the note "Backup-Strategie": the title stands above it already.
        if self.depth == 0 and nodes and nodes[0].type == "heading" and nodes[0].tag == "h1":
            first = nodes[0].children[0].content if nodes[0].children else ""
            if first.strip().casefold() == self.source.title.strip().casefold():
                nodes = nodes[1:]
        return self.blocks(nodes)

    def blocks(self, nodes: Iterable[SyntaxTreeNode]) -> str:
        out: list[str] = []
        for node in nodes:
            written = self.block(node)
            if written:
                out.append(written)
        return "\n\n".join(out)

    def block(self, node: SyntaxTreeNode) -> str:
        kind = node.type
        if kind == "paragraph":
            return self.paragraph(node)
        if kind == "heading":
            level = min(6, int(node.tag[1]) + self.shift)
            outlined = "true" if level <= 2 and self.depth == 0 else "false"
            return f"#heading(level: {level}, outlined: {outlined})" + content(self.inline_of(node))
        if kind in ("bullet_list", "ordered_list"):
            return self.list(node)
        if kind in ("fence", "code_block"):
            return self.code(node)
        if kind == "blockquote":
            return self.quote(node)
        if kind == "table":
            return self.table(node)
        if kind == "hr":
            return "#line(length: 100%, stroke: 0.6pt + nl-rule)"
        if kind in ("math_block", "math_block_label"):
            return "#nl-math-block(" + string(node.content.strip()) + ")"
        if kind == "html_block":
            return "#nl-plain(" + string(node.content.rstrip("\n")) + ")"
        if kind == "footnote_block":
            return ""
        return self.blocks(node.children)

    def paragraph(self, node: SyntaxTreeNode) -> str:
        children = node.children[0].children if node.children else []
        # A paragraph that is only an embed of a note or a PDF is a box, not a line.
        if len(children) == 1 and children[0].type == "wikilink" and children[0].meta["embed"]:
            boxed = self.embed_block(children[0])
            if boxed is not None:
                return boxed
        return "#par" + content(self.inline(children))

    def list(self, node: SyntaxTreeNode) -> str:
        items: list[str] = []
        tasks = 0
        for item in node.children:
            body, task = self.list_item(item)
            tasks += task is not None
            items.append(body)
        if node.type == "ordered_list":
            start = int(node.attrs.get("start", 1) or 1)
            return f"#enum(start: {start}, tight: true, " + ", ".join(items) + ")"
        marker = "marker: [], body-indent: 0pt, " if tasks == len(items) and items else ""
        return f"#list({marker}tight: true, " + ", ".join(items) + ")"

    def list_item(self, item: SyntaxTreeNode) -> tuple[str, bool | None]:
        """A list item; a task when its first words are ``[ ]`` or ``[x]``."""
        state: bool | None = None
        children = list(item.children)
        if children and children[0].type == "paragraph" and children[0].children:
            inline = children[0].children[0]
            first = inline.children[0] if inline.children else None
            if first is not None and first.type == "text":
                found = re.match(r"^\[(.)\][ \t]?", first.content)
                if found:
                    state = found.group(1) not in (" ",)
                    first.token.content = first.content[found.end():]  # type: ignore[union-attr]
                    mark = found.group(1)
                    done = mark in ("x", "X")
                    cancelled = mark == "-"
                    rest = self.inline(inline.children)
                    rest_blocks = self.blocks(children[1:])
                    box = f"#nl-task({'true' if done else 'false'}, {'true' if cancelled else 'false'})"
                    body = box + rest + (("\n\n" + rest_blocks) if rest_blocks else "")
                    return content(body), state
        return content(self.blocks(children)), state

    def code(self, node: SyntaxTreeNode) -> str:
        lang = (node.info or "").strip().split(" ")[0] if node.type == "fence" else ""
        text = node.content.rstrip("\n")
        if lang.lower() == "mermaid":
            return "#nl-diagram(" + string(text) + ", " + string(self.book.texts["diagram"]) + ")"
        lang_arg = f", lang: {string(lang)}" if lang and _LANG.match(lang) else ""
        return "#raw(" + string(text) + ", block: true" + lang_arg + ")"

    def quote(self, node: SyntaxTreeNode) -> str:
        children = list(node.children)
        if children and children[0].type == "paragraph" and children[0].children:
            inline = children[0].children[0]
            first_line = inline.content.split("\n", 1)[0]
            found = _CALLOUT_HEAD.match(first_line)
            if found:
                kind = found.group(1).lower()
                colour = CALLOUT_COLOURS.get(kind, CALLOUT_COLOURS["note"])
                title = found.group(3).strip() or kind.capitalize()
                # The title line goes; what follows the first break of the paragraph stays as its text.
                rest = inline.children
                cut = next((at for at, child in enumerate(rest) if child.type in ("softbreak", "hardbreak")), None)
                body_first = self.inline(rest[cut + 1:]) if cut is not None else ""
                body = ("#par" + content(body_first)) if body_first else ""
                more = self.blocks(children[1:])
                inner = "\n\n".join(part for part in (body, more) if part)
                return f"#nl-callout(rgb({string(colour)}), " + content(self.inline_text(title)) + ")" + content(inner)
        return "#nl-quote" + content(self.blocks(children))

    def table(self, node: SyntaxTreeNode) -> str:
        rows: list[list[str]] = []
        aligns: list[str] = []
        header = 0
        for part in node.children:
            for row in part.children:
                cells = []
                for cell in row.children:
                    style = str(cell.attrs.get("style", ""))
                    if part.type == "thead":
                        aligns.append("center" if "center" in style else "right" if "right" in style else "left")
                    cells.append(content(self.inline_of(cell)))
                rows.append(cells)
                if part.type == "thead":
                    header += 1
        if not rows:
            return ""
        columns = max(len(row) for row in rows)
        aligns = (aligns + ["left"] * columns)[:columns]
        out = [f"#table(columns: {columns}, align: ({', '.join(aligns)},)"]
        for at, row in enumerate(rows):
            cells = row + ["[]"] * (columns - len(row))
            if at < header:
                out.append("table.header(" + ", ".join(cells) + ")")
            else:
                out.extend(cells)
        return ", ".join(out) + ")"

    # -- inline --

    def inline_of(self, node: SyntaxTreeNode) -> str:
        inline = node.children[0] if node.children and node.children[0].type == "inline" else None
        return self.inline(inline.children if inline is not None else node.children)

    def inline_text(self, text: str) -> str:
        """A short text with Markdown in it, a callout's title for example."""
        tree = SyntaxTreeNode(_MD.parseInline(text))
        return self.inline(tree.children[0].children if tree.children else [])

    def inline(self, nodes: Iterable[SyntaxTreeNode]) -> str:
        return "".join(self.span(node) for node in nodes)

    def span(self, node: SyntaxTreeNode) -> str:
        kind = node.type
        if kind == "text":
            return words(node.content)
        if kind == "softbreak" or kind == "hardbreak":
            return "#linebreak()"
        if kind == "code_inline":
            return "#raw(" + string(node.content) + ")"
        if kind == "strong":
            return "#strong" + content(self.inline(node.children))
        if kind == "em":
            return "#emph" + content(self.inline(node.children))
        if kind == "s":
            return "#strike" + content(self.inline(node.children))
        if kind == "mark":
            return "#highlight(fill: nl-mark)" + content(self.inline(node.children))
        if kind == "math_inline" or kind == "math_inline_double":
            return "#nl-math(" + string(node.content) + ")"
        if kind == "html_inline":
            return words(node.content)
        if kind == "link":
            return self.link(node)
        if kind == "image":
            return self.image(node)
        if kind == "wikilink":
            return self.wiki(node)
        if kind == "footnote_ref":
            return self.footnote(node)
        return self.inline(node.children)

    def footnote(self, node: SyntaxTreeNode) -> str:
        number = int(node.meta.get("id", -1))
        label = f"<fn-{self.source.file_id}-{self.depth}-{number}>"
        if number in self.used_footnotes:
            return f"#footnote({label})"
        self.used_footnotes.add(number)
        body = self.footnotes.get(number)
        if body is None:
            return ""
        parts = list(body.children)
        if len(parts) == 1 and parts[0].type == "paragraph":
            # One paragraph: its words right after the number, not on a line of their own.
            return "#footnote" + content(self.inline_of(parts[0])) + label
        return "#footnote" + content(self.blocks(parts)) + label

    def link(self, node: SyntaxTreeNode) -> str:
        href = str(node.attrs.get("href", ""))
        text = self.inline(node.children)
        if re.match(r"^(https?|mailto):", href, re.IGNORECASE):
            link = "#link(" + string(href) + ")" + content(text or words(href))
            shown = "".join(child.content for child in node.children if child.type == "text")
            mail = href.lower().startswith("mailto:")
            if self.book.options.links == "footnote" and shown.strip() != href and not mail:
                link += "#footnote(" + string(href) + ")"
            return link
        if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.IGNORECASE):
            return text
        target = unquote(href.split("#", 1)[0])
        row = self.book.resolve("md", target, self.source) if target else None
        return self.to_note(row, text)

    def to_note(self, row: File | None, text: str) -> str:
        """Words that lead to a note: a link when that note is in this PDF, coloured words otherwise."""
        if row is not None and row.id in self.book.labels:
            return f"#link(<{self.book.labels[row.id]}>)" + content(text)
        return "#nl-ref" + content(text)

    def image(self, node: SyntaxTreeNode) -> str:
        src = str(node.attrs.get("src", ""))
        alt = "".join(child.content for child in node.children if child.type == "text")
        if re.match(r"^[a-z][a-z0-9+.-]*:", src, re.IGNORECASE):
            # Nothing is fetched from the net: a picture from the web is its description and its address.
            return "#nl-ref" + content(words(alt or src))
        row = self.book.resolve("md_embed", unquote(src), self.source)
        return self.picture(row, alt, "") or ("#nl-ref" + content(words(alt or src)))

    def picture(self, row: File | None, alt: str, size: str) -> str | None:
        if row is None:
            return None
        name = self.book.picture(row)
        if name is None:
            return None
        width = ""
        found = _SIZE.match(size)
        if found:
            width = f", width: calc.min({int(found.group(1)) * 0.75}pt, 100%)"
        return "#nl-picture(" + string(name) + width + ")"

    def wiki(self, node: SyntaxTreeNode) -> str:
        meta = node.meta
        target, _, section = meta["target"].partition("#")
        alias = meta["alias"]
        if meta["embed"]:
            row = self.book.resolve("embed", target, self.source) if target else None
            drawn = self.picture(row, alias, alias) if row is not None and not row.is_note else None
            if drawn:
                return drawn
            if row is not None and PurePosixPath(row.path).suffix.lower() == ".pdf":
                return self.pdf_ref(row, section)
            shown_name = words(alias or PurePosixPath(target).stem or target)
            return self.to_note(row if row is not None and row.is_note else None, shown_name)
        if not target:  # [[#Heading]]: a part of this note
            return "#nl-ref" + content(words(alias or section))
        row = self.book.resolve("wiki", target, self.source)
        shown = alias or (PurePosixPath(target).name if not section else f"{PurePosixPath(target).name} › {section}")
        if row is not None and not row.is_note:
            if PurePosixPath(row.path).suffix.lower() == ".pdf":
                return self.pdf_ref(row, section, alias)
            return "#nl-ref" + content(words(shown))
        return self.to_note(row, words(shown))

    def pdf_ref(self, row: File, section: str, alias: str = "") -> str:
        page = _PAGE.search(section)
        name = PurePosixPath(row.path).name
        label = alias or (self.book.texts["pdf_page"].format(name=name, page=page.group(1)) if page else name)
        return "#nl-file" + content(words(label))

    def embed_block(self, node: SyntaxTreeNode) -> str | None:
        """An embedded note as a box with its text (one level deep), when the options ask for it."""
        meta = node.meta
        target, _, section = meta["target"].partition("#")
        if not target or not self.book.options.embeds or self.depth > 0:
            return None
        row = self.book.resolve("embed", target, self.source)
        if row is None or not row.is_note:
            return None
        try:
            _file, data = vault.read(row.path)
        except vault.VaultError:
            return None
        text, _front = _without_comments(data.decode("utf-8", errors="replace").lstrip("\ufeff"))
        if section:
            text = part_of(text, section)
        inner = Source(
            row.id, row.space_id, row.path, row.title or PurePosixPath(row.path).stem, text, self.source.modified
        )
        body = Writer(self.book, inner, depth=1).note(text, shift=1)
        name = PurePosixPath(row.path).stem + (f" › {section}" if section else "")
        return "#nl-embedded(" + string(self.book.texts["from"].format(name=name)) + ")" + content(body)


def part_of(text: str, section: str) -> str:
    """``#Heading``: from that heading to the next of the same level or higher; ``#^id``: the block that ends with it.
    Nothing found: the whole note (as the reading view does)."""
    lines = text.splitlines()
    if section.startswith("^"):
        mark = section
        for at, line in enumerate(lines):
            if line.rstrip().endswith(mark):
                start = at
                while start > 0 and lines[start - 1].strip():
                    start -= 1
                return "\n".join(lines[start:at + 1]).replace(" " + mark, "")
        return text
    wanted = section.split("#")[-1].strip().casefold()
    level = 0
    taken: list[str] = []
    fence = False
    for line in lines:
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        found = None if fence else re.match(r"^(#{1,6})[ \t]+(.*?)[ \t#]*$", line)
        if level:
            if found and len(found.group(1)) <= level:
                break
            taken.append(line)
        elif found and found.group(2).strip().casefold() == wanted:
            level = len(found.group(1))
            taken.append(line)
    return "\n".join(taken) if taken else text


# --- The document --------------------------------------------------------------------------------------------------

PREAMBLE = r"""
#import "@preview/mitex:0.2.6": mitex, mi
#let nl-accent = rgb("#0b766a")
#let nl-muted = rgb("#6b7080")
#let nl-rule = rgb("#d4d7de")
#let nl-mark = rgb("#fde68a")
#set document(title: __TITLE__)
#set page(paper: __PAPER__, flipped: __FLIPPED__, margin: (x: 2cm, top: 2.3cm, bottom: 2.4cm),
  header: __HEADER__, footer: __FOOTER__)
#set text(font: (__FONT__, __EMOJI__), size: 10.5pt, lang: __LANG__, fill: rgb("#1c1e24"))
#set par(leading: 0.68em, spacing: 1.05em)
#show raw: set text(font: (__CODE__, __EMOJI__), size: 9pt)
#show raw.where(block: true): it => block(width: 100%, fill: rgb("#f4f5f7"), inset: 8pt, radius: 4pt, it)
#show link: set text(fill: nl-accent)
#show heading: set text(weight: "semibold")
#show heading: set block(above: 1.5em, below: 0.7em)
#show heading.where(level: 1): it => block(below: 0.4em, text(size: 22pt, weight: "bold", it.body))
#show heading.where(level: 2): set text(size: 16pt)
#show heading.where(level: 3): set text(size: 13pt)
#show heading.where(level: 4): set text(size: 11.5pt)
#set table(stroke: 0.5pt + nl-rule, inset: 6pt)
#show table.cell.where(y: 0): set text(weight: "semibold")
#let nl-ref(body) = text(fill: nl-accent, body)
#let nl-plain(body) = text(fill: nl-muted, raw(body))
#let nl-file(body) = box(stroke: 0.5pt + nl-rule, inset: (x: 4pt, y: 1pt), radius: 3pt, baseline: 1pt,
  text(size: 9.5pt, body))
#let nl-math(source) = mi(source)
#let nl-math-block(source) = mitex(source)
#let nl-picture(name, width: auto) = box(image(name, width: width))
#let nl-task(done, cancelled) = box(width: 0.85em, height: 0.85em, baseline: 0.12em, radius: 2pt,
  stroke: 0.7pt + (if done { nl-accent } else { nl-muted }), fill: (if done { nl-accent } else { none }),
  align(center + horizon, text(size: 0.65em, fill: white,
    if done { "✓" } else if cancelled { text(fill: nl-muted, "–") } else { "" }))) + h(0.45em)
#let nl-quote(body) = block(width: 100%, inset: (left: 10pt, y: 2pt), stroke: (left: 2pt + nl-rule),
  text(fill: rgb("#454954"), body))
#let nl-callout(colour, title, body) = block(width: 100%, breakable: true, fill: colour.lighten(92%),
  stroke: (left: 3pt + colour), inset: (x: 10pt, y: 8pt), radius: 3pt)[
  #text(weight: "semibold", fill: colour.darken(25%), title)
  #if body != [] { parbreak(); body }
]
#let nl-embedded(source, body) = block(width: 100%, breakable: true, stroke: 0.5pt + nl-rule, inset: 10pt, radius: 4pt)[
  #text(size: 8.5pt, weight: "semibold", fill: nl-muted, source)
  #parbreak()
  #body
]
#let nl-diagram(source, label) = block(width: 100%)[
  #text(size: 8.5pt, fill: nl-muted, label) #raw(source, block: true, lang: "mermaid")
]
#let nl-props(..rows) = block(width: 100%, stroke: 0.5pt + nl-rule, inset: 8pt, radius: 4pt, below: 1.2em,
  grid(columns: (8em, 1fr), row-gutter: 0.45em, column-gutter: 0.8em,
    ..rows.pos().map(cell => text(size: 9.5pt, cell))))
#let nl-changed(body) = block(above: 0pt, below: 1em, text(size: 9pt, fill: nl-muted, body))
"""


def _header(crumb: str, *, cover: bool) -> str:
    """The line at the top of every page; a folder's cover page has none."""
    line = "set text(size: 8pt, fill: nl-muted); " + string(crumb)
    return "context { " + (_after_cover(line) if cover else line) + " }"


def _after_cover(code: str) -> str:
    """Typst code that runs on every page but the first."""
    return "if counter(page).get().first() > 1 { " + code + " }"


def _footer(left: str, page_text: str, date: str, *, cover: bool) -> str:
    # "Seite {page} von {pages}" with the counters put in, every other word as a string.
    before, _, after = page_text.partition("{page}")
    middle, _, end = after.partition("{pages}")
    line = (
        "set text(size: 8pt, fill: nl-muted); " + string(left) + "; h(1fr); "
        + string(before) + "; counter(page).display(); " + string(middle)
        + "; str(counter(page).final().first()); " + string(end + " · " + date)
    )
    return "context { " + (_after_cover(line) if cover else line) + " }"


def _properties(front: Any) -> str:
    if not isinstance(front, dict) or not front:
        return ""
    cells: list[str] = []
    for key, value in list(front.items())[:40]:
        if isinstance(value, list):
            shown = ", ".join(str(item) for item in value if item is not None)
        elif isinstance(value, dict):
            continue
        else:
            shown = "" if value is None else str(value)
        cells.append(content(words(str(key))))
        cells.append(content(words(shown[:500])))
    return "#nl-props(" + ", ".join(cells) + ")" if cells else ""


def document(book: Book, sources: list[Source], *, folder: str | None, title: str, crumb: str) -> str:
    """The whole Typst source of a PDF."""
    options = book.options
    texts = book.texts
    family = SERIF if options.font == "serif" else book.texts["font"]
    today = datetime.now().astimezone().strftime(texts["date"])
    cover = folder is not None
    preamble = (
        PREAMBLE.replace("__TITLE__", string(title))
        .replace("__PAPER__", string("us-letter" if options.paper == "letter" else "a4"))
        .replace("__FLIPPED__", "true" if options.landscape else "false")
        .replace("__HEADER__", _header(crumb, cover=cover) if options.header else "none")
        .replace("__FOOTER__", _footer(title, texts["page"], today, cover=cover) if options.footer else "none")
        .replace("__FONT__", string(family))
        .replace("__EMOJI__", string(EMOJI))
        .replace("__CODE__", string(CODE_FAMILY))
        .replace("__LANG__", string(options.language))
    )
    parts = [preamble]
    if folder is not None:
        parts.append(
            "#align(horizon, block[#box(width: 4em, height: 5pt, fill: nl-accent) #v(1.4em)"
            "#text(size: 30pt, weight: \"bold\")[" + words(title) + "] #v(0.4em)"
            "#text(fill: nl-muted)[" + words(f"{crumb} · " + texts["notes"].format(count=len(sources)) + f" · {today}")
            + "]])"
        )
        parts.append("#pagebreak()")
        if options.contents:
            parts.append(f"#outline(title: [{words(texts['contents'])}], depth: 2)")
            parts.append("#pagebreak()")
    for at, source in enumerate(sources):
        if folder is not None and at > 0 and options.new_page:
            parts.append("#pagebreak(weak: true)")
        text, front = _without_comments(source.text)
        label = book.labels[source.file_id]
        parts.append(f"#heading(level: 1, outlined: true)[{words(source.title)}] <{label}>")
        changed = texts["changed"].format(date=source.modified.strftime(texts["date"]))
        parts.append("#nl-changed[" + words(changed) + "]")
        if options.properties:
            boxed = _properties(front)
            if boxed:
                parts.append(boxed)
        parts.append(Writer(book, source).note(text, shift=1))
    return "\n\n".join(parts) + "\n"


# --- Collecting the notes ------------------------------------------------------------------------------------------


def _source(db: Session, file: File) -> Source:
    _row, data = vault.read(file.path)
    text = data.decode("utf-8", errors="replace").lstrip("\ufeff")
    # The server's own time zone, as the date at the foot of the page.
    moment = datetime.fromtimestamp(file.mtime_ns / 1e9, tz=UTC) if file.mtime_ns else datetime.now(UTC)
    modified = moment.astimezone()
    return Source(file.id, file.space_id, file.path, PurePosixPath(file.path).stem, text, modified)


def _tree_order(path: str, base: str) -> tuple[Any, ...]:
    """A note's place as the sidebar shows it: folders before notes, each in reading order."""
    parts = PurePosixPath(path[len(base) + 1:] if base else path).parts
    return tuple((0, sort_key(part)) for part in parts[:-1]) + ((1, sort_key(parts[-1])),)


def collect(db: Session, account: Account, *, note: str | None, folder: str | None,
            only: list[str] | None = None) -> tuple[list[File], str, str]:
    """The notes of the PDF (rights checked by the route), its title and the line in its header."""
    if note is not None:
        row = db.scalar(select(File).where(File.path == note, File.deleted_at.is_(None)))
        if row is None or not row.is_note:
            raise ExportError("not_found", "Not found.", 404)
        files = [row]
        title = PurePosixPath(note).stem
        crumb = " › ".join(PurePosixPath(note).parts[:-1])
    else:
        assert folder is not None
        prefix = folder + "/"
        rows = list(db.scalars(select(File).where(
            File.deleted_at.is_(None), File.is_note.is_(True), File.path > prefix, File.path < prefix + "\uffff"
        )))
        if only is not None:
            wanted = set(only)
            rows = [row for row in rows if row.path in wanted]
        files = sorted(rows, key=lambda row: _tree_order(row.path, folder))
        title = PurePosixPath(folder).name
        crumb = " › ".join(PurePosixPath(folder).parts)
    if not files:
        raise ExportError("nothing_to_export", "There is no note to put in the PDF.")
    if len(files) > MAX_NOTES:
        raise ExportError("too_many_notes", f"A PDF holds at most {MAX_NOTES} notes.", 413)
    return files, title, crumb


def build(account: Account, *, note: str | None = None, folder: str | None = None, only: list[str] | None = None,
          options: Options, fmt: Literal["pdf", "png"] = "pdf") -> tuple[bytes | list[bytes], str, int]:
    """Set the PDF (or, for a preview, the pages as pictures). Returns the output, the title, and how many notes the
    preview left out."""
    with SessionLocal() as db:
        files, title, crumb = collect(db, account, note=note, folder=folder, only=only)
        readable = rights.readable_ids(db, account)
        sources = [_source(db, row) for row in files]
        if sum(len(source.text) for source in sources) > MAX_CHARS:
            raise ExportError("too_long", "The notes are too long for one PDF.", 413)
        left_out = 0
        if fmt == "png" and len(sources) > PREVIEW_NOTES:
            left_out = len(sources) - PREVIEW_NOTES
            sources = sources[:PREVIEW_NOTES]
        texts = dict(TEXTS[options.language])
        look = appearance.of(account.appearance)
        texts["font"] = TEXT_FAMILIES.get(str(look.get("font_text", "inter")), "Inter")
        with tempfile.TemporaryDirectory(prefix="nexlore-pdf-") as temp:
            root = Path(temp)
            book = Book(db=db, readable=readable, options=options, texts=texts, root=root)
            for at, source in enumerate(sources):
                book.labels[source.file_id] = f"n{at + 1}"
            source_text = document(book, sources, folder=folder, title=title, crumb=crumb)
            main = root / "main.typ"
            main.write_bytes(source_text.encode("utf-8"))
            run = compile_here if INLINE else compile_apart
            with _SLOTS:
                try:
                    output = run(main, fonts=FONTS, packages=PACKAGES, fmt=fmt, ppi=PREVIEW_PPI)
                except TypesetFailed as exc:
                    raise ExportError("typeset_failed", "The PDF could not be set.", 500) from exc
    return output, title, left_out


def language_of(account: Account, asked: str | None) -> Literal["de", "en"]:
    """The language of the words nexlore adds (contents, page numbers): as asked, else the account's."""
    chosen = (asked or account.language or "en").lower()
    return "de" if chosen.startswith("de") else "en"


def safe_name(title: str) -> str:
    """A file name for the download."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", title).strip(" .") or "note"
    return cleaned[:120] + ".pdf"


def space_of(db: Session, file: File) -> Space | None:
    return db.get(Space, file.space_id)
