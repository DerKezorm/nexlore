"""The log routes: reading with filters, the level with its expiry, download, clear, operator only."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.services import logs, settings_service

probe = logging.getLogger("nexlore.probe")


@pytest.fixture(autouse=True)
def normal_mode_afterwards() -> Iterator[None]:
    """The level is process-wide; whatever a test sets, the next one starts at normal."""
    yield
    logs.apply_mode(logs.DEFAULT_MODE)


def test_without_an_operator_every_log_route_is_closed(client: TestClient) -> None:
    assert client.get("/api/logs").status_code == 401
    assert client.get("/api/logs/level").status_code == 401
    assert client.put("/api/logs/level", json={"mode": "trace"}).status_code == 401
    assert client.get("/api/logs/download").status_code == 401
    assert client.delete("/api/logs").status_code == 401
    assert logs.current_mode() == "normal"


def test_every_response_carries_a_request_id_and_the_lines_carry_it_too(client: TestClient, operator: str) -> None:
    logs.set_mode("detailed")
    first = client.get("/api/about")
    second = client.get("/api/about")
    first_id, second_id = first.headers["x-request-id"], second.headers["x-request-id"]
    assert len(first_id) == 6 and first_id != second_id
    lines = client.get("/api/logs", params={"search": first_id}).json()
    assert lines, "the request logged a line at detailed"
    assert all(line["request_id"] == first_id for line in lines)
    assert any("GET /api/about -> 200" in line["message"] for line in lines)


def test_the_level_filter_includes_higher_levels(client: TestClient, operator: str) -> None:
    probe.info("probe-levels info line")
    probe.warning("probe-levels warning line")
    probe.error("probe-levels error line")
    lines = client.get("/api/logs", params={"level": "WARNING", "search": "probe-levels"}).json()
    assert [line["level"] for line in lines] == ["ERROR", "WARNING"], "newest first, INFO left out"
    assert all(line["logger"] == "nexlore.probe" for line in lines)
    everything = client.get("/api/logs", params={"search": "probe-levels"}).json()
    assert [line["level"] for line in everything] == ["ERROR", "WARNING", "INFO"]
    assert client.get("/api/logs", params={"level": "LOUD"}).status_code == 422


def test_quiet_keeps_info_out_of_the_file(client: TestClient, operator: str) -> None:
    assert client.put("/api/logs/level", json={"mode": "quiet"}).status_code == 200
    probe.info("probe-quiet info line")
    probe.warning("probe-quiet warning line")
    text = logs.log_file().read_text(encoding="utf-8")
    assert "probe-quiet warning line" in text
    assert "probe-quiet info line" not in text


def test_a_deep_level_with_a_duration_expires(client: TestClient, operator: str) -> None:
    level = client.get("/api/logs/level").json()
    assert (level["mode"], level["until"], level["fixed_by_env"]) == ("normal", None, False)
    assert level["modes"] == ["quiet", "normal", "detailed", "trace"] and 30 in level["durations"]

    changed = client.put("/api/logs/level", json={"mode": "detailed", "minutes": 30})
    assert changed.status_code == 200, changed.text
    until = datetime.fromisoformat(changed.json()["until"])
    assert timedelta(minutes=29) < until - datetime.now(UTC) < timedelta(minutes=31)
    assert logs.current_mode() == "detailed"
    assert client.put("/api/logs/level", json={"mode": "trace", "minutes": 7}).status_code == 422

    # Time passes: the stored end lies in the past.
    with SessionLocal() as db:
        settings_service.save(db, {"log_mode_until": (datetime.now(UTC) - timedelta(minutes=1)).isoformat()})
    state = logs.state()
    assert (state.mode, state.until) == ("normal", None)
    assert logs.current_mode() == "normal"
    with SessionLocal() as db:
        assert settings_service.get(db, "log_mode") == "normal"
        assert settings_service.get(db, "log_mode_until") is None


def test_the_environment_fixes_the_level(client: TestClient, operator: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "log_level", "debug")
    assert client.get("/api/logs/level").json() == {
        "mode": "detailed", "until": None, "fixed_by_env": True,
        "modes": ["quiet", "normal", "detailed", "trace"], "durations": list(logs.ALLOWED_MINUTES),
    }
    refused = client.put("/api/logs/level", json={"mode": "quiet"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "log_level_from_environment"


def test_the_download_includes_rotated_files(client: TestClient, operator: str) -> None:
    probe.warning("probe-download current line")
    rotated = logs.log_dir() / "nexlore.log.1"
    rotated.write_bytes(b"2026-09-01 03:00:00 INFO     nexlore.probe [-] | probe-download older line\n")
    try:
        response = client.get("/api/logs/download")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        assert 'filename="nexlore-log-' in response.headers["content-disposition"]
        text = response.text
        assert "===== nexlore.log.1 =====" in text and "probe-download older line" in text
        assert "===== nexlore.log =====" in text and "probe-download current line" in text
        assert text.index("nexlore.log.1 =====") < text.index("===== nexlore.log ====="), "oldest first"
    finally:
        rotated.unlink(missing_ok=True)


def test_clear_empties_the_file_and_removes_rotated_ones(client: TestClient, operator: str) -> None:
    probe.warning("probe-clear marker line")
    rotated = logs.log_dir() / "nexlore.log.2"
    rotated.write_bytes(b"older\n")
    assert client.get("/api/logs", params={"search": "probe-clear"}).json()
    assert client.delete("/api/logs").status_code == 204
    assert not rotated.exists()
    assert "probe-clear marker line" not in logs.log_file().read_text(encoding="utf-8")
    assert any(line["message"] == "Log cleared by operator" for line in client.get("/api/logs").json())
    probe.warning("probe-clear after line")
    assert "probe-clear after line" in logs.log_file().read_text(encoding="utf-8")


def test_a_line_break_in_a_request_cannot_forge_a_record(client: TestClient, operator: str) -> None:
    logs.set_mode("detailed")
    forged = "2026-09-26 12:00:00 INFO     nexlore.auth [-] | probe-forged sign-in"
    client.get("/api/x%0d%0a" + forged.replace(" ", "%20"))
    lines = client.get("/api/logs", params={"search": "probe-forged"}).json()
    assert any(line["logger"] == "nexlore.api" for line in lines), "the request was logged"
    assert not any(line["logger"] == "nexlore.auth" for line in lines), lines
    raw = logs.log_file().read_text(encoding="utf-8")
    assert not any(line.startswith("2026-09-26 12:00:00") for line in raw.splitlines())
    assert "\\r\\n2026-09-26 12:00:00" in raw


def test_a_traceback_keeps_its_lines_and_stays_with_its_record(client: TestClient, operator: str) -> None:
    try:
        raise RuntimeError("probe-traceback boom")
    except RuntimeError:
        probe.exception("probe-traceback failed")
    lines = client.get("/api/logs", params={"search": "probe-traceback"}).json()
    assert len(lines) == 1 and "Traceback" in lines[0]["message"] and "\n" in lines[0]["message"]
