"""A backup brought in from elsewhere: for a move to a new server, the downloaded archive goes up again and joins the
list, to be checked and restored like any other. Built after nexcanvas 0.2.1."""

from __future__ import annotations

import base64
import io
import os
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Account
from app.services import backups

from .conftest import PASSWORD, make_account, sign_in


def _header(password: str = PASSWORD) -> dict[str, str]:
    return {"X-Nexlore-Password": base64.b64encode(password.encode("utf-8")).decode("ascii")}


def _downloaded(client: TestClient) -> bytes:
    """A backup made here, carried away and deleted: what someone moving to a new server holds in their hands."""
    name = client.post("/api/backups", json={"note": "before the move"}).json()["name"]
    archive = client.post(f"/api/backups/{name}/download", json={"password": PASSWORD}).content
    assert client.request("DELETE", f"/api/backups/{name}", json={"password": PASSWORD}).status_code == 204
    return archive


def _names(client: TestClient) -> set[str]:
    return {entry["name"] for entry in client.get("/api/backups").json()}


def _leftovers() -> list[str]:
    return [path.name for path in backups.folder().iterdir() if path.name.startswith(".upload-")]


def test_an_uploaded_backup_joins_the_list_checks_whole_and_restores(client: TestClient, operator: Account,
                                                                    vault: Path) -> None:
    (vault / "S").mkdir(parents=True, exist_ok=True)
    (vault / "S" / "a.md").write_text("moving day", encoding="utf-8")
    archive = _downloaded(client)
    answer = client.post("/api/backups/upload", content=archive, headers=_header())
    assert answer.status_code == 201, answer.text
    name = answer.json()["name"]
    assert name.endswith("-upload.zip") and backups.NAME.match(name)
    listed = {entry["name"]: entry for entry in client.get("/api/backups").json()}
    assert listed[name]["uploaded"] is True and listed[name]["note"] == "before the move"
    assert client.post(f"/api/backups/{name}/check").json()["usable"] is True
    # The restore itself is the one every backup has; here only that it takes this archive (the restart is not run).
    assert backups.stage_restore(name).usable
    assert _leftovers() == []


def test_the_same_archive_twice_keeps_both(client: TestClient, operator: Account) -> None:
    archive = _downloaded(client)
    first = client.post("/api/backups/upload", content=archive, headers=_header()).json()["name"]
    second = client.post("/api/backups/upload", content=archive, headers=_header()).json()["name"]
    assert first != second and {first, second} <= _names(client)


def test_an_upload_needs_the_password_and_keeps_nothing_without_it(client: TestClient, operator: Account) -> None:
    archive = _downloaded(client)
    before = _names(client)
    for headers in ({}, _header("wrong password here"), {"X-Nexlore-Password": "not base64!"}):
        answer = client.post("/api/backups/upload", content=archive, headers=headers)
        assert answer.status_code == 401, answer.text
    assert _names(client) == before
    assert _leftovers() == []


def test_only_the_operator_uploads(client: TestClient, operator: Account) -> None:
    archive = _downloaded(client)
    before = _names(client)
    with TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-member00"}) as member:
        sign_in(member, make_account("noor"))
        assert member.post("/api/backups/upload", content=archive, headers=_header()).status_code == 403
    assert _names(client) == before


def test_what_is_not_one_of_ours_is_refused_and_leaves_nothing(client: TestClient, operator: Account) -> None:
    before = _names(client)
    plain = io.BytesIO()
    with zipfile.ZipFile(plain, "w") as other:
        other.writestr("notes.txt", "not a backup")
    no_database = io.BytesIO()
    with zipfile.ZipFile(no_database, "w") as other:
        other.writestr(backups.MANIFEST, '{"version": "1.2.0", "created": "2026-10-05T07:00:00+00:00", "kind": "manual"}')
    for body in (b"just some bytes", plain.getvalue(), no_database.getvalue()):
        answer = client.post("/api/backups/upload", content=body, headers=_header())
        assert answer.status_code == 400 and answer.json()["detail"]["code"] == "backup_invalid", answer.text
    assert client.post("/api/backups/upload", content=b"", headers=_header()).status_code == 400
    assert _names(client) == before
    assert _leftovers() == []


def test_pruning_old_automatic_copies_leaves_an_uploaded_one(client: TestClient, operator: Account) -> None:
    archive = io.BytesIO(_downloaded(client))
    # A copy made by the nightly schedule elsewhere: its manifest says "scheduled".
    scheduled = io.BytesIO()
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(scheduled, "w") as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == backups.MANIFEST:
                data = data.replace(b'"kind": "manual"', b'"kind": "scheduled"')
            target.writestr(info, data)
    name = client.post("/api/backups/upload", content=scheduled.getvalue(), headers=_header()).json()["name"]
    made = [backups.create(kind=backups.SCHEDULED).name for _ in range(3)]
    backups.prune(1)
    left = {entry.name for entry in backups.entries()}
    # The uploaded one stays although its manifest says "scheduled"; of the three made here only one (made within the
    # same second, which of them counts as newest is not fixed).
    assert name in left
    assert len([one for one in made if one in left]) == 1


def test_an_archive_larger_than_an_ordinary_request_goes_up(client: TestClient, operator: Account, vault: Path) -> None:
    """Ordinary requests stop at 16 MB; a real backup is bigger, and the upload has its own ceiling."""
    (vault / "S").mkdir(parents=True, exist_ok=True)
    (vault / "S" / "big.bin").write_bytes(os.urandom(17 * 1024 * 1024))
    archive = _downloaded(client)
    assert len(archive) > 16 * 1024 * 1024
    answer = client.post("/api/backups/upload", content=archive, headers=_header())
    assert answer.status_code == 201, answer.text


@pytest.mark.parametrize(("value", "status"), [(1, 200), (100, 200), (365, 200), (0, 422), (366, 422)])
def test_backups_to_keep_go_up_to_365_as_the_interface_offers(client: TestClient, operator: Account, value: int,
                                                              status: int) -> None:
    """The interface offers 1 to 365 (as in nexcanvas) and the backup job reads up to 365; the setting takes the same."""
    answer = client.put("/api/settings", json={"backup_keep": value})
    assert answer.status_code == status, answer.text
    if status == 200:
        assert answer.json()["backup_keep"] == value
        with SessionLocal() as db:
            assert backups.keep(db) == value
