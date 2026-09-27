"""Public reading pages: closed until the operator opens them, only what is shared leaves, passwords and end dates."""

from __future__ import annotations

import base64
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import Account, Share, utcnow
from app.services import settings_service

from .conftest import make_account, sign_in

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def stranger() -> TestClient:
    return TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-stranger"})


@pytest.fixture
def site(client: TestClient, account: Account, vault: Path) -> TestClient:
    garden = vault / "Garden"
    (garden / "Public" / "Attachments").mkdir(parents=True)
    (garden / "Private").mkdir()
    (garden / "Public" / "Roses.md").write_text(
        "---\nsecret: in the front matter\n---\n# Roses\n\nPrune in March. %%my own note to self%%\n"
        "See [[Tulips]], [[Diary]] and ![[rose.png]].\n",
        encoding="utf-8",
    )
    (garden / "Public" / "Tulips.md").write_text("# Tulips\n\nBack to [[Roses]].\n", encoding="utf-8")
    (garden / "Public" / "Attachments" / "rose.png").write_bytes(PNG)
    (garden / "Private" / "Diary.md").write_text("# Diary\n\nnothing for the web ![[photo.png]]\n", encoding="utf-8")
    (garden / "Private" / "photo.png").write_bytes(PNG + b"other")
    client.post("/api/index/scan")
    with SessionLocal() as db:
        settings_service.save(db, {"shares_allowed": True})
    return client


def share(client: TestClient, path: str, **extra: object) -> dict:
    made = client.post("/api/shares", json={"path": path, **extra})
    assert made.status_code == 201, made.text
    return made.json()


def token_of(made: dict) -> str:
    return made["link"].rsplit("/", 1)[1]


def test_public_pages_are_closed_until_the_operator_opens_them(site: TestClient) -> None:
    made = share(site, "Garden/Public")
    with SessionLocal() as db:
        settings_service.save(db, {"shares_allowed": False})
    refused = site.post("/api/shares", json={"path": "Garden/Public/Roses.md"})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "shares_off"
    # Closed, a link answers like one that never existed.
    closed = stranger().get(f"/api/public/{token_of(made)}")
    unknown = stranger().get("/api/public/" + "x" * 32)
    assert closed.status_code == unknown.status_code == 404 and closed.json() == unknown.json()
    with SessionLocal() as db:
        settings_service.save(db, {"shares_allowed": True})
    assert stranger().get(f"/api/public/{token_of(made)}").status_code == 200


def test_a_folder_page_shows_its_notes_and_nothing_else(site: TestClient) -> None:
    made = share(site, "Garden/Public")
    assert made["folder"] is True and made["link"].startswith("http://testserver/s/")
    visitor = stranger()
    state = visitor.get(f"/api/public/{token_of(made)}").json()
    assert state["name"] == "Public" and state["unlocked"] is True
    assert [note["path"] for note in state["notes"]] == ["Roses.md", "Tulips.md"]
    page = visitor.get(f"/api/public/{token_of(made)}/page", params={"path": "Roses.md"}).json()
    assert page["title"] == "Roses"
    # Front matter and comments stay at home.
    assert "secret" not in page["content"] and "note to self" not in page["content"]
    assert "Prune in March." in page["content"]
    links = {link["target"]: link for link in page["links"]}
    assert links["Tulips"]["note"] == "Tulips.md"
    # A link out of the share arrives as its text only, and is not in the list of links.
    assert "Diary" not in links and "[[Diary]]" not in page["content"] and "Diary" in page["content"]
    picture = visitor.get(f"/api/public/{token_of(made)}/file/{links['rose.png']['file']}")
    assert picture.status_code == 200 and picture.content == PNG
    assert "sandbox" in picture.headers["content-security-policy"]
    for outside in ("../Private/Diary.md", "Private/Diary.md", "/Garden/Private/Diary.md", "..%2FPrivate%2FDiary.md"):
        assert visitor.get(f"/api/public/{token_of(made)}/page", params={"path": outside}).status_code == 404


def test_a_file_nobody_in_the_share_links_is_not_reachable(site: TestClient) -> None:
    made = share(site, "Garden/Public")
    from app.models import File

    with SessionLocal() as db:
        photo = db.scalar(select(File.id).where(File.path == "Garden/Private/photo.png"))
        diary = db.scalar(select(File.id).where(File.path == "Garden/Private/Diary.md"))
    for file_id in (photo, diary, 999_999):
        assert stranger().get(f"/api/public/{token_of(made)}/file/{file_id}").status_code == 404


def test_a_note_page_is_that_note_alone(site: TestClient) -> None:
    made = share(site, "Garden/Public/Roses.md")
    visitor = stranger()
    state = visitor.get(f"/api/public/{token_of(made)}").json()
    assert state["folder"] is False and [note["path"] for note in state["notes"]] == ["Roses.md"]
    page = visitor.get(f"/api/public/{token_of(made)}/page").json()
    links = {link["target"]: link for link in page["links"]}
    # Tulips lies next to it but is not shared.
    assert "Tulips" not in links and "[[Tulips]]" not in page["content"]
    assert visitor.get(f"/api/public/{token_of(made)}/page", params={"path": "Tulips.md"}).status_code == 404


