"""Health, about, the security headers, the error shape, and the built frontend with its path guard."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import __version__
from app.main import _mount_frontend


def test_health_and_about(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok", "version": __version__}
    about = client.get("/api/about").json()
    assert about["version"] == __version__ and about["license"] == "AGPL-3.0"


def test_every_answer_carries_the_security_headers(client: TestClient) -> None:
    for response in (client.get("/api/health"), client.get("/api/nothing-here")):
        headers = response.headers
        csp = headers["content-security-policy"]
        assert "script-src" not in csp or "'unsafe-inline'" not in csp.split("script-src", 1)[1].split(";", 1)[0]
        assert "default-src 'self'" in csp and "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["x-frame-options"] == "DENY"
        assert headers["referrer-policy"] == "same-origin"


def test_invalid_input_names_the_field_with_a_code(client: TestClient, operator: str) -> None:
    response = client.put("/api/logs/level", json={"mode": "loud"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_input"
    assert response.json()["detail"]["fields"] == ["mode"]


def test_api_docs_are_off_by_default(client: TestClient) -> None:
    assert client.get("/api/docs").status_code == 404
    assert client.get("/api/openapi.json").status_code == 404


def _built(tmp_path: Path) -> TestClient:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_bytes(b"<!doctype html><title>nexlore</title>")
    (dist / "assets" / "app.js").write_bytes(b"console.log(1)")
    (dist / "favicon.svg").write_bytes(b"<svg/>")
    (tmp_path / "secret.txt").write_bytes(b"outside")
    app = FastAPI()
    _mount_frontend(app, dist)
    return TestClient(app)


def test_the_frontend_serves_files_and_falls_back_to_the_start_page(tmp_path: Path) -> None:
    client = _built(tmp_path)
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert client.get("/favicon.svg").text == "<svg/>"
    start = client.get("/notes/some/deep/link")
    assert "<title>nexlore</title>" in start.text and start.headers["cache-control"] == "no-cache"


def test_the_frontend_never_serves_outside_its_directory(tmp_path: Path) -> None:
    client = _built(tmp_path)
    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt"):
        assert "outside" not in client.get(path).text, path


def test_unknown_api_paths_are_404_not_the_start_page(tmp_path: Path) -> None:
    client = _built(tmp_path)
    for path in ("/api", "/api/", "/api/nothing"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json()["detail"]["code"] == "not_found"
