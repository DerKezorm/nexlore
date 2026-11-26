"""Programs name no browser tab: the guard of changing requests (``middleware.GuardMiddleware``, 400
``client_required``) lets the ways of OAuth for AI programs through without ``X-Nexlore-Client``, old and new (the
shared module mcp 1.1.0 adds ``/api/oauth/revoke``), and still stops a page that sends a change elsewhere without it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

#: Every way a program posts to; none may answer 400 ``client_required``.
PROGRAM_WAYS = ("/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke", "/api/mcp")


@pytest.mark.parametrize("path", PROGRAM_WAYS)
def test_a_program_without_a_tab_gets_through_to_its_ways(path: str) -> None:
    program = TestClient(app, base_url="http://testserver")
    answer = program.post(path, data={"grant_type": "refresh_token", "token": "x"})
    body = answer.json() if answer.headers.get("content-type", "").startswith("application/json") else {}
    assert (body.get("detail") or {}).get("code") != "client_required", (path, answer.status_code, answer.text)


def test_a_page_without_a_tab_is_still_stopped_on_another_changing_way() -> None:
    page = TestClient(app, base_url="http://testserver")
    answer = page.post("/api/connections/keys", json={"kind": "mcp", "name": "x"})
    assert answer.status_code == 400 and answer.json()["detail"]["code"] == "client_required"
