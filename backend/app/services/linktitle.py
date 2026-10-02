"""The title of a web page, for an address pasted into a note (the editor makes it the link's words).

**Closed until the operator opens it** (``link_titles_allowed``): the server then asks pages elsewhere on behalf of
the person pasting, and whoever runs the page learns that someone at this server pasted its address.

A server asking addresses it is handed must never be turned against its own network: only ``http`` and ``https``,
the name is resolved here and every address it gives must be public (no loopback, private, link-local, shared,
reserved or multicast one), and the connection goes to exactly the address checked (the name stays in the ``Host``
header and in TLS, so the certificate is still checked for it: no second lookup that could answer otherwise).
Redirects are followed by hand, at most ``MAX_REDIRECTS``, each checked again. Only HTML, at most ``MAX_BYTES`` read,
``TIMEOUT`` seconds for all of it. The log names the host, never the whole address (it may hold a key).
"""

from __future__ import annotations

import html
import ipaddress
import logging
import re
import socket
import time
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

import httpx

logger = logging.getLogger("nexlore.linktitle")

TIMEOUT = 5.0
MAX_BYTES = 256 * 1024
MAX_REDIRECTS = 3
MAX_TITLE = 200
MAX_URL = 2000
AGENT = "nexlore (link title)"

#: What one tag may be long; a page whose <meta> runs on for longer is not read for its title.
TAG_LIMIT = 4096
#: Within one <meta> tag only (bounded by TAG_LIMIT), never over the whole page.
_META_TITLE = re.compile(rb"(?:property|name)\s*=\s*[\"'](?:og:title|twitter:title)[\"']", re.IGNORECASE)
_META_CONTENT = re.compile(rb"content\s*=\s*[\"']([^\"']*)[\"']", re.IGNORECASE)
_CHARSET = re.compile(r"charset=([\w-]+)", re.IGNORECASE)


class TitleError(ValueError):
    """Why no title came: the address, the network, or the page."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


#: Resolves a name to addresses; the tests put their own in.
Resolver = Callable[[str, int], list[str]]


def _resolve(host: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise TitleError("not_found") from exc
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def public(address: str) -> bool:
    """Whether an address lies outside every own, shared or special network."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    special = ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local or ip.is_private
    return ip.is_global and not special


def _checked(url: str, resolve: Resolver) -> tuple[str, str, int, str]:
    """The address split up, with the one checked address to connect to: (scheme, host, port, ip)."""
    if len(url) > MAX_URL:
        raise TitleError("bad_address")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise TitleError("bad_address")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise TitleError("bad_address") from exc
    host = parts.hostname
    addresses = resolve(host, port)
    if not addresses or not all(public(address) for address in addresses):
        raise TitleError("not_public")
    return parts.scheme, host, port, addresses[0]


def _title_tag(body: bytes) -> bytes | None:
    """The text of the first <title>, found by plain searching. The pattern before took time growing with the square
    of the page for every "<title" without its end: 64 KB of them held the server for minutes (review before 1.0.0)."""
    lower = body.lower()
    start = lower.find(b"<title")
    if start == -1:
        return None
    opened = lower.find(b">", start, start + TAG_LIMIT)
    if opened == -1:
        return None
    closed = lower.find(b"</title", opened)
    return body[opened + 1 : closed] if closed != -1 else None


def _meta_title(body: bytes) -> bytes | None:
    """og:title or twitter:title, each <meta> looked at alone and only up to TAG_LIMIT."""
    lower = body.lower()
    at = lower.find(b"<meta")
    while at != -1:
        end = lower.find(b">", at, at + TAG_LIMIT)
        if end == -1:
            return None
        tag = body[at:end]
        if _META_TITLE.search(tag):
            found = _META_CONTENT.search(tag)
            if found:
                return found.group(1)
        at = lower.find(b"<meta", end)
    return None


def _has_title(body: bytes) -> bool:
    """Whether reading may stop: a closed <title> is there."""
    lower = body.lower()
    start = lower.find(b"<title")
    return start != -1 and lower.find(b"</title", start) != -1


def _title_of(body: bytes, content_type: str) -> str | None:
    raw = _title_tag(body) or _meta_title(body)
    if raw is None:
        return None
    charset = _CHARSET.search(content_type)
    try:
        text = raw.decode(charset.group(1) if charset else "utf-8", errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    clean = " ".join(html.unescape(text).split())
    return clean[:MAX_TITLE] or None


def fetch(url: str, *, resolve: Resolver = _resolve, transport: httpx.BaseTransport | None = None) -> str | None:
    """The page's title; None when it has none. Raises ``TitleError`` for an address that may not be asked or a page
    that does not answer as a page."""
    deadline = time.monotonic() + TIMEOUT
    with httpx.Client(transport=transport, follow_redirects=False, trust_env=False) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            scheme, host, port, ip = _checked(url, resolve)
            parts = urlsplit(url)
            target = f"[{ip}]" if ":" in ip else ip
            direct = parts._replace(netloc=f"{target}:{port}").geturl()
            left = deadline - time.monotonic()
            if left <= 0:
                raise TitleError("timeout")
            named = host if port in (80, 443) else f"{host}:{port}"
            headers = {"Host": named, "User-Agent": AGENT, "Accept": "text/html"}
            # TLS asks for the name and checks the certificate for it, though the connection goes to the address.
            extensions = {"sni_hostname": host} if scheme == "https" else {}
            try:
                with client.stream("GET", direct, headers=headers, timeout=left, extensions=extensions) as answer:
                    if answer.status_code in (301, 302, 303, 307, 308):
                        location = answer.headers.get("location")
                        if not location:
                            raise TitleError("no_page")
                        url = urljoin(url, location)
                        continue
                    content_type = answer.headers.get("content-type", "")
                    if answer.status_code != 200 or "html" not in content_type.lower():
                        raise TitleError("no_page")
                    body = b""
                    for chunk in answer.iter_bytes():
                        body += chunk
                        if len(body) >= MAX_BYTES or _has_title(body):
                            break
                        if time.monotonic() > deadline:
                            raise TitleError("timeout")
            except httpx.TimeoutException as exc:
                raise TitleError("timeout") from exc
            except httpx.HTTPError as exc:
                logger.info("Link title not reached host=%s error=%s", host, type(exc).__name__)
                raise TitleError("unreachable") from exc
            return _title_of(body[:MAX_BYTES], content_type)
    raise TitleError("too_many_redirects")
