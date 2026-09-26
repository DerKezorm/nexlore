"""Nothing in the repository names an AI assistant or its maker, and nothing carries a real name.

Two layers:

* Everywhere, CI included: the words an attribution is made of. They are put together from pieces here, so that
  this file does not trip the check itself.
* On a machine with the project's own scanner in ``.git/hooks/secret_scan.py`` (untracked, it holds the real names
  and the home network): that scanner over every file in full, not only over the lines a commit adds. A file that
  entered before the hook existed is caught here.

The files are the ones git would take: tracked plus untracked that are not ignored.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORDS = [("cla" + "ude"), ("anthro" + "pic"), ("co-" + "authored-by"), ("generated " + "with")]
PATTERN = re.compile("|".join(re.escape(word) for word in WORDS), re.IGNORECASE)
BINARY = (".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff2", ".gif", ".pdf")
#: The repository holds more than this; fewer means the listing went wrong. M0: about 70.
FLOOR = 50


def repository_files() -> list[Path]:
    if shutil.which("git") is None or not (ROOT / ".git").exists():
        # In CI a skip here would read green while nothing was checked.
        if os.environ.get("CI"):
            pytest.fail("CI without a git checkout: the attribution check cannot list the files")
        pytest.skip("no git checkout here")
    listing = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT, capture_output=True, check=True,
    ).stdout.decode("utf-8")
    return [ROOT / name for name in sorted(set(listing.split("\0"))) if name and (ROOT / name).is_file()]


def text_of(path: Path) -> str | None:
    if path.suffix.lower() in BINARY:
        return None
    raw = path.read_bytes()
    # UTF-16 and UTF-32 with a byte order mark are text full of zero bytes (Notepad, PowerShell's Out-File).
    for bom, encoding in ((b"\xff\xfe\x00\x00", "utf-32"), (b"\x00\x00\xfe\xff", "utf-32"), (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if raw.startswith(bom):
            return raw.decode(encoding, errors="replace")
    if b"\0" in raw:
        return None
    return raw.decode("utf-8", errors="replace")


def test_no_file_names_an_assistant_or_carries_an_attribution() -> None:
    files = repository_files()
    assert len(files) >= FLOOR, f"only {len(files)} files listed; is the listing looking at the repository?"
    found: list[str] = []
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        if PATTERN.search(relative):
            found.append(f"{relative}: in the file name")
        text = text_of(path)
        if text is None:
            continue
        hits = [number for number, line in enumerate(text.splitlines(), 1) if PATTERN.search(line)]
        found += [f"{relative}:{number}" for number in hits]
        # "generated" at the end of one line and "with" at the start of the next is the same attribution.
        if not hits and PATTERN.search(" ".join(text.split())):
            found.append(f"{relative}: across a line break")
    assert not found, "Attribution found:\n" + "\n".join(found)


def test_the_own_scanner_finds_nothing_in_any_file() -> None:
    scanner_path = ROOT / ".git" / "hooks" / "secret_scan.py"
    if not scanner_path.is_file():
        pytest.skip("the project's own scanner lives only on the development machines")
    spec = importlib.util.spec_from_file_location("secret_scan", scanner_path)
    assert spec and spec.loader
    scanner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scanner)
    files = repository_files()
    assert len(files) >= FLOOR
    findings: list[str] = []
    for path in files:
        text = text_of(path)
        if text is None:
            continue
        relative = path.relative_to(ROOT).as_posix()
        diff = f"+++ b/{relative}\n" + "\n".join("+" + line for line in text.splitlines())
        findings += scanner.scan(diff)
    assert not findings, "The scanner objects:\n" + "\n".join(findings[:40])


def test_the_check_knows_an_attribution_when_it_sees_one() -> None:
    assert PATTERN.search("Written by " + "Cla" + "ude")
    assert PATTERN.search("Co-" + "Authored-By: someone")
    assert PATTERN.search("made by " + "ANTHRO" + "PIC")
    assert not PATTERN.search("claws, clause and anthology are fine")
