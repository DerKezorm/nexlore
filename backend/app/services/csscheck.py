"""Own CSS (the snippets of an account, as Obsidian's): what may pass, read by a real CSS parser (tinycss2), never
by patterns. Escapes (``\\75rl(``), comments and odd spacing are undone by the parser before anything is judged.

Allowed: rules with selectors and declarations, and ``@media``/``@supports`` around such rules. Refused: everything
that could load something or leave the page (``url()``, ``image-set()``, ``src()``, ``@import``, ``@font-face``,
``@namespace``), old ways to run code (``expression()``, ``behavior``, ``-moz-binding``) and anything the parser
does not understand. The browser's Content Security Policy stands behind this as a second wall; the snippets only
ever reach the own account's pages.
"""

from __future__ import annotations

from dataclasses import dataclass

import tinycss2
from tinycss2 import ast

MAX_CHARS = 20_000
NESTED_AT_RULES = {"media", "supports", "layer", "container"}
FORBIDDEN_FUNCTIONS = {
    "url", "image-set", "-webkit-image-set", "image", "cross-fade", "element", "src", "expression", "paint",
}
FORBIDDEN_PROPERTIES = {"behavior", "-moz-binding", "-ms-behavior"}


@dataclass
class Problem:
    line: int
    what: str


def _walk_values(tokens: list[ast.Node], problems: list[Problem]) -> None:
    for token in tokens:
        if isinstance(token, ast.URLToken):
            problems.append(Problem(token.source_line, "url()"))
        elif isinstance(token, ast.FunctionBlock):
            name = token.lower_name
            if name in FORBIDDEN_FUNCTIONS:
                problems.append(Problem(token.source_line, f"{name}()"))
            _walk_values(token.arguments, problems)
        elif isinstance(token, ast.ParenthesesBlock | ast.SquareBracketsBlock | ast.CurlyBracketsBlock):
            _walk_values(token.content, problems)
        elif isinstance(token, ast.ParseError):
            problems.append(Problem(token.source_line, "unreadable"))


def _declarations(content: list[ast.Node], problems: list[Problem]) -> None:
    for item in tinycss2.parse_blocks_contents(content, skip_whitespace=True, skip_comments=True):
        if isinstance(item, ast.Declaration):
            if item.lower_name in FORBIDDEN_PROPERTIES:
                problems.append(Problem(item.source_line, item.lower_name))
            _walk_values(item.value, problems)
        elif isinstance(item, ast.QualifiedRule):
            # Nested rules (CSS nesting): the same rules inside.
            _walk_values(item.prelude, problems)
            _declarations(item.content, problems)
        elif isinstance(item, ast.AtRule):
            _at_rule(item, problems)
        elif isinstance(item, ast.ParseError):
            problems.append(Problem(item.source_line, "unreadable"))


def _at_rule(rule: ast.AtRule, problems: list[Problem]) -> None:
    if rule.lower_at_keyword not in NESTED_AT_RULES or rule.content is None:
        problems.append(Problem(rule.source_line, f"@{rule.lower_at_keyword}"))
        return
    _walk_values(rule.prelude, problems)
    _rules(tinycss2.parse_rule_list(rule.content, skip_whitespace=True, skip_comments=True), problems)


def _rules(rules: list[ast.Node], problems: list[Problem]) -> None:
    for rule in rules:
        if isinstance(rule, ast.QualifiedRule):
            _walk_values(rule.prelude, problems)
            _declarations(rule.content, problems)
        elif isinstance(rule, ast.AtRule):
            _at_rule(rule, problems)
        elif isinstance(rule, ast.ParseError):
            problems.append(Problem(rule.source_line, "unreadable"))


def check(css: str) -> list[Problem]:
    """What in ``css`` is not allowed, with its line; empty when all of it may pass."""
    if len(css) > MAX_CHARS:
        return [Problem(1, "too long")]
    if "\x00" in css or "</" in css:
        # Never inside a style element: nothing may close it.
        return [Problem(1, "</")]
    problems: list[Problem] = []
    _rules(tinycss2.parse_stylesheet(css, skip_whitespace=True, skip_comments=True), problems)
    return problems
