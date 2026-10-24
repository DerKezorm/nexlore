"""The cover flow: one level of the vault as cards, and the cover pictures of spaces and folders. Who sees what (a
reader everything of the space, a stranger not even that it is there), what a card carries, and that a cover goes
where its folder goes and leaves with it."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.routers import covers as covers_router
from app.services import covers, index

from .conftest import join, make_account, sign_in
from .test_media import exif_bytes


def person(name: str) -> TestClient:
    client = TestClient(app, base_url="http://testserver", headers={"X-Nexlore-Client": f"tab-{name:0<8}"})
    sign_in(client, make_account(name))
    return client


def put(root: Path, rel: str, content: str | bytes) -> None:
    path = root.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)


def photo(size: tuple[int, int] = (400, 300), colour: tuple[int, int, int] = (200, 30, 30), fmt: str = "JPEG") -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, format=fmt, exif=exif_bytes())
    return out.getvalue()


def halves(fmt: str = "PNG") -> bytes:
    """Wide: red on the left, blue on the right."""
    image = Image.new("RGB", (800, 300), (220, 20, 20))
    image.paste((20, 20, 220), (400, 0, 800, 300))
    out = io.BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


@pytest.fixture
def people(client: TestClient, account: object, vault: Path) -> tuple[TestClient, TestClient, TestClient]:
    """anna manages "Garden" and "Private"; bob reads Garden; carl has nothing to do with either."""
    anna, bob, carl = person("anna"), person("bob"), person("carl")
    for name in ("Garden", "Private"):
        assert anna.post("/api/spaces", json={"name": name}).status_code == 201
    put(vault, "Garden/Beds/Roses/Red.md", "# Red\n\nThorny.\n")
    put(vault, "Garden/Beds/Tulips.md", "# Tulips\n\nIn spring.\n")
    put(vault, "Garden/Beds/Lilies.md", "# Lilies\n")
    put(vault, "Garden/Tools/Spade.md", "# Spade\n")
    put(vault, "Garden/Attachments/rose.png", photo(fmt="PNG"))
    put(vault, "Private/Attachments/secret.png", photo(colour=(10, 200, 10), fmt="PNG"))
    put(
        vault,
        "Garden/Plan 10.md",
        "---\ntags: [spring]\n---\n# Plan 10\n\n![[rose.png]]\n\nDig the **beds** in [[Beds/Tulips|March]], %%not this%%"
        " then water.\n\n#roses\n",
    )
    put(vault, "Garden/Plan 9.md", "# Plan 9\n\n![[Private/Attachments/secret.png]]\n\nSecond plan.\n")
    index.scan()
    join(anna, "Garden", "bob", "read")
    return anna, bob, carl


def level(client: TestClient, path: str = "") -> dict:
    answer = client.get("/api/coverflow", params={"path": path} if path else None)
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_the_top_level_is_the_spaces_one_may_read(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, bob, carl = people
    assert [item["name"] for item in level(anna)["items"]] == ["Garden", "Private"]
    garden = level(bob)["items"]
    assert [item["name"] for item in garden] == ["Garden"]
    # Notes lying directly in it, and its folders: what the card says.
    assert garden[0] | {"cover": None} == {
        "kind": "folder", "name": "Garden", "path": "Garden", "space": True, "folders": 3, "notes": 2,
        "cover": None, "icon": None, "color": None, "writable": False,
    }
    assert level(anna)["items"][0]["writable"] is True
    assert level(carl)["items"] == []


def test_a_folder_level_has_its_folders_then_its_notes_each_with_what_its_card_shows(
    people: tuple[TestClient, TestClient, TestClient],
) -> None:
    _, bob, _ = people
    answer = level(bob, "Garden")
    folders = [item for item in answer["items"] if item["kind"] == "folder"]
    notes = [item for item in answer["items"] if item["kind"] == "note"]
    assert [(item["name"], item["folders"], item["notes"]) for item in folders] == [
        ("Attachments", 0, 0), ("Beds", 1, 2), ("Tools", 0, 1),
    ]
    assert answer["items"][: len(folders)] == folders
    # Named as people count: 9 before 10.
    assert [item["name"] for item in notes] == ["Plan 9", "Plan 10"]
    plan = notes[1]
    assert plan["path"] == "Garden/Plan 10.md"
    # Words only: no title again, no picture, no marks, no comment, the link as its text.
    assert plan["excerpt"] == "Dig the beds in March, then water. #roses"
    assert plan["tags"] == ["spring", "roses"]
    assert plan["image"] == "Garden/Attachments/rose.png"
    assert isinstance(plan["modified"], int)
    assert answer["writable"] is False and answer["total_notes"] == 2


def test_a_picture_from_a_space_the_reader_may_not_read_stays_off_the_card(
    people: tuple[TestClient, TestClient, TestClient],
) -> None:
    anna, bob, _ = people
    of = {item["name"]: item for item in level(anna, "Garden")["items"]}
    assert of["Plan 9"]["image"] == "Private/Attachments/secret.png"
    of = {item["name"]: item for item in level(bob, "Garden")["items"]}
    assert of["Plan 9"]["image"] is None


def test_a_stranger_finds_neither_a_level_nor_a_cover(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, _, carl = people
    assert anna.put("/api/cover", params={"path": "Garden/Beds"}, content=photo()).status_code == 200
    assert carl.get("/api/coverflow", params={"path": "Garden"}).status_code == 404
    assert carl.get("/api/cover", params={"path": "Garden/Beds"}).status_code == 404
    assert carl.put("/api/cover", params={"path": "Garden/Beds"}, content=photo()).status_code == 404
    assert carl.delete("/api/cover", params={"path": "Garden/Beds"}).status_code == 404
    # The same answer as a folder that is not there.
    assert anna.get("/api/coverflow", params={"path": "Garden/Nowhere"}).status_code == 404


def test_a_writer_sets_a_cover_every_reader_sees_it_and_only_a_writer_removes_it(
    people: tuple[TestClient, TestClient, TestClient], vault: Path,
) -> None:
    anna, bob, _ = people
    assert bob.put("/api/cover", params={"path": "Garden/Beds"}, content=photo()).status_code == 403
    answer = anna.put("/api/cover", params={"path": "Garden/Beds"}, content=photo())
    assert answer.status_code == 200, answer.text
    version = answer.json()["cover"]
    assert isinstance(version, int)
    stored = vault / "Garden" / "Beds" / ".cover.webp"
    data = stored.read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        assert image.format == "WEBP" and image.size == (covers.WIDTH, covers.HEIGHT)
    # Nothing of the photo but its pixels: no device, no place.
    assert b"PhoneMaker" not in data and b"SERIAL-4711" not in data and b"Exif" not in data
    seen = bob.get("/api/cover", params={"path": "Garden/Beds"})
    assert seen.status_code == 200 and seen.content == data
    assert seen.headers["content-type"] == "image/webp"
    beds = next(item for item in level(bob, "Garden")["items"] if item["name"] == "Beds")
    assert beds["cover"] == version
    # The hidden file is no folder, no note, no attachment.
    assert all(not item["name"].startswith(".") for item in level(bob, "Garden/Beds")["items"])
    assert bob.delete("/api/cover", params={"path": "Garden/Beds"}).status_code == 403
    assert anna.delete("/api/cover", params={"path": "Garden/Beds"}).status_code == 204
    assert not stored.exists()
    assert bob.get("/api/cover", params={"path": "Garden/Beds"}).status_code == 404
    # A space has one too.
    assert anna.put("/api/cover", params={"path": "Garden"}, content=photo()).status_code == 200
    assert (vault / "Garden" / ".cover.webp").is_file()
    assert level(bob)["items"][0]["cover"] is not None


def test_the_focus_chooses_which_part_of_a_picture_stays(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, _, _ = people

    def middle(focus: float) -> tuple[int, int, int]:
        assert anna.put("/api/cover", params={"path": "Garden/Tools", "focus": focus}, content=halves()).status_code == 200
        with Image.open(io.BytesIO(anna.get("/api/cover", params={"path": "Garden/Tools"}).content)) as image:
            return image.convert("RGB").getpixel((covers.WIDTH // 2, covers.HEIGHT // 2))

    left, right = middle(0), middle(100)
    assert left[0] > 150 and left[2] < 80
    assert right[2] > 150 and right[0] < 80


def test_only_pictures_become_covers(people: tuple[TestClient, TestClient, TestClient]) -> None:
    anna, _, _ = people
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    # A TIFF the decoder would open (as it would PSD and EPS, which starts Ghostscript): not taken.
    tiff = io.BytesIO()
    Image.new("RGB", (20, 20)).save(tiff, "TIFF")
    for data in (svg, b"plain words", b"\x89PNG\r\n\x1a\n broken", tiff.getvalue()):
        answer = anna.put("/api/cover", params={"path": "Garden/Beds"}, content=data)
        assert answer.status_code == 422 and answer.json()["detail"]["code"] == "cover_not_a_picture"
    # Only folders have covers.
    assert anna.put("/api/cover", params={"path": "Garden/Beds/Tulips.md"}, content=photo()).status_code == 404


def test_an_image_of_the_vault_becomes_a_cover_only_where_the_writer_may_read_it(
    people: tuple[TestClient, TestClient, TestClient], vault: Path,
) -> None:
    anna, bob, carl = people
    params = {"path": "Garden/Beds", "source": "Garden/Attachments/rose.png"}
    assert anna.put("/api/cover", params=params).status_code == 200
    assert (vault / "Garden" / "Beds" / ".cover.webp").is_file()
    # A note is no picture, a file the index does not know is none either.
    assert anna.put("/api/cover", params={"path": "Garden/Beds", "source": "Garden/Plan 9.md"}).status_code == 404
    # Nor is a hidden file: no path reaches one.
    assert anna.put("/api/cover", params={"path": "Garden/Beds", "source": "Garden/Beds/.cover.webp"}).status_code == 400
    # carl writes in a space of his own, but cannot take a picture he may not read.
    assert carl.post("/api/spaces", json={"name": "Shed"}).status_code == 201
    answer = carl.put("/api/cover", params={"path": "Shed", "source": "Private/Attachments/secret.png"})
    assert answer.status_code == 404
    assert bob.put("/api/cover", params=params).status_code == 403


def test_a_cover_moves_with_its_folder_and_leaves_with_it(
    people: tuple[TestClient, TestClient, TestClient], vault: Path,
) -> None:
    anna, _, _ = people
    assert anna.put("/api/cover", params={"path": "Garden/Tools"}, content=photo()).status_code == 200
    assert anna.post("/api/move", json={"source": "Garden/Tools", "destination": "Garden/Beds/Gear"}).status_code == 200
    assert (vault / "Garden" / "Beds" / "Gear" / ".cover.webp").is_file()
    assert anna.get("/api/cover", params={"path": "Garden/Beds/Gear"}).status_code == 200
    # Into the trash: the cover goes too, and the folder leaves the disk instead of staying for a hidden file.
    assert anna.put("/api/cover", params={"path": "Garden/Beds"}, content=photo()).status_code == 200
    assert anna.request("DELETE", "/api/files", params={"path": "Garden/Beds"}).status_code == 200
    assert not (vault / "Garden" / "Beds").exists()


def test_a_level_of_very_many_notes_shows_the_first_and_says_how_many(
    people: tuple[TestClient, TestClient, TestClient], monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, bob, _ = people
    monkeypatch.setattr(covers_router, "MAX_NOTES", 2)
    answer = level(bob, "Garden/Beds")
    assert answer["total_notes"] == 2
    monkeypatch.setattr(covers_router, "MAX_NOTES", 1)
    answer = level(bob, "Garden/Beds")
    assert answer["total_notes"] == 2
    assert [item["name"] for item in answer["items"] if item["kind"] == "note"] == ["Lilies"]


def test_a_long_text_is_cut_at_a_word() -> None:
    body = "# Title\n\n" + " ".join(f"word{number}" for number in range(200))
    cut = covers_router._excerpt(body, "Title")
    assert cut.endswith("…") and len(cut) <= covers_router.EXCERPT + 1
    assert cut[:-1].split()[-1].startswith("word") and not cut.startswith("Title")
