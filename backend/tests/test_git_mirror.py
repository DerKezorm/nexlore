"""The example ``docs/examples/git-mirror.py`` (issue #20) against the real ``/api/v1/versions``: one commit per
version with the real author, renames follow, the folder decides the last state, a second run adds only what is new.
"""

# ruff: noqa: F811  (the fixture world is used by name)
from __future__ import annotations

import argparse
import importlib.util
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from app.services import index

from .test_api_tokens import World, api, ok, world  # noqa: F401  (the fixture is used by name)
from .test_api_versions import mail, write

SCRIPT = Path(__file__).resolve().parents[2] / "docs" / "examples" / "git-mirror.py"

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")


def load() -> Any:
    spec = importlib.util.spec_from_file_location("git_mirror", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mirror(world: World, token: str, repo: Path, **extra: Any) -> None:
    module = load()

    class Here(module.Mirror):  # type: ignore[misc,name-defined]
        def get(self, path: str, params: dict[str, str] | None = None) -> bytes:
            answer = api(token, "GET", path, params=params)
            assert answer.status_code == 200, answer.text
            return answer.content

    args = argparse.Namespace(url="http://testserver", token=token, folder=str(world.vault / "Garden"), space=None,
                              git_dir=str(repo), since=None, mail_domain=None,
                              outside_name="outside nexlore", outside_email=None, committer_name="nexlore mirror",
                              committer_email=None, push=None, branch="master")
    for key, value in extra.items():
        setattr(args, key, value)
    Here(args).run()


def log(repo: Path) -> list[str]:
    done = subprocess.run(["git", "--git-dir", str(repo), "log", "--reverse", "--name-status",
                           "--format=@%an <%ae>|%s"], capture_output=True, text=True, check=True)
    return [line for line in done.stdout.splitlines() if line]


def show(repo: Path, path: str) -> bytes:
    return subprocess.run(["git", "--git-dir", str(repo), "show", f"HEAD:{path}"], capture_output=True,
                          check=True).stdout


def test_one_commit_per_version_with_its_author_and_the_folder_last(world: World, tmp_path: Path) -> None:
    mail("anna", "anna@example.com", "Anna Acker")
    reader, writer = world.token(), world.token("write")
    repo = tmp_path / "garden.git"
    write(writer, "Garden/Plan.md", "# Plan\n\nin nexlore\n")
    (world.vault / "Garden" / "Beans.md").write_bytes(b"# Beans\n\nfrom Syncthing\n")
    (world.vault / "Garden" / "photo.png").write_bytes(b"\x89PNG not really")
    index.scan()
    mirror(world, reader, repo)

    lines = log(repo)
    commits = [line for line in lines if line.startswith("@")]
    assert "@Anna Acker <anna@example.com>|Plan.md" in commits
    assert "@outside nexlore <outside@testserver>|Beans.md" in commits
    assert commits[-1] == "@nexlore mirror <mirror@testserver>|Files and deletions from the folder"
    # The last commit holds what versions do not: the attachment.
    assert lines[-1].split("\t") == ["A", "photo.png"]
    assert show(repo, "Plan.md") == (world.vault / "Garden" / "Plan.md").read_bytes()
    assert show(repo, "Beans.md") == b"# Beans\n\nfrom Syncthing\n"
    # The vault stays as it was: no repository in it.
    assert not (world.vault / "Garden" / ".git").exists()

    # A second run adds only what is new; a note renamed in nexlore moves in Git.
    assert world.anna.post("/api/move", json={"source": "Garden/Beans.md", "destination": "Garden/Pulses.md"}).status_code == 200
    write(writer, "Garden/Pulses.md", "# Pulses\n")
    before = len(commits)
    mirror(world, reader, repo)
    new = [line for line in log(repo) if line.startswith("@")][before:]
    assert new and all(line.startswith("@Anna Acker") for line in new), new
    files = subprocess.run(["git", "--git-dir", str(repo), "ls-tree", "--name-only", "HEAD"], capture_output=True,
                           text=True, check=True).stdout.split()
    assert "Beans.md" not in files and show(repo, "Pulses.md") == b"# Pulses\n"
    # Nothing new: no commit at all.
    count = len(log(repo))
    mirror(world, reader, repo)
    assert len(log(repo)) == count


def test_since_on_the_first_run_and_mail_for_authors_without_one(world: World, tmp_path: Path) -> None:
    reader, writer = world.token(), world.token("write")
    repo = tmp_path / "garden.git"
    page = ok(api(reader, "GET", "/api/v1/versions", params={"space": "Garden"}))
    last = page["versions"][-1]["updated_at"]
    write(writer, "Garden/Plan.md", "# Plan\n\nlater\n")
    mirror(world, reader, repo, since=last, mail_domain="example.org")
    commits = [line for line in log(repo) if line.startswith("@")]
    assert commits[0] == "@anna <anna@example.org>|Plan.md"
    assert not any("Beans.md" in line for line in commits[:-1])
