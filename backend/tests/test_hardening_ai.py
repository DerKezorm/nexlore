"""Security review before 1.0.0: the address of an AI service is no way into the own network.

A member enters the address of their own service. Public addresses go; the own network and this machine only when
the operator listed the host (Ollama at home), link-local (169.254.169.254) never. Redirects are not followed, the
answer of a host in the own network is never shown in words, and an answer is read up to a limit.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.models import Account
from app.security import brake
from app.services import ai

from .test_ai import KEY, Service, open_lock, person, service  # noqa: F401  (the fixture is used by name)


def resolving_to(monkeypatch: pytest.MonkeyPatch, *addresses: str) -> None:
    monkeypatch.setattr(ai, "resolver", lambda host, port: list(addresses))


def models(who: TestClient, url: str = "http://ai.example.test/v1"):
    return who.post("/api/ai/models", json={"url": url, "key": KEY})


@pytest.mark.parametrize(("addresses", "code"), [
    (("169.254.169.254",), "ai_address_refused"),
    (("fe80::1",), "ai_address_refused"),
    (("0.0.0.0",), "ai_address_refused"),
    (("192.168.1.20",), "ai_address_private"),
    (("10.0.0.5",), "ai_address_private"),
    (("127.0.0.1",), "ai_address_private"),
    (("::1",), "ai_address_private"),
    (("::ffff:192.168.1.1",), "ai_address_private"),
    (("93.184.216.34", "192.168.1.20"), "ai_address_private"),
])
def test_the_own_network_is_refused_unless_listed(client: TestClient, account: Account, service: Service,  # noqa: F811
                                                  monkeypatch: pytest.MonkeyPatch, addresses: tuple, code: str) -> None:
    open_lock(client)
    resolving_to(monkeypatch, *addresses)
    refused = models(person("anna"))
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == code
    assert service.requests == []


def test_a_host_the_operator_listed_may_be_in_the_own_network(client: TestClient, account: Account,
                                                              service: Service,  # noqa: F811
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    open_lock(client)
    assert client.put("/api/settings", json={"ai_private_hosts": " Ollama.LAN:11434 \n192.168.1.30"}).json()[
        "ai_private_hosts"] == "ollama.lan:11434\n192.168.1.30"
    resolving_to(monkeypatch, "192.168.1.20")
    anna = person("anna")
    assert models(anna, "http://ollama.lan:11434/v1").status_code == 200
    assert models(anna, "http://ollama.lan:8080/v1").json()["detail"]["code"] == "ai_address_private"
    resolving_to(monkeypatch, "192.168.1.30")
    assert models(anna, "http://192.168.1.30:11434/v1").status_code == 200
    resolving_to(monkeypatch, "169.254.169.254")
    assert client.put("/api/settings", json={"ai_private_hosts": "metadata"}).status_code == 200
    assert models(anna, "http://metadata/v1").json()["detail"]["code"] == "ai_address_refused"


def test_the_operator_list_takes_hosts_only(client: TestClient, account: Account) -> None:
    for bad in ("http://ollama.lan", "ollama lan", "a/b", "host:port"):
        assert client.put("/api/settings", json={"ai_private_hosts": bad}).status_code == 422, bad


def test_a_redirect_is_never_followed(client: TestClient, account: Account, service: Service) -> None:  # noqa: F811
    open_lock(client)
    service.answer = lambda request: httpx.Response(302, headers={"location": "http://192.168.1.1/admin"})
    answer = models(person("anna"))
    assert answer.status_code == 502 and answer.json()["detail"]["answered"] == 302
    assert len(service.requests) == 1


def test_the_words_of_a_host_in_the_own_network_are_never_shown(client: TestClient, account: Account,
                                                                 service: Service,  # noqa: F811
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    open_lock(client)
    service.answer = lambda request: httpx.Response(500, json={"error": {"message": "router password is hunter2"}})
    anna = person("anna")
    public = models(anna).json()["detail"]
    assert public["said"] == "router password is hunter2"
    client.put("/api/settings", json={"ai_private_hosts": "ai.example.test"})
    resolving_to(monkeypatch, "192.168.1.20")
    private = models(anna).json()["detail"]
    assert private["answered"] == 500 and private["said"] == ""


def test_an_answer_is_read_up_to_a_limit(client: TestClient, account: Account, service: Service,  # noqa: F811
                                         monkeypatch: pytest.MonkeyPatch) -> None:
    open_lock(client)
    monkeypatch.setattr(ai, "MAX_ANSWER", 1000)
    service.answer = lambda request: httpx.Response(200, content=b"x" * 5000)
    answer = models(person("anna"))
    assert answer.status_code == 502 and answer.json()["detail"]["code"] == "ai_unreadable"


def test_asking_for_model_lists_has_an_hourly_limit(client: TestClient, account: Account,
                                                    service: Service) -> None:  # noqa: F811
    open_lock(client)
    anna = person("anna")
    answers = [models(anna).status_code for _ in range(31)]
    assert answers[:30] == [200] * 30 and answers[-1] == 429
    brake.forget()
