"""Typst in a process of its own: what the export hands it is set there, and a set that runs too long is stopped from
outside. Imports nothing of the app, so a fresh process starts quickly (Windows spawns, it does not fork)."""

from __future__ import annotations

import multiprocessing
from multiprocessing.connection import Connection
from pathlib import Path

#: How long one set may take before the process is stopped.
TIMEOUT_SECONDS = 90


class TypesetFailed(Exception):
    """Typst refused the source or ran out of time; ``reason`` says which (``timeout``, ``typst``)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


def compile_here(main: Path, *, fonts: Path, packages: Path, fmt: str, ppi: float) -> bytes | list[bytes]:
    """Set ``main`` in this process. The root is the folder of ``main``: Typst reads nothing outside it, and no font
    of the machine, only nexlore's own (and Typst's built-in ones for formulas)."""
    import typst

    try:
        output = typst.compile(
            str(main), root=str(main.parent), font_paths=[str(fonts)], ignore_system_fonts=True,
            package_path=str(packages), format=fmt, ppi=ppi,
        )
    except Exception as exc:  # Typst raises its own error with the line it stumbled over
        raise TypesetFailed("typst", str(exc)[:2000]) from exc
    return output


def _child(conn: Connection, main: str, fonts: str, packages: str, fmt: str, ppi: float) -> None:
    try:
        conn.send(("ok", compile_here(Path(main), fonts=Path(fonts), packages=Path(packages), fmt=fmt, ppi=ppi)))
    except TypesetFailed as exc:
        conn.send(("failed", exc.detail))
    except BaseException as exc:  # noqa: BLE001 -- anything else still ends the wait of the parent
        conn.send(("failed", type(exc).__name__))
    finally:
        conn.close()


def compile_apart(
    main: Path, *, fonts: Path, packages: Path, fmt: str, ppi: float, timeout: float = TIMEOUT_SECONDS
) -> bytes | list[bytes]:
    """Set ``main`` in a process of its own and wait at most ``timeout`` seconds for it."""
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = context.Process(
        target=_child, args=(send, str(main), str(fonts), str(packages), fmt, ppi), daemon=True
    )
    process.start()
    send.close()
    try:
        if not receive.poll(timeout):
            raise TypesetFailed("timeout")
        try:
            status, value = receive.recv()
        except EOFError as exc:
            raise TypesetFailed("typst", "the typesetting process ended without an answer") from exc
    finally:
        receive.close()
        if process.is_alive():
            process.kill()
        process.join(5)
    if status != "ok":
        raise TypesetFailed("typst", str(value))
    return value  # type: ignore[no-any-return]
