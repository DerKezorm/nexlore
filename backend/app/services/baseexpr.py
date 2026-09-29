"""The expressions of Obsidian's Bases (filters and formulas), read by nexlore's own small parser and evaluated here.

Nothing is ever handed to Python's ``eval``: a formula is parsed into a tree of a few known kinds, and names and
calls are looked up in fixed tables (``file.*``, the note's properties, ``formula.*``, a handful of functions and
methods). A formula that is too long, too deep, or asks for something unknown gives an error value, never an
exception to the page.

Understood: numbers, "strings", true/false/null, [lists], ``note.x``/``x``/``file.x``/``formula.x``, ``! && ||``
(also ``and or not``), ``== != > >= < <=``, ``+ - * / %``, ``if(c, a, b)``, ``now() today() date() number()``,
``file.inFolder() file.hasTag() file.hasProperty() file.hasLink()``, and on values ``contains startsWith endsWith
lower upper trim length isEmpty join``. A date minus or plus a duration ("7d", "2 weeks") is a date.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

MAX_CHARS = 1000
MAX_DEPTH = 40

_TOKEN = re.compile(
    r"\s*(?:(?P<num>\d+(?:\.\d+)?)|(?P<str>\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')"
    r"|(?P<op>==|!=|>=|<=|&&|\|\||[-+*/%<>!().,\[\]])|(?P<name>[A-Za-z_À-￿][\wÀ-￿-]*))"
)
_DURATION = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s*"
    r"(ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|w|weeks?|M|months?|y|years?)\s*$"
)


class ExprError(ValueError):
    pass


@dataclass
class Node:
    kind: str
    value: Any = None
    items: list[Node] = field(default_factory=list)


def _tokens(text: str) -> list[tuple[str, str]]:
    if len(text) > MAX_CHARS:
        raise ExprError("too long")
    out: list[tuple[str, str]] = []
    position = 0
    while position < len(text):
        if text[position:].strip() == "":
            break
        match = _TOKEN.match(text, position)
        if not match or match.end() == position:
            raise ExprError(f"cannot read at {position + 1}")
        kind = match.lastgroup or ""
        out.append((kind, match.group(kind)))
        position = match.end()
    return out


class _Parser:
    def __init__(self, text: str) -> None:
        self.tokens = _tokens(text)
        self.at = 0
        self.depth = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.at] if self.at < len(self.tokens) else None

    def take(self, value: str | None = None) -> tuple[str, str]:
        token = self.peek()
        if token is None or (value is not None and token[1] != value):
            raise ExprError(f"expected {value or 'more'}")
        self.at += 1
        return token

    def enter(self) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise ExprError("too deep")

    def parse(self) -> Node:
        node = self.or_()
        if self.peek() is not None:
            raise ExprError(f"unexpected {self.peek()[1]!r}")  # type: ignore[index]
        return node

    def or_(self) -> Node:
        node = self.and_()
        while self.peek() and self.peek()[1] in ("||", "or"):  # type: ignore[index]
            self.take()
            node = Node("or", items=[node, self.and_()])
        return node

    def and_(self) -> Node:
        node = self.not_()
        while self.peek() and self.peek()[1] in ("&&", "and"):  # type: ignore[index]
            self.take()
            node = Node("and", items=[node, self.not_()])
        return node

    def not_(self) -> Node:
        if self.peek() and self.peek()[1] in ("!", "not"):  # type: ignore[index]
            self.take()
            self.enter()
            node = Node("not", items=[self.not_()])
            self.depth -= 1
            return node
        return self.compare()

    def compare(self) -> Node:
        node = self.add()
        token = self.peek()
        if token and token[1] in ("==", "!=", ">", ">=", "<", "<="):
            self.take()
            node = Node("cmp", token[1], [node, self.add()])
        return node

    def add(self) -> Node:
        node = self.mul()
        while self.peek() and self.peek()[1] in ("+", "-"):  # type: ignore[index]
            op = self.take()[1]
            node = Node("math", op, [node, self.mul()])
        return node

    def mul(self) -> Node:
        node = self.unary()
        while self.peek() and self.peek()[1] in ("*", "/", "%"):  # type: ignore[index]
            op = self.take()[1]
            node = Node("math", op, [node, self.unary()])
        return node

    def unary(self) -> Node:
        if self.peek() and self.peek()[1] == "-":  # type: ignore[index]
            self.take()
            self.enter()
            node = Node("neg", items=[self.unary()])
            self.depth -= 1
            return node
        return self.postfix()

    def args(self) -> list[Node]:
        items: list[Node] = []
        self.take("(")
        if self.peek() and self.peek()[1] == ")":  # type: ignore[index]
            self.take(")")
            return items
        while True:
            items.append(self.or_())
            if self.peek() and self.peek()[1] == ",":  # type: ignore[index]
                self.take(",")
                continue
            self.take(")")
            return items

    def postfix(self) -> Node:
        node = self.primary()
        while self.peek() and self.peek()[1] in (".", "("):  # type: ignore[index]
            if self.peek()[1] == ".":  # type: ignore[index]
                self.take(".")
                kind, name = self.take()
                if kind != "name":
                    raise ExprError("a name after the dot")
                if self.peek() and self.peek()[1] == "(":  # type: ignore[index]
                    node = Node("method", name, [node, *self.args()])
                else:
                    node = Node("get", name, [node])
            else:
                if node.kind != "name":
                    raise ExprError("only functions are called")
                node = Node("call", node.value, self.args())
        return node

    def primary(self) -> Node:
        self.enter()
        try:
            kind, value = self.take()
            if kind == "num":
                return Node("lit", float(value) if "." in value else int(value))
            if kind == "str":
                return Node("lit", re.sub(r"\\(.)", r"\1", value[1:-1]))
            if kind == "name":
                if value == "true":
                    return Node("lit", True)
                if value == "false":
                    return Node("lit", False)
                if value == "null":
                    return Node("lit", None)
                return Node("name", value)
            if value == "(":
                node = self.or_()
                self.take(")")
                return node
            if value == "[":
                items: list[Node] = []
                if self.peek() and self.peek()[1] == "]":  # type: ignore[index]
                    self.take("]")
                    return Node("list", items=items)
                while True:
                    items.append(self.or_())
                    if self.peek() and self.peek()[1] == ",":  # type: ignore[index]
                        self.take(",")
                        continue
                    self.take("]")
                    return Node("list", items=items)
            raise ExprError(f"unexpected {value!r}")
        finally:
            self.depth -= 1


def parse(text: str) -> Node:
    return _Parser(str(text)).parse()


# --- Evaluating ---------------------------------------------------------------------------------------------------


@dataclass
class Row:
    """One note as the expressions see it."""

    name: str
    path: str
    folder: str
    size: int
    mtime: datetime
    tags: list[str]
    links: list[str]
    front: dict[str, Any]
    formulas: dict[str, Node] = field(default_factory=dict)
    cache: dict[str, Any] = field(default_factory=dict)
    busy: set[str] = field(default_factory=set)


def duration(text: Any) -> timedelta | None:
    if not isinstance(text, str):
        return None
    found = _DURATION.match(text)
    if not found:
        return None
    amount, unit = float(found.group(1)), found.group(2)
    if unit == "M" or unit.startswith("month"):
        return timedelta(days=30 * amount)
    unit = unit.lower()
    if unit == "ms":
        return timedelta(milliseconds=amount)
    if unit.startswith("s"):
        return timedelta(seconds=amount)
    if unit in ("m", "min") or unit.startswith("minute"):
        return timedelta(minutes=amount)
    if unit.startswith("h"):
        return timedelta(hours=amount)
    if unit.startswith("d"):
        return timedelta(days=amount)
    if unit.startswith("w"):
        return timedelta(weeks=amount)
    return timedelta(days=365 * amount)


def as_date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, str):
        text = value.strip()
        for candidate in (text, text[:19], text[:16], text[:10]):
            try:
                found = datetime.fromisoformat(candidate)
            except ValueError:
                continue
            return found if found.tzinfo else found.replace(tzinfo=UTC)
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().replace(",", "."))
        except ValueError:
            return None
    return None


def _truthy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str | list | dict):
        return len(value) > 0
    return bool(value)


def _fold(value: Any) -> Any:
    return value.casefold() if isinstance(value, str) else value


def _compare(op: str, left: Any, right: Any) -> bool:
    if isinstance(left, datetime) or isinstance(right, datetime):
        a, b = as_date(left), as_date(right)
        if a is None or b is None:
            return op == "!="
        left, right = a, b
    elif not (isinstance(left, str) and isinstance(right, str)) and None not in (_number(left), _number(right)):
        left, right = _number(left), _number(right)
    if op == "==":
        return _fold(left) == _fold(right)
    if op == "!=":
        return _fold(left) != _fold(right)
    try:
        return {">": left > right, ">=": left >= right, "<": left < right, "<=": left <= right}[op]  # type: ignore[operator]
    except TypeError:
        return False


def _math(op: str, left: Any, right: Any) -> Any:
    if isinstance(left, datetime) and op in ("+", "-"):
        step = duration(right)
        if step is not None:
            return left + step if op == "+" else left - step
        other = as_date(right)
        if other is not None and op == "-":
            return (left - other).total_seconds() * 1000
        return None
    if op == "+" and (isinstance(left, str) or isinstance(right, str)):
        return f"{'' if left is None else left}{'' if right is None else right}"
    a, b = _number(left), _number(right)
    if a is None or b is None:
        return None
    if op == "+":
        result = a + b
    elif op == "-":
        result = a - b
    elif op == "*":
        result = a * b
    elif op == "/":
        result = a / b if b else None
    else:
        result = a % b if b else None
    if isinstance(result, float) and math.isfinite(result) and result.is_integer() and abs(result) < 1e15:
        return int(result)
    return result


def _in_folder(row: Row, folder: Any) -> bool:
    wanted = str(folder or "").strip("/").casefold()
    here = row.folder.casefold()
    return not wanted or here == wanted or here.startswith(wanted + "/")


def _has_tag(row: Row, *tags: Any) -> bool:
    mine = [tag.casefold() for tag in row.tags]
    for tag in tags:
        want = str(tag).lstrip("#").casefold()
        if any(have == want or have.startswith(want + "/") for have in mine):
            return True
    return False


def _file(row: Row, name: str) -> Any:
    return {
        "name": row.name,
        "basename": row.name,
        "path": row.path,
        "folder": row.folder,
        "ext": "md",
        "size": row.size,
        "mtime": row.mtime,
        "ctime": row.mtime,
        "tags": list(row.tags),
        "links": list(row.links),
        "properties": dict(row.front),
    }.get(name)


def _property(row: Row, name: str) -> Any:
    if name in row.front:
        return row.front[name]
    folded = name.casefold()
    for key, value in row.front.items():
        if str(key).casefold() == folded:
            return value
    return None


def _formula(row: Row, name: str) -> Any:
    if name in row.cache:
        return row.cache[name]
    node = row.formulas.get(name)
    if node is None or name in row.busy:
        return None
    row.busy.add(name)
    try:
        value = evaluate(node, row)
    finally:
        row.busy.discard(name)
    row.cache[name] = value
    return value


_SCOPES = {"file", "note", "formula", "this"}


def _get(base: Any, name: str, row: Row) -> Any:
    if isinstance(base, _Scope):
        if base.name == "file":
            return _file(row, name)
        if base.name == "formula":
            return _formula(row, name)
        return _property(row, name)
    if name == "length" and isinstance(base, str | list):
        return len(base)
    if isinstance(base, datetime):
        parts = {"year": base.year, "month": base.month, "day": base.day, "hour": base.hour, "minute": base.minute}
        return parts.get(name)
    if isinstance(base, dict):
        return base.get(name)
    return None


@dataclass(frozen=True)
class _Scope:
    name: str


def _method(base: Any, name: str, args: list[Any], row: Row) -> Any:
    if isinstance(base, _Scope) and base.name == "file":
        if name == "inFolder":
            return _in_folder(row, args[0] if args else "")
        if name == "hasTag":
            return _has_tag(row, *args)
        if name == "hasProperty":
            return bool(args) and _property(row, str(args[0])) is not None
        if name == "hasLink":
            want = str(args[0] if args else "").casefold().removesuffix(".md")
            want = want.rsplit("/", 1)[-1]
            return any(link.casefold().removesuffix(".md").rsplit("/", 1)[-1] == want for link in row.links)
        return None
    first = args[0] if args else None
    if isinstance(base, str):
        text = base.casefold()
        needle = str(first).casefold() if first is not None else ""
        if name == "contains":
            return needle in text
        if name == "startsWith":
            return text.startswith(needle)
        if name == "endsWith":
            return text.endswith(needle)
        if name == "lower":
            return base.lower()
        if name == "upper":
            return base.upper()
        if name == "trim":
            return base.strip()
        if name == "isEmpty":
            return not base
        return None
    if isinstance(base, list):
        if name == "contains":

            def same(item: Any) -> bool:
                if isinstance(item, str) and isinstance(first, str):
                    return item.lstrip("#").casefold() == first.lstrip("#").casefold()
                return _fold(item) == _fold(first)

            return any(same(item) for item in base)
        if name == "isEmpty":
            return not base
        if name == "join":
            return str(first if first is not None else ", ").join(str(item) for item in base)
        return None
    if base is None and name == "isEmpty":
        return True
    return None


def _call(name: str, args: list[Any]) -> Any:
    if name == "now":
        return datetime.now(UTC)
    if name == "today":
        now = datetime.now(UTC)
        return datetime(now.year, now.month, now.day, tzinfo=UTC)
    if name == "date":
        return as_date(args[0]) if args else None
    if name == "number":
        return _number(args[0]) if args else None
    if name == "if":
        condition = args[0] if args else None
        return (args[1] if len(args) > 1 else None) if _truthy(condition) else (args[2] if len(args) > 2 else None)
    if name == "list":
        return list(args[0]) if args and isinstance(args[0], list) else list(args)
    if name == "min":
        numbers = [n for n in (_number(a) for a in args) if n is not None]
        return min(numbers) if numbers else None
    if name == "max":
        numbers = [n for n in (_number(a) for a in args) if n is not None]
        return max(numbers) if numbers else None
    raise ExprError(f"unknown function {name}")


def evaluate(node: Node, row: Row) -> Any:
    kind = node.kind
    if kind == "lit":
        return node.value
    if kind == "list":
        return [evaluate(item, row) for item in node.items]
    if kind == "name":
        if node.value in _SCOPES:
            return _Scope("note" if node.value == "this" else node.value)
        return _property(row, node.value)
    if kind == "get":
        return _get(evaluate(node.items[0], row), node.value, row)
    if kind == "method":
        base = evaluate(node.items[0], row)
        return _method(base, node.value, [evaluate(item, row) for item in node.items[1:]], row)
    if kind == "call":
        if node.value == "if":
            # Only the side that is taken is worked out.
            condition = evaluate(node.items[0], row) if node.items else None
            branch = node.items[1] if _truthy(condition) else (node.items[2] if len(node.items) > 2 else None)
            if branch is None or (_truthy(condition) and len(node.items) < 2):
                return None
            return evaluate(branch, row)
        return _call(node.value, [evaluate(item, row) for item in node.items])
    if kind == "not":
        return not _truthy(evaluate(node.items[0], row))
    if kind == "and":
        return _truthy(evaluate(node.items[0], row)) and _truthy(evaluate(node.items[1], row))
    if kind == "or":
        return _truthy(evaluate(node.items[0], row)) or _truthy(evaluate(node.items[1], row))
    if kind == "cmp":
        return _compare(node.value, evaluate(node.items[0], row), evaluate(node.items[1], row))
    if kind == "math":
        return _math(node.value, evaluate(node.items[0], row), evaluate(node.items[1], row))
    if kind == "neg":
        value = _number(evaluate(node.items[0], row))
        return -value if value is not None else None
    raise ExprError(f"unknown {kind}")


def truthy(value: Any) -> bool:
    return _truthy(value)