def test_a_password_guards_the_page_and_its_titles(site: TestClient) -> None:
    made = share(site, "Garden/Public", password="rose garden key")
    token = token_of(made)
    visitor = stranger()
    state = visitor.get(f"/api/public/{token}").json()
    assert state["password"] is True and state["unlocked"] is False and "notes" not in state
    assert visitor.get(f"/api/public/{token}/page", params={"path": "Roses.md"}).status_code == 401
    assert visitor.post(f"/api/public/{token}/unlock", json={"password": "wrong"}).status_code == 401
    assert visitor.post(f"/api/public/{token}/unlock", json={"password": "rose garden key"}).status_code == 204
    assert visitor.get(f"/api/public/{token}/page", params={"path": "Roses.md"}).status_code == 200
    # A made-up pass is worth nothing.
    forger = stranger()
    with SessionLocal() as db:
        share_id = db.scalar(select(Share.id))
    forger.cookies.set(f"nexlore_share_{share_id}", "0" * 64, path=f"/api/public/{token}")
    assert forger.get(f"/api/public/{token}/page", params={"path": "Roses.md"}).status_code == 401


def test_guessing_the_password_is_braked(site: TestClient) -> None:
    token = token_of(share(site, "Garden/Public", password="rose garden key"))
    visitor = stranger()
    for _ in range(5):
        visitor.post(f"/api/public/{token}/unlock", json={"password": "guess"})
    assert visitor.post(f"/api/public/{token}/unlock", json={"password": "rose garden key"}).status_code == 429


def test_an_expired_page_is_gone(site: TestClient) -> None:
    made = share(site, "Garden/Public", days=1)
    assert made["expires_at"] is not None
    with SessionLocal() as db:
        for row in db.scalars(select(Share)):
            row.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert stranger().get(f"/api/public/{token_of(made)}").status_code == 404
    assert site.post("/api/shares", json={"path": "Garden/Public", "days": 3}).status_code == 422


def test_a_page_follows_its_note_when_it_moves(site: TestClient) -> None:
    made = share(site, "Garden/Public/Tulips.md")
    assert site.post("/api/move", json={"source": "Garden/Public", "destination": "Garden/Shown"}).status_code == 200
    assert site.get("/api/shares", params={"path": "Garden/Shown/Tulips.md"}).json()[0]["id"] == made["id"]
    assert stranger().get(f"/api/public/{token_of(made)}/page").json()["title"] == "Tulips"


def test_making_a_page_takes_the_right_to_manage(site: TestClient) -> None:
    site.post("/api/spaces", json={"name": "Team"})
    site.post("/api/notes", json={"folder": "Team", "title": "Plan"})
    writer_row = make_account("writer")
    site.put("/api/spaces/Team/members/writer", json={"role": "write"})
    writer = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-writer00"})
    sign_in(writer, writer_row)
    refused = writer.post("/api/shares", json={"path": "Team/Plan.md"})
    assert refused.status_code == 403
    # Of a space one may not read, not even that it exists.
    assert writer.post("/api/shares", json={"path": "Garden/Public"}).status_code == 404
    made = share(site, "Team/Plan.md")
    assert writer.get("/api/shares", params={"path": "Team"}).status_code == 403
    assert writer.delete(f"/api/shares/{made['id']}").status_code == 404
    assert [row["id"] for row in site.get("/api/shares", params={"path": "Team"}).json()] == [made["id"]]


def test_the_operator_sees_and_withdraws_every_page(site: TestClient) -> None:
    other = make_account("gardener")
    gardener = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": "tab-gardener"})
    sign_in(gardener, other)
    gardener.post("/api/spaces", json={"name": "Veg"})
    gardener.post("/api/notes", json={"folder": "Veg", "title": "Beans"})
    made = share(gardener, "Veg/Beans.md")
    listed = site.get("/api/admin/shares").json()
    assert [row["path"] for row in listed] == ["Veg/Beans.md"]
    assert site.delete(f"/api/shares/{made['id']}").status_code == 204
    assert stranger().get(f"/api/public/{token_of(made)}").status_code == 404
    assert gardener.get("/api/admin/shares").status_code == 403


def test_a_link_out_of_the_share_leaves_neither_its_path_nor_its_target(site: TestClient, vault: Path) -> None:
    (vault / "Garden" / "Public" / "Irises.md").write_text(
        "# Irises\n\nSee [my notes](../Private/Diary.md), [[Diary|the diary]], [[Tulips]] and [[Nowhere]].\n",
        encoding="utf-8",
    )
    site.post("/api/index/scan")
    page = stranger().get(f"/api/public/{token_of(share(site, 'Garden/Public'))}/page", params={"path": "Irises.md"})
    body = page.json()
    assert "Private" not in page.text and "Diary.md" not in page.text
    assert "See my notes, the diary, [[Tulips]] and Nowhere." in body["content"]
    assert [link["target"] for link in body["links"]] == ["Tulips"]


def test_a_known_password_elsewhere_does_not_reset_the_brake(site: TestClient) -> None:
    victim = token_of(share(site, "Garden/Public", password="rose garden key"))
    decoy = token_of(share(site, "Garden/Public/Roses.md", password="my own decoy key"))
    visitor = stranger()
    codes = []
    for _ in range(8):
        codes.append(visitor.post(f"/api/public/{victim}/unlock", json={"password": "guess"}).status_code)
        assert visitor.post(f"/api/public/{decoy}/unlock", json={"password": "my own decoy key"}).status_code == 204
    assert 429 in codes


def test_a_page_follows_the_shared_note_itself(site: TestClient) -> None:
    made = share(site, "Garden/Public/Tulips.md")
    moved = site.post("/api/move", json={"source": "Garden/Public/Tulips.md", "destination": "Garden/Public/Lilies.md"})
    assert moved.status_code == 200
    assert site.get("/api/shares", params={"path": "Garden/Public/Lilies.md"}).json()[0]["id"] == made["id"]
    assert stranger().get(f"/api/public/{token_of(made)}/page").json()["path"] == "Lilies.md"
