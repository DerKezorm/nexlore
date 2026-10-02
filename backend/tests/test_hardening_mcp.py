"""Security review before 1.0.0: hostile arguments over MCP answer as tool errors, never as server errors."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app

from .test_mcp import World, call, failure, rpc, world  # noqa: F401  (the fixture is used by name)


def raw_call(token: str, tool: str, **arguments: object):
    """A tool call sent as ASCII JSON, the way a client sends a lone surrogate (a client library cannot encode it)."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
    return TestClient(app, base_url="http://testserver").post(
        "/api/mcp", content=body.encode("ascii"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})


def test_a_lone_surrogate_in_any_text_is_a_tool_error(world: World) -> None:  # noqa: F811
    token = world.key("write")
    for tool, arguments in (
        ("read_note", {"path": "\ud800"}),
        ("search", {"query": "\ud800"}),
        ("list_tasks", {"query": "\ud800"}),
        ("create_note", {"folder": "Garden", "title": "\ud800", "content": "x"}),
    ):
        answer = raw_call(token, tool, **arguments)
        assert answer.status_code == 200, (tool, answer.status_code)
        assert "not valid Unicode" in failure(answer.json()["result"])


def test_a_lone_surrogate_waiting_for_approval_is_refused_before_it_waits(world: World) -> None:  # noqa: F811
    token = world.key("write", ask=True)
    answer = raw_call(token, "create_note", folder="Garden", title="Asked", content="\ud800")
    assert "not valid Unicode" in failure(answer.json()["result"])
    assert world.anna.get("/api/mcp/requests").json() == []


def test_arguments_nested_too_deep_never_reach_the_list_of_requests(world: World) -> None:  # noqa: F811
    token = world.key("write", ask=True)
    value: object = "x"
    for _ in range(100):
        value = [value]
    result = call(token, "set_property", path="Garden/Plan.md", key="k", value=value)
    assert "nested deeper" in failure(result)
    listed = world.anna.get("/api/mcp/requests")
    assert listed.status_code == 200
    assert listed.json() == []


def test_a_number_past_64_bits_is_a_tool_error_not_a_failed_request(world: World) -> None:  # noqa: F811
    token = world.key("read")
    answer = rpc(token, "tools/call", {"name": "read_version", "arguments": {"version": 2**70}})
    assert answer.status_code == 200
    assert "too large" in failure(answer.json()["result"])


def test_a_surrogate_in_an_ordinary_route_is_a_plain_422(client: TestClient, world: World) -> None:  # noqa: F811
    answer = world.anna.post("/api/notes", content=b'{"folder": "Garden", "title": "\\ud800"}',
                             headers={"Content-Type": "application/json"})
    assert answer.status_code == 422
