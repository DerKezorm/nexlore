#!/usr/bin/env python3
"""Mirror one nexlore space into a Git repository, one commit per version, with the real author.

nexlore stays the leading system; Git is the second floor (a backup with history, readable offline). The script needs
only Python 3.9+ and git, no packages. Run it on the server that holds the vault, by cron or a systemd timer, as
often as you like: it remembers where it stopped.

    NEXLORE_URL=https://notes.example.com NEXLORE_TOKEN=nxa_... \\
        python3 git-mirror.py --folder /path/to/vault/Emergency --git-dir /srv/nexlore-git/emergency.git \\
        --push origin

What it does on each run:

1. Asks ``GET /api/v1/versions`` for the versions of the space since the last run (a token of the level ``read``
   is enough; an operator's token also sees the mail addresses of the other authors).
2. Makes one commit per version: the version's text, byte for byte, with its author's name and mail address and the
   time of the change. A note moved or renamed in nexlore moves in Git too. Changes from outside nexlore (Syncthing,
   an editor) carry the author given with ``--outside-name``.
3. Adds one last commit for what versions do not cover: attachments, deleted notes, files nexlore does not know.
   It compares the repository with the folder, so the last state in Git is always the folder as it is.
4. Pushes, if ``--push`` names a remote.

The repository lies next to the vault, never in it (``--git-dir``): nexlore's backups take everything in the vault,
hidden folders too. The folder itself is only read; the script never writes into the vault.

The first run takes the whole history nexlore still keeps (nexlore thins old versions out: the last day completely,
then one per hour, per day, per week). For a repository that already has commits, start from now:
``--since 2026-11-18T00:00:00+01:00``.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATE = "nexlore-mirror.json"


class Mirror:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.url = args.url.rstrip("/")
        self.space = args.space or Path(args.folder).name
        #: For authors without a mail address: name@this; the host of nexlore's address without --mail-domain.
        self.domain = args.mail_domain or urllib.parse.urlsplit(self.url).hostname or "nexlore.invalid"
        self.committer = (args.committer_name, args.committer_email or f"mirror@{self.domain}")
        self.git_dir = Path(args.git_dir).resolve()
        self.env = dict(os.environ, GIT_DIR=str(self.git_dir), GIT_WORK_TREE=str(Path(args.folder).resolve()))
        self.state_file = self.git_dir / STATE

    # --- nexlore ---

    def get(self, path: str, params: dict[str, str] | None = None) -> bytes:
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        request = urllib.request.Request(f"{self.url}{path}{query}",
                                         headers={"Authorization": f"Bearer {self.args.token}"})
        try:
            with urllib.request.urlopen(request, timeout=60) as answer:
                return answer.read()
        except urllib.error.HTTPError as exc:
            sys.exit(f"nexlore answered {exc.code} on {path}: {exc.read().decode(errors='replace')}")

    def versions(self, cursor: str | None, since: str | None):
        while True:
            params = {"space": self.space, "limit": "500"}
            if cursor:
                params["cursor"] = cursor
            elif since:
                params["since"] = since
            page = json.loads(self.get("/api/v1/versions", params))
            yield page["versions"], page["cursor"]
            if not page["more"]:
                return
            cursor = page["cursor"]

    # --- git ---

    def git(self, *args: str, data: bytes | None = None, env: dict[str, str] | None = None,
            check: bool = True) -> str:
        done = subprocess.run(["git", *args], input=data, capture_output=True, env=env or self.env, check=False)
        if check and done.returncode != 0:
            sys.exit(f"git {' '.join(args)} failed: {done.stderr.decode(errors='replace')}")
        return done.stdout.decode().strip()

    def head(self) -> str | None:
        return self.git("rev-parse", "--verify", "-q", "HEAD", check=False) or None

    def commit(self, message: str, name: str, mail: str, when: str) -> bool:
        tree = self.git("write-tree")
        parent = self.head()
        if parent and self.git("rev-parse", f"{parent}^{{tree}}") == tree:
            return False  # Nothing changed, for example a version seen again after a run broke off.
        stamp = f"@{int(datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp())} +0000"
        env = dict(self.env, GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=mail, GIT_AUTHOR_DATE=stamp,
                   GIT_COMMITTER_NAME=self.committer[0], GIT_COMMITTER_EMAIL=self.committer[1])
        made = self.git("commit-tree", tree, *(["-p", parent] if parent else []), "-m", message, env=env)
        self.git("update-ref", "HEAD", made)
        return True

    # --- the run ---

    def author(self, version: dict) -> tuple[str, str]:
        who = version.get("author")
        if who is None:
            return self.args.outside_name, self.args.outside_email or f"outside@{self.domain}"
        return who["display_name"], who.get("email") or f"{who['name']}@{self.domain}"

    def run(self) -> None:
        if not self.git_dir.exists():
            self.git("init", "-q", "--bare", str(self.git_dir), env=dict(os.environ))
        state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        files: dict[str, str] = state.get("files", {})
        if self.head():
            self.git("read-tree", "HEAD")  # The index starts as the last commit, whatever happened before.
        made = 0
        cursor = state.get("cursor")
        for page, page_cursor in self.versions(cursor, None if state else self.args.since):
            cursor = page_cursor
            for version in page:
                inside = version["path"].split("/", 1)[1]
                blob = self.git("hash-object", "-w", "--stdin",
                                data=self.get(f"/api/v1/versions/{version['id']}/content"))
                before = files.get(str(version["file_id"]))
                if before and before != inside:
                    self.git("update-index", "--force-remove", "--", before)
                self.git("update-index", "--add", "--cacheinfo", f"100644,{blob},{inside}")
                files[str(version["file_id"])] = inside
                name, mail = self.author(version)
                where = "changed outside nexlore" if version["outside"] else f"nexlore ({version['source']})"
                made += self.commit(f"{inside}\n\n{where}, version {version['id']}", name, mail,
                                    version["updated_at"])
            self.save(cursor, files)
        # Attachments, deletions and anything else: the folder as it is now.
        self.git("add", "-A", "--", ".", ":(exclude,glob)**/.nexlore-*")
        made += self.commit("Files and deletions from the folder", *self.committer,
                            datetime.now(timezone.utc).isoformat())
        self.save(cursor, files)
        if self.args.push and made:
            self.git("push", "-q", self.args.push, f"HEAD:refs/heads/{self.args.branch}")
        print(f"{made} commits")

    def save(self, cursor: str | None, files: dict[str, str]) -> None:
        self.state_file.write_text(json.dumps({"cursor": cursor, "files": files}, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", default=os.environ.get("NEXLORE_URL", ""), help="nexlore's address (NEXLORE_URL)")
    parser.add_argument("--token", default=os.environ.get("NEXLORE_TOKEN", ""), help="an API token (NEXLORE_TOKEN)")
    parser.add_argument("--folder", required=True, help="the space's folder in the vault (read only)")
    parser.add_argument("--space", help="the space's name in nexlore; the folder's name without it")
    parser.add_argument("--git-dir", required=True, help="the repository, next to the vault; made if missing")
    parser.add_argument("--since", help="on the first run: only versions after this moment (ISO with offset)")
    parser.add_argument("--mail-domain",
                        help="for authors without a mail address: name@this (default: the host of --url)")
    parser.add_argument("--outside-name", default="outside nexlore", help="author of changes from outside")
    parser.add_argument("--outside-email", help="their address; outside@<mail-domain> without it")
    parser.add_argument("--committer-name", default="nexlore mirror")
    parser.add_argument("--committer-email", help="mirror@<mail-domain> without it")
    parser.add_argument("--push", metavar="REMOTE", help="push to this remote after new commits")
    parser.add_argument("--branch", default="master", help="the branch to push to (default master)")
    args = parser.parse_args()
    if not args.url or not args.token:
        parser.error("give --url and --token, or NEXLORE_URL and NEXLORE_TOKEN")
    Mirror(args).run()


if __name__ == "__main__":
    main()
