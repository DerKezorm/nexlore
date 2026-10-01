"""Attachments: uploading, where they land, what comes out of them, how they are handed out, limits, the trash."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

import pillow_heif
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Account, File
from app.services import index, paths, prepare, settings_service

from .conftest import make_account, sign_in
from .test_media import XMP, exif_bytes

pillow_heif.register_heif_opener()

TAB = {"X-Nexlore-Client": "tab-aaaaaaaa"}


def put(root: Path, rel: str, content: str | bytes) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)


@pytest.fixture
def filled(vault: Path, account: str) -> Path:
    put(vault, "Home/Shopping.md", "# Shopping\n\nMilk.\n")
    put(vault, "Home/Recipes/Cake.md", "# Cake\n\nFlour.\n")
    put(vault, "Work/Plan.md", "# Plan\n")
    index.scan()
    return vault


def photo(color: tuple[int, int, int] = (200, 30, 30), *, fmt: str = "JPEG", exif: bool = True) -> bytes:
    out = io.BytesIO()
    image = Image.new("RGB", (40, 30), color)
    options: dict[str, object] = {"exif": exif_bytes()} if exif else {}
    if fmt == "HEIF":
        options["xmp"] = XMP
    image.save(out, format=fmt, **options)
    return out.getvalue()


def pdf(words: str) -> bytes:
    """A one-page PDF with a line of text, as small as a PDF can be."""
    stream = f"BT /F1 12 Tf 20 100 Td ({words}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(out)


def upload(client: TestClient, data: bytes, *, name: str = "image.png", note: str | None = "Home/Shopping.md",
           folder: str | None = None, pasted: bool = False, headers: dict[str, str] | None = None):
    params: dict[str, object] = {"name": name, "pasted": pasted}
    if note:
        params["note"] = note
    if folder:
        params["folder"] = folder
    return client.post("/api/attachments", params=params, content=data, headers=headers or TAB)


def settings(**values: object) -> None:
    with SessionLocal() as db:
        settings_service.save(db, values)


def test_a_pasted_picture_lands_beside_the_note_named_after_it(client: TestClient, filled: Path) -> None:
    answer = upload(client, photo(), pasted=True)
    assert answer.status_code == 201, answer.text
    body = answer.json()
    assert body["path"] == "Home/Attachments/Shopping 1.jpg"
    assert body["link"] == "Attachments/Shopping%201.jpg"
    assert body["kind"] == "jpeg" and body["duplicate"] is False
    assert body["removed"] == ["device", "location"]
    stored = (filled / "Home" / "Attachments" / "Shopping 1.jpg").read_bytes()
    assert b"PhoneMaker" not in stored and b"SERIAL-4711" not in stored
    with SessionLocal() as db:
        row = db.scalar(select(File).where(File.path == body["path"]))
        assert row is not None and row.owner == "tester" and row.hash == hashlib.sha256(stored).hexdigest()
    # No temporary file left anywhere.
    assert not [path for path in filled.rglob(".nexlore-*")]


def test_the_same_content_is_linked_again_not_stored_twice(client: TestClient, filled: Path) -> None:
    first = upload(client, photo(), pasted=True).json()
    again = upload(client, photo(), pasted=True, note="Home/Recipes/Cake.md").json()
    assert again["duplicate"] is True and again["path"] == first["path"]
    # From another folder the link climbs up to it.
    assert again["link"] == "../Attachments/Shopping%201.jpg"
    other = upload(client, photo((10, 200, 10)), pasted=True).json()
    assert other["path"] == "Home/Attachments/Shopping 2.jpg"
    # Another space never shares a file: a copy there is stored.
    elsewhere = upload(client, photo(), pasted=True, note="Work/Plan.md").json()
    assert elsewhere["duplicate"] is False and elsewhere["path"] == "Work/Attachments/Plan 1.jpg"


def test_a_named_file_keeps_its_name_made_safe(client: TestClient, filled: Path) -> None:
    first = upload(client, b"plain text", name='Report: "final"?.txt').json()
    assert first["path"] == "Home/Attachments/Report final.txt"
    second = upload(client, b"other text", name='Report: "final"?.txt').json()
    assert second["path"] == "Home/Attachments/Report final 2.txt"
    into_folder = upload(client, b"third", name="notes.txt", note=None, folder="Home/Recipes").json()
    assert into_folder["path"] == "Home/Recipes/notes.txt" and into_folder["link"] == ""


def test_an_upload_goes_only_where_it_may(client: TestClient, filled: Path) -> None:
    assert upload(client, b"x", note="Home/Missing.md").json()["detail"]["code"] == "not_found"
    assert upload(client, b"x", note="../outside.md").json()["detail"]["code"] == "path_invalid"
    assert upload(client, b"x", note=None, folder="Home/.obsidian").json()["detail"]["code"] == "path_invalid"
    assert upload(client, b"x", note=None, folder="Home/Nowhere").json()["detail"]["code"] == "not_found"
    assert upload(client, b"x", note="Home/Shopping.md", folder="Home").json()["detail"]["code"] == "path_invalid"
    assert upload(client, b"").json()["detail"]["code"] == "empty"
    # A change without its tab is refused before the route.
    assert upload(client, b"x", headers={"X-Nexlore-Client": ""}).status_code == 400
    assert not (filled / "Home" / "Attachments").exists()


def test_the_limits_per_file_and_per_account_hold(client: TestClient, filled: Path) -> None:
    settings(upload_max_mb=1)
    big = b"\x00" * (1024 * 1024 + 1)
    refused = upload(client, big, name="big.bin")
    assert refused.status_code == 413 and refused.json()["detail"]["code"] == "too_large"
    assert not (filled / "Home" / "Attachments").exists(), "neither the file nor an empty folder stays"
    # Sent without a length: counted while it arrives.
    streamed = client.post("/api/attachments", params={"name": "big.bin", "note": "Home/Shopping.md"},
                           content=iter([b"\x00" * 600_000, b"\x00" * 600_000]), headers=TAB)
    assert streamed.status_code == 413 and streamed.json()["detail"]["code"] == "too_large"
    assert not (filled / "Home" / "Attachments").exists()
    settings(upload_max_mb=10, quota_mb=1)
    assert upload(client, b"a" * 700_000, name="one.bin").status_code == 201
    over = upload(client, b"b" * 700_000, name="two.bin")
    assert over.status_code == 413 and over.json()["detail"]["code"] == "quota_exceeded"
    usage = client.get("/api/attachments/usage", headers=TAB).json()
    assert usage["used"] == 700_000 and usage["quota"] == 1024 * 1024
    # In the trash it still counts; gone for good it does not.
    client.delete("/api/files", params={"path": "Home/Attachments/one.bin"}, headers=TAB)
    assert client.get("/api/attachments/usage", headers=TAB).json()["used"] == 700_000
    entry = client.get("/api/trash", headers=TAB).json()[0]["id"]
    client.delete(f"/api/trash/{entry}", headers=TAB)
    assert client.get("/api/attachments/usage", headers=TAB).json()["used"] == 0


def test_two_uploads_at_once_do_not_share_the_space_left(client: TestClient, filled: Path) -> None:
    from app.services import attachments
    from app.services.vault import Actor

    settings(quota_mb=1)
    actor = Actor(name="tester", client="tab-aaaaaaaa")
    # Both planned before either is finished: each saw the whole megabyte free.
    plans, received = [], []
    for number in range(2):
        plan = attachments.plan(note="Home/Shopping.md", folder=None, name=f"{number}.bin", pasted=False, actor=actor)
        path = attachments.temporary(plan)
        path.write_bytes(bytes([number]) * 700_000)
        plans.append(plan)
        received.append(path)
    attachments.finish(plans[0], received[0], 700_000, actor)
    with pytest.raises(attachments.VaultError) as refused:
        attachments.finish(plans[1], received[1], 700_000, actor)
    assert refused.value.code == "quota_exceeded" and not received[1].exists()
    assert client.get("/api/attachments/usage", headers=TAB).json()["used"] == 700_000


def test_a_pdf_too_large_to_search_is_never_read_whole(filled: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import pdftext

    put(filled, "Home/big.pdf", pdf("kingfisher"))
    monkeypatch.setattr(pdftext, "MAX_BYTES", 100)
    read = []
    monkeypatch.setattr(prepare, "analyse", lambda rel, data: read.append(rel))
    item = prepare.prepare(str(filled), "Home/big.pdf")
    assert item is not None and read == [] and item.analysis.features == {"pdf_too_large": 1}


def test_a_heic_photo_gets_a_webp_the_note_links(client: TestClient, filled: Path) -> None:
    body = upload(client, photo(fmt="HEIF"), name="IMG_0001.HEIC").json()
    assert body["kind"] == "heic"
    assert body["original"] == "Home/Attachments/IMG_0001.HEIC"
    assert body["path"] == "Home/Attachments/IMG_0001.webp" and body["link"] == "Attachments/IMG_0001.webp"
    webp = filled / "Home" / "Attachments" / "IMG_0001.webp"
    with Image.open(webp) as image:
        # The photo says "turned by 90°" (orientation 6): the WebP is upright, since it keeps no orientation.
        assert image.format == "WEBP" and image.size == (30, 40)
        assert not image.getexif()
    assert b"PhoneMaker" not in webp.read_bytes()
    assert b"PhoneMaker" not in (filled / "Home" / "Attachments" / "IMG_0001.HEIC").read_bytes()


def test_the_operator_can_leave_place_and_device_in(client: TestClient, filled: Path) -> None:
    settings(strip_location=False)
    body = upload(client, photo(), name="kept.jpg").json()
    assert body["removed"] == []
    assert b"PhoneMaker" in (filled / "Home" / "Attachments" / "kept.jpg").read_bytes()


def fetch(client: TestClient, path: str, **extra: object):
    return client.get("/api/file", params={"path": path, **extra}, headers=TAB)


def test_files_are_handed_out_so_that_nothing_in_them_runs(client: TestClient, filled: Path) -> None:
    put(filled, "Home/pic.png", photo(fmt="PNG", exif=False))
    put(filled, "Home/drawing.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    put(filled, "Home/page.html", "<script>alert(1)</script>")
    put(filled, "Home/fake.png", "<html><script>alert(1)</script></html>")
    put(filled, "Home/doc.pdf", pdf("hello"))
    put(filled, "Home/notes.txt", "plain")
    index.scan()
    shown = fetch(client, "Home/pic.png")
    assert shown.status_code == 200 and shown.headers["content-type"] == "image/png"
    assert shown.headers["content-disposition"].startswith("inline")
    assert "sandbox" in shown.headers["content-security-policy"]
    assert shown.headers["x-content-type-options"] == "nosniff"
    for path, kind in [("Home/drawing.svg", "image/svg+xml"), ("Home/page.html", "application/octet-stream"),
                       ("Home/fake.png", "application/octet-stream"), ("Home/doc.pdf", "application/pdf")]:
        answer = fetch(client, path)
        assert answer.status_code == 200
        assert answer.headers["content-type"].split(";")[0] == kind, path
        assert answer.headers["content-disposition"].startswith("attachment"), path
    assert fetch(client, "Home/notes.txt").headers["content-type"] == "text/plain; charset=utf-8"
    assert fetch(client, "Home/pic.png", download=True).headers["content-disposition"].startswith("attachment")


def test_only_files_the_index_knows_are_handed_out(client: TestClient, filled: Path) -> None:
    put(filled, "Home/.obsidian/workspace.json", "{}")
    put(filled, "Home/later.png", b"not yet indexed")
    for path in ["Home/.obsidian/workspace.json", "Home/later.png", "Home/../Work/Plan.md", "Home/none.png"]:
        assert fetch(client, path).status_code in (400, 404), path
    app_status = client.get("/api/file", params={"path": "Home/Shopping.md"})
    assert app_status.status_code == 200


def test_big_files_stream_in_ranges_and_come_back_from_the_cache(client: TestClient, filled: Path) -> None:
    data = bytes(range(256)) * 4096
    put(filled, "Home/clip.bin", data)
    index.scan()
    part = client.get("/api/file", params={"path": "Home/clip.bin"}, headers={**TAB, "Range": "bytes=1000-1999"})
    assert part.status_code == 206 and part.content == data[1000:2000]
    whole = fetch(client, "Home/clip.bin")
    again = client.get("/api/file", params={"path": "Home/clip.bin"}, headers={**TAB, "If-None-Match": whole.headers["etag"]})
    assert again.status_code == 304


def test_prepare_hashes_other_files_in_pieces(vault: Path) -> None:
    data = bytes(range(256)) * 20_000
    put(vault, "Home/big.bin", data)
    item = prepare.prepare(str(vault), "Home/big.bin")
    assert item is not None and item.hash == hashlib.sha256(data).hexdigest() and item.analysis.body is None


def test_the_text_of_a_pdf_is_searched(client: TestClient, filled: Path) -> None:
    body = upload(client, pdf("zebracorn meadow"), name="Leaflet.pdf").json()
    hits = client.get("/api/search", params={"q": "zebracorn"}, headers=TAB).json()
    assert [hit["path"] for hit in hits] == [body["path"]]
    assert "meadow" in hits[0]["snippet"]
    put(filled, "Home/broken.pdf", b"%PDF-1.4\nthis is no pdf at all")
    index.scan()
    with SessionLocal() as db:
        row = db.scalar(select(File).where(File.path == "Home/broken.pdf"))
        assert row is not None and row.features == {"pdf_unreadable": 1}


def test_the_files_page_lists_attachments_and_how_often_they_are_used(client: TestClient, filled: Path) -> None:
    used = upload(client, photo(), pasted=True).json()
    upload(client, b"lonely", name="lonely.txt")
    note = client.get("/api/note", params={"path": "Home/Shopping.md"}, headers=TAB).json()
    client.put("/api/note", json={"path": "Home/Shopping.md", "content": f"# Shopping\n\n![]({used['link']})\n",
                                  "base_hash": note["hash"]}, headers=TAB)
    listed = client.get("/api/attachments", params={"space": "Home"}, headers=TAB).json()
    assert listed["total"] == 2
    assert {item["path"]: item["uses"] for item in listed["items"]} == {
        "Home/Attachments/Shopping 1.jpg": 1, "Home/Attachments/lonely.txt": 0,
    }
    unused = client.get("/api/attachments", params={"space": "Home", "unused": True}, headers=TAB).json()
    assert [item["path"] for item in unused["items"]] == ["Home/Attachments/lonely.txt"]


def test_a_link_typed_but_not_saved_is_resolved(client: TestClient, filled: Path) -> None:
    upload(client, photo(), pasted=True)

    def resolve(target: str, kind: str) -> str | None:
        return client.get("/api/resolve", params={"source": "Home/Recipes/Cake.md", "target": target, "kind": kind},
                          headers=TAB).json()["path"]

    assert resolve("Shopping 1.jpg", "embed") == "Home/Attachments/Shopping 1.jpg"
    assert resolve("../Attachments/Shopping%201.jpg", "md_embed") == "Home/Attachments/Shopping 1.jpg"
    assert resolve("Nothing.png", "embed") is None


def test_a_note_moving_to_another_folder_takes_its_own_attachments_along(client: TestClient, filled: Path) -> None:
    own = upload(client, photo(), pasted=True).json()
    shared = upload(client, photo((0, 0, 255)), pasted=True).json()
    note = client.get("/api/note", params={"path": "Home/Shopping.md"}, headers=TAB).json()
    text = f"# Shopping\n\n![]({own['link']})\n\n![]({shared['link']})\n"
    client.put("/api/note", json={"path": "Home/Shopping.md", "content": text, "base_hash": note["hash"]}, headers=TAB)
    cake = client.get("/api/note", params={"path": "Home/Recipes/Cake.md"}, headers=TAB).json()
    client.put("/api/note", json={"path": "Home/Recipes/Cake.md", "content": "# Cake\n\n![[Shopping 2.jpg]]\n",
                                  "base_hash": cake["hash"]}, headers=TAB)
    moved = client.post("/api/move", json={"source": "Home/Shopping.md", "destination": "Home/Lists/Shopping.md"},
                        headers=TAB)
    assert moved.status_code == 200, moved.text
    assert (filled / "Home" / "Lists" / "Attachments" / "Shopping 1.jpg").is_file()
    assert not (filled / "Home" / "Attachments" / "Shopping 1.jpg").exists()
    # Used by another note too: it stays, and the moved note's link climbs to it.
    assert (filled / "Home" / "Attachments" / "Shopping 2.jpg").is_file()
    written = (filled / "Home" / "Lists" / "Shopping.md").read_text(encoding="utf-8")
    assert written == "# Shopping\n\n![](Attachments/Shopping%201.jpg)\n\n![](../Attachments/Shopping%202.jpg)\n"
    links = client.get("/api/links", params={"path": "Home/Lists/Shopping.md"}, headers=TAB).json()
    assert [item["path"] for item in links["outgoing"]] == [
        "Home/Lists/Attachments/Shopping 1.jpg", "Home/Attachments/Shopping 2.jpg",
    ]


def test_a_deleted_note_takes_only_its_own_attachments_along_when_asked(client: TestClient, filled: Path) -> None:
    own = upload(client, photo(), pasted=True).json()
    shared = upload(client, photo((0, 0, 255)), pasted=True).json()
    note = client.get("/api/note", params={"path": "Home/Shopping.md"}, headers=TAB).json()
    client.put("/api/note", json={"path": "Home/Shopping.md", "content": f"![]({own['link']}) ![]({shared['link']})\n",
                                  "base_hash": note["hash"]}, headers=TAB)
    cake = client.get("/api/note", params={"path": "Home/Recipes/Cake.md"}, headers=TAB).json()
    client.put("/api/note", json={"path": "Home/Recipes/Cake.md", "content": "![[Shopping 2.jpg]]\n",
                                  "base_hash": cake["hash"]}, headers=TAB)
    offered = client.get("/api/files/own", params={"path": "Home/Shopping.md"}, headers=TAB).json()["paths"]
    assert offered == [own["path"]]
    # Asked to take both: the shared one stays, whatever the request says.
    gone = client.delete("/api/files", params={"path": "Home/Shopping.md", "along": [own["path"], shared["path"]]},
                         headers=TAB).json()
    assert gone == {"files": 2}
    assert not (filled / "Home" / "Attachments" / "Shopping 1.jpg").exists()
    assert (filled / "Home" / "Attachments" / "Shopping 2.jpg").exists()
    entries = client.get("/api/trash", headers=TAB).json()
    # Shown as the note, not as the folder the note and its files share.
    assert len(entries) == 1 and entries[0]["files"] == 2 and entries[0]["path"] == "Home/Shopping.md"
    client.post(f"/api/trash/{entries[0]['id']}/restore", headers=TAB)
    assert (filled / "Home" / "Shopping.md").exists() and (filled / "Home" / "Attachments" / "Shopping 1.jpg").exists()


def test_a_deleted_attachment_waits_in_the_trash_folder_and_comes_back(client: TestClient, filled: Path) -> None:
    data = bytes(range(256)) * 1000
    body = upload(client, data, name="clip.bin").json()
    with SessionLocal() as db:
        file_id = db.scalar(select(File.id).where(File.path == body["path"]))
    client.delete("/api/files", params={"path": body["path"]}, headers=TAB)
    waiting = paths.trash_root() / str(file_id)
    assert waiting.read_bytes() == data and not (filled / "Home" / "Attachments" / "clip.bin").exists()
    entry = client.get("/api/trash", headers=TAB).json()[0]["id"]
    assert client.post(f"/api/trash/{entry}/restore", headers=TAB).status_code == 200
    assert (filled / "Home" / "Attachments" / "clip.bin").read_bytes() == data and not waiting.exists()
    client.delete("/api/files", params={"path": body["path"]}, headers=TAB)
    entry = client.get("/api/trash", headers=TAB).json()[0]["id"]
    client.delete(f"/api/trash/{entry}", headers=TAB)
    assert not waiting.exists()


def test_a_note_that_cannot_leave_the_disk_stays_whole_in_the_trash(
    client: TestClient, filled: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import vault as service

    note = client.get("/api/note", params={"path": "Home/Recipes/Cake.md"}, headers=TAB).json()
    # Changed on disk a moment ago; then the folder is deleted and the second file is held open by another program.
    (filled / "Home" / "Recipes" / "Cake.md").write_text("# Cake\n\nNewest words.\n", encoding="utf-8")
    put(filled, "Home/Recipes/Bread.md", "# Bread\n")
    index.scan()
    assert note
    real = service._unlink
    calls: list[Path] = []

    def held_open(path: Path) -> bool:
        calls.append(path)
        return False if len(calls) == 2 else real(path)

    monkeypatch.setattr(service, "_unlink", held_open)
    assert client.delete("/api/files", params={"path": "Home/Recipes"}, headers=TAB).status_code == 200
    entry = client.get("/api/trash", headers=TAB).json()[0]
    assert entry["files"] == 2
    monkeypatch.setattr(service, "_unlink", real)
    for path in list((filled / "Home" / "Recipes").glob("*.md")):
        path.unlink()
    client.post(f"/api/trash/{entry['id']}/restore", headers=TAB)
    assert (filled / "Home" / "Recipes" / "Cake.md").read_text(encoding="utf-8") == "# Cake\n\nNewest words.\n"


def test_file_settings_are_the_operators(client: TestClient, filled: Path, account: Account) -> None:
    client.cookies.clear()
    assert client.get("/api/settings/files", headers=TAB).status_code == 401
    sign_in(client, make_account("member"))
    assert client.get("/api/settings/files", headers=TAB).status_code == 403
    sign_in(client, account)
    current = client.get("/api/settings/files", headers=TAB).json()
    assert current == {"attachment_folder": "Attachments", "upload_max_mb": 1024, "quota_mb": 0, "strip_location": True}
    bad = client.put("/api/settings/files", json={**current, "attachment_folder": "a/b"}, headers=TAB)
    assert bad.status_code == 400
    # A name of its own, umlaut and all: the link keeps the letters as they are.
    client.put("/api/settings/files", json={**current, "attachment_folder": "Anhänge"}, headers=TAB)
    placed = upload(client, b"x", name="x.txt").json()
    assert placed["path"] == "Home/Anhänge/x.txt" and placed["link"] == "Anhänge/x.txt"


def test_an_upload_beyond_the_space_left_stops_before_a_byte_is_stored(client: TestClient, filled: Path) -> None:
    from app.services import attachments
    from app.services.vault import Actor

    settings(quota_mb=1)
    plan = attachments.plan(
        note="Home/Shopping.md", folder=None, name="huge.bin", pasted=False, actor=Actor(name="tester", client="tab-a")
    )
    # Refused on the declared size alone, before the body is read into a file.
    with pytest.raises(attachments.VaultError) as refused:
        attachments.check_size(plan, 2 * 1024 * 1024)
    assert refused.value.code == "quota_exceeded"


def test_a_pdf_moved_or_renamed_is_found_by_its_new_name_in_the_middle_of_a_word(
    client: TestClient, filled: Path
) -> None:
    """Review before 1.0.0, P4.17: the trigram index keeps no text of its own and must be told a new title."""
    body = upload(client, pdf("zebracorn meadow"), name="Leaflet.pdf").json()

    def middle(q: str) -> list[str]:
        return [hit["path"] for hit in client.get("/api/search", params={"q": q}, headers=TAB).json()]

    moved = client.post("/api/move", json={"source": body["path"], "destination": "Home/Faltblatt.pdf"}, headers=TAB)
    assert moved.status_code == 200, moved.text
    assert middle("altblat") == ["Home/Faltblatt.pdf"]
    # Renamed outside the app: the next pass finds the same content under a new name.
    (filled / "Home" / "Faltblatt.pdf").rename(filled / "Home" / "Prospekt.pdf")
    index.scan()
    assert middle("rospek") == ["Home/Prospekt.pdf"]
    assert middle("altblat") == []
