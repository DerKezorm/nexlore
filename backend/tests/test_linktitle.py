"""Titles of pasted links: the page's title, and never a way into the server's own network."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.routers import linktitle as route
from app.services import linktitle, settings_service

PUBLIC = "93.184.215.14"


def world(pages: dict[str, httpx.Response], names: dict[str, list[str]] | None = None, seen: list[httpx.Request] | None = None):
    """A made-up internet: `pages` by host and path (as asked, the host from the Host header), `names` for the lookups."""
    known = {"example.com": [PUBLIC], "www.example.com": [PUBLIC], **(names or {})}

    def resolve(host: str, port: int) -> list[str]:
        if host not in known:
            raise linktitle.TitleError("not_found")
        return known[host]

    def answer(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return pages.get(f"{request.headers['host']}{request.url.raw_path.decode()}", httpx.Response(404))

    return resolve, httpx.MockTransport(answer)


def page(body: str, content_type: str = "text/html; charset=utf-8") -> httpx.Response:
    return httpx.Response(200, headers={"content-type": content_type}, content=body.encode("utf-8"))


def test_the_title_of_a_page_its_words_cleaned() -> None:
    resolve, transport = world({
        "example.com/a": page("<html><head><title>\n  Tea &amp; Biscuits \n</title></head></html>"),
        "example.com/b": page('<meta property="og:title" content="Only the card">'),
        "example.com/c": page("<p>none</p>"),
        "example.com/d": httpx.Response(200, headers={"content-type": "text/html; charset=latin-1"}, content="<title>Käse</title>".encode("latin-1")),
    })
    get = lambda path: linktitle.fetch(f"https://example.com{path}", resolve=resolve, transport=transport)
    assert get("/a") == "Tea & Biscuits"
    assert get("/b") == "Only the card"
    assert get("/c") is None
    assert get("/d") == "Käse"


def test_the_connection_goes_to_the_address_checked_with_the_name_kept() -> None:
    seen: list[httpx.Request] = []
    resolve, transport = world({"example.com/": page("<title>Hi</title>")}, seen=seen)
    assert linktitle.fetch("https://example.com/", resolve=resolve, transport=transport) == "Hi"
    request = seen[0]
    assert request.url.host == PUBLIC
    assert request.headers["host"] == "example.com"
    assert request.extensions["sni_hostname"] == "example.com"


@pytest.mark.parametrize(
    "url, names",
    [
        ("http://localhost/", {"localhost": ["127.0.0.1"]}),
        ("http://intern.example.com/", {"intern.example.com": ["10.20.30.40"]}),
        ("http://router.example.com/", {"router.example.com": ["192.168.1.1"]}),
        ("http://meta.example.com/", {"meta.example.com": ["169.254.169.254"]}),
        ("http://cgnat.example.com/", {"cgnat.example.com": ["100.64.0.1"]}),
        ("http://v6.example.com/", {"v6.example.com": ["::1"]}),
        ("http://ula.example.com/", {"ula.example.com": ["fd00::1"]}),
        ("http://mapped.example.com/", {"mapped.example.com": ["::ffff:127.0.0.1"]}),
        # One public and one private address: refused, the second lookup could be the private one.
        ("http://both.example.com/", {"both.example.com": [PUBLIC, "10.0.0.1"]}),
        ("http://127.0.0.1/", {"127.0.0.1": ["127.0.0.1"]}),
    ],
)
def test_no_address_of_an_own_or_special_network_is_asked(url: str, names: dict[str, list[str]]) -> None:
    seen: list[httpx.Request] = []
    resolve, transport = world({}, names, seen)
    with pytest.raises(linktitle.TitleError) as caught:
        linktitle.fetch(url, resolve=resolve, transport=transport)
    assert caught.value.code == "not_public"
    assert seen == []


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/", "https://user:secret@example.com/", "javascript:alert(1)", "https://example.com:99999/"])
def test_only_web_addresses_without_credentials(url: str) -> None:
    resolve, transport = world({})
    with pytest.raises(linktitle.TitleError) as caught:
        linktitle.fetch(url, resolve=resolve, transport=transport)
    assert caught.value.code == "bad_address"


def test_a_redirect_is_checked_again_and_there_are_not_many() -> None:
    names = {"hop.example.com": [PUBLIC], "inside.example.com": ["10.1.2.3"]}
    seen: list[httpx.Request] = []
    resolve, transport = world({
        "example.com/go": httpx.Response(302, headers={"location": "https://www.example.com/there"}),
        "www.example.com/there": page("<title>Arrived</title>"),
        "example.com/in": httpx.Response(301, headers={"location": "http://inside.example.com/admin"}),
        "example.com/loop": httpx.Response(302, headers={"location": "/loop"}),
    }, names, seen)
    assert linktitle.fetch("https://example.com/go", resolve=resolve, transport=transport) == "Arrived"
    with pytest.raises(linktitle.TitleError) as inside:
        linktitle.fetch("https://example.com/in", resolve=resolve, transport=transport)
    assert inside.value.code == "not_public"
    seen.clear()
    with pytest.raises(linktitle.TitleError) as loop:
        linktitle.fetch("https://example.com/loop", resolve=resolve, transport=transport)
    assert loop.value.code == "too_many_redirects"
    # The first ask and three redirects followed, not one more.
    assert len(seen) == linktitle.MAX_REDIRECTS + 1


def test_only_a_page_and_only_its_beginning() -> None:
    long = "<html>" + "x" * (linktitle.MAX_BYTES + 10) + "<title>Too late</title>"
    resolve, transport = world({
        "example.com/pdf": page("%PDF-1.7", "application/pdf"),
        "example.com/gone": httpx.Response(404),
        "example.com/long": page(long),
    })
    for path, code in (("/pdf", "no_page"), ("/gone", "no_page")):
        with pytest.raises(linktitle.TitleError) as caught:
            linktitle.fetch(f"https://example.com{path}", resolve=resolve, transport=transport)
        assert caught.value.code == code
    assert linktitle.fetch("https://example.com/long", resolve=resolve, transport=transport) is None


def test_the_route_waits_for_the_operator_and_counts_the_asks(client: TestClient, account: object, monkeypatch: pytest.MonkeyPatch) -> None:
    route.forget()
    monkeypatch.setattr(linktitle, "fetch", lambda url: f"Title of {url}")
    closed = client.get("/api/link-title", params={"url": "https://example.com/"})
    assert (closed.status_code, closed.json()["detail"]["code"]) == (404, "link_titles_off")
    assert client.get("/api/auth/me").json()["link_titles"] is False
    with SessionLocal() as db:
        settings_service.save(db, {"link_titles_allowed": True})
    assert client.get("/api/auth/me").json()["link_titles"] is True
    assert client.get("/api/settings").json()["link_titles_allowed"] is True
    assert client.get("/api/link-title", params={"url": "https://example.com/"}).json() == {"title": "Title of https://example.com/"}
    monkeypatch.setattr(route, "PER_MINUTE", 2)
    assert client.get("/api/link-title", params={"url": "https://example.com/"}).status_code == 200
    slowed = client.get("/api/link-title", params={"url": "https://example.com/"})
    assert (slowed.status_code, slowed.json()["detail"]["code"]) == (429, "slow_down")
    route.forget()

    def refuse(url: str) -> str:
        raise linktitle.TitleError("not_public")

    monkeypatch.setattr(linktitle, "fetch", refuse)
    refused = client.get("/api/link-title", params={"url": "http://10.0.0.1/"})
    # The same answer as a name that does not resolve: nobody learns which inner names the server knows.
    assert (refused.status_code, refused.json()["detail"]["code"]) == (422, "link_not_found")
    route.forget()
