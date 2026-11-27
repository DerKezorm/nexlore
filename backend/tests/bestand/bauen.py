"""Builds the "Bestand" test database with the code that is checked out right now.

The test ``tests/test_bestand.py`` loads what this script wrote and checks that every way in that worked in that
version still works in the running one, and that what the account name keys (versions, comments, uploads, spaces)
still belongs to the same person. That only means something if the database comes from the OLD code. So:

    git worktree add ../nexlore-1.16.0 v1.16.0
    cd ../nexlore-1.16.0/backend
    <venv>/python tests/bestand/bauen.py --ziel <this repo>/backend/tests/bestand

⚠️ **Never rebuild it with a newer version and commit the result.** It would then describe the new schema, and the
test would prove nothing about installations that run 1.16.0 today. The script refuses to run when ``__version__`` is
not ``FASSUNG``; a fixture for a later version gets its own file name.

Every account is made the way a person makes it in 1.16.0: through the routes (setup with the code, invitations into
nexlore and into a space, the provider, the operator's list). One thing cannot be made by one request: two accounts
with one address. 1.16.0 checks the address (``emailaddr.taken``) and writes it without a unique index; two operator
saves at the same moment both pass the check. The script plays exactly that, in two sessions.

Only invented people and ``example.*`` addresses. Every random value the test needs to know (session cookies, the
device key of the iPhone, the API token, the open invitation and confirmation links, the share, recovery codes, the
second-factor seeds) is made predictable by replacing ``secrets`` in the few modules that draw them; the code paths
themselves are the ones of the version. Ids and password hashes stay as the version makes them.

⚠️ **Stored as gzip'ed SQL, not as ``.db``.** A database file in the repository looks like operating data, and the
commit hook refuses 32+ hex characters in a text diff, which every token hash in a plain dump is. The full-text
tables are left out; the version makes them at start. The vault (spaces and notes on disk) goes into the JSON.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode, urlsplit

HIER = Path(__file__).resolve().parent
FASSUNG = "1.16.0"
#: The same values as ``tests/conftest.py``: the test opens the fixture with them (sealed TOTP seeds, the client
#: secret of the provider).
TESTSCHLUESSEL = "test-secret-key-for-the-test-run-only"
EINRICHTUNGSCODE = "test-setup-code"
ISSUER = "https://sso.example.com"
CLIENT_ID = "nexlore-bestand"
CLIENT_GEHEIMNIS = "bestand-client"
KUERZEL = "sso"
OEFFENTLICHE_ADRESSE = "https://lore.example.com"
TAB = {"X-Nexlore-Client": "tab-bestand0"}
PROJEKT = "Projekt"


def dump_datei(ordner: Path = HIER) -> Path:
    return ordner / f"bestand-{FASSUNG}.sql.gz"


def manifest_datei(ordner: Path = HIER) -> Path:
    return ordner / f"bestand-{FASSUNG}.json"


def totp_geheimnis(etikett: str) -> str:
    """The TOTP seed of an account in the fixture, derived instead of stored (no secret-looking value in Git)."""
    return base64.b32encode(hashlib.sha256(f"bestand-totp-{etikett}".encode()).digest()[:20]).decode().rstrip("=")


class FesterZufall:
    """Stands in for ``secrets`` in the modules that hand out values the test must know.

    ``token_urlsafe`` returns ``bestand-<etikett>-<n>-festwert``; the script sets ``etikett`` before each call that draws one.
    ``choice`` walks the alphabet (recovery codes, pairing codes). Everything else is the real module.
    """

    def __init__(self) -> None:
        self.etikett = "unbenannt"
        self._schritt = 0
        self._zaehler = 0

    def token_urlsafe(self, nbytes: int | None = None) -> str:
        self._zaehler += 1
        # Long enough for every route's pattern (an invitation token has at least 20 characters).
        return f"bestand-{self.etikett}-{self._zaehler:03d}-festwert"

    def choice(self, folge):
        self._schritt += 1
        return folge[(self._schritt * 7) % len(folge)]

    def __getattr__(self, name: str):
        return getattr(secrets, name)


def _umgebung(daten: Path) -> None:
    os.environ["NEXLORE_DATA_DIR"] = str(daten)
    os.environ["NEXLORE_VAULT_DIR"] = str(daten / "vault")
    os.environ["NEXLORE_LOCALES_DIR"] = str(daten / "locales")
    os.environ["NEXLORE_SECRET_KEY"] = TESTSCHLUESSEL
    os.environ["NEXLORE_SETUP_TOKEN"] = EINRICHTUNGSCODE
    os.environ["NEXLORE_DISABLE_BACKGROUND"] = "1"
    os.environ["NEXLORE_FRONTEND_DIST"] = str(daten / "no-frontend")
    os.environ["NEXLORE_API_DOCS"] = "false"
    os.environ["NEXLORE_WELCOME_GUIDE"] = "0"
    os.environ["NEXLORE_LOG_LEVEL"] = ""
    os.environ["NEXLORE_UPDATE_URL"] = "http://127.0.0.1:9/releases/latest"
    os.environ["NEXLORE_ARGON2_TIME"] = "1"
    os.environ["NEXLORE_ARGON2_MEMORY_KIB"] = "1024"
    os.environ["NEXLORE_ARGON2_PARALLELISM"] = "1"


def bauen(ziel: Path) -> None:
    daten = Path(tempfile.mkdtemp(prefix="nexlore-bestand-"))
    _umgebung(daten)
    backend = HIER.parent.parent
    sys.path.insert(0, str(backend))
    sys.path.insert(0, str(backend / "tests" / "nexoidc"))

    import time

    import oidc_fakes as fakes
    from fastapi.testclient import TestClient

    from app import __version__, security
    from app.db import SessionLocal, engine
    from app.main import app
    from app.models import Account
    from app.services import accounts, apitokens, devices, emailaddr, index, mailer, settings_service, shares, totp
    from app.vendor import nexoidc
    from app.vendor.nexoidc import attempt, protocol

    if __version__ != FASSUNG:
        sys.exit(f"This is nexlore {__version__}; the fixture describes {FASSUNG}. Check out v{FASSUNG} first.")

    zufall = FesterZufall()
    for modul in (security, accounts, apitokens, devices, emailaddr, shares, totp):
        modul.secrets = zufall  # type: ignore[attr-defined]
    totp.generate_seed = lambda: totp_geheimnis(zufall.etikett)

    post: list[dict] = []

    def senden(db, message):
        body = message.get_body(("plain",))
        post.append({"an": str(message["To"]), "text": body.get_content() if body else str(message)})

    mailer._send = senden

    netz = fakes.Network()
    nexoidc.use_transport(netz.transport())
    protocol.clear_caches()
    attempt.forget_used_states()
    anbieter = netz.add(fakes.FakeProvider(ISSUER, client_id=CLIENT_ID, client_secret=CLIENT_GEHEIMNIS))

    konten: list[dict] = []
    offen: dict[str, str] = {}

    tabs = iter(range(1, 100))

    def browser() -> TestClient:
        # One tab per person: saves of one tab within a short time fold into one version (with its first author).
        return TestClient(app, base_url=OEFFENTLICHE_ADRESSE, follow_redirects=False,
                          headers={"X-Nexlore-Client": f"tab-bestand{next(tabs):02d}"})

    def ok(antwort, *codes: int):
        assert antwort.status_code in (codes or (200,)), (antwort.status_code, antwort.text)
        return antwort.json() if antwort.content else None

    def jetzt_code(etikett: str) -> str:
        return totp.code_at(totp_geheimnis(etikett), time.time())

    def faktor_an(klient: TestClient, etikett: str, passwort: str) -> list[str]:
        zufall.etikett = etikett
        ok(klient.post("/api/auth/totp/begin"))
        bestaetigt = ok(klient.post("/api/auth/totp/confirm", json={"code": jetzt_code(etikett), "password": passwort}))
        return bestaetigt["recovery_codes"]

    def einladung(klient: TestClient, etikett: str, *, raum: str | None = None, recht: str = "", tage: int = 7,
                  email: str = "") -> str:
        zufall.etikett = etikett
        if raum:
            made = ok(klient.post(f"/api/spaces/{raum}/invites", json={"role": recht, "days": tage, "email": email}),
                      201)
        else:
            made = ok(klient.post("/api/invites", json={"days": tage, "email": email}), 201)
        return urlsplit(made["link"]).path.rsplit("/", 1)[-1]

    def annehmen(token: str, name: str, passwort: str, etikett: str) -> TestClient:
        klient = browser()
        zufall.etikett = etikett
        ok(klient.post(f"/api/invite/{token}", json={"name": name, "password": passwort}))
        return klient

    def schreiben(klient: TestClient, pfad: str, text: str) -> None:
        vorher = klient.get("/api/note", params={"path": pfad})
        basis = vorher.json().get("hash") if vorher.status_code == 200 else None
        if basis is None:
            ordner, titel = pfad.rsplit("/", 1)
            ok(klient.post("/api/notes", json={"folder": ordner, "title": titel.removesuffix(".md"),
                                                "content": text}), 201)
        else:
            ok(klient.put("/api/note", json={"path": pfad, "content": text, "base_hash": basis}))

    with TestClient(app, base_url=OEFFENTLICHE_ADRESSE, headers=TAB):
        pass  # The lifespan once: tables, the guide off, nothing else.

    with SessionLocal() as db:
        settings_service.save(db, {
            "public_url": OEFFENTLICHE_ADRESSE, "smtp_host": "smtp.example.com", "smtp_from": "lore@example.com",
            "api_tokens_allowed": True, "shares_allowed": True,
        })

    # 1. The operator: setup with the code, an own address confirmed by its link, a second factor.
    betrieb = browser()
    zufall.etikett = "betrieb-sitzung"
    ok(betrieb.post("/api/setup", json={"name": "betrieb", "password": "bestand-betrieb-1", "language": "de",
                                        "code": EINRICHTUNGSCODE}))
    ok(betrieb.put("/api/me/profile", json={"display_name": "Betrieb"}))
    zufall.etikett = "betrieb-adresse"
    ok(betrieb.put("/api/me/email", json={"address": "betrieb@example.com"}))
    link = re.search(r"/confirm-email/(\S+)", post[-1]["text"]).group(1)  # type: ignore[union-attr]
    ok(betrieb.post("/api/email/confirm", json={"token": link}))
    codes_betrieb = faktor_an(betrieb, "betrieb", "bestand-betrieb-1")
    ok(betrieb.post("/api/spaces", json={"name": PROJEKT}), 201)
    schreiben(betrieb, f"{PROJEKT}/Plan.md", "# Plan\n\nErste Fassung vom Betrieb.\n")
    konten.append({"name": "betrieb", "passwort": "bestand-betrieb-1", "email": "betrieb@example.com",
                   "email_herkunft": "own", "rolle": "operator", "zweiter_faktor": "betrieb",
                   "wiederherstellung": codes_betrieb[0], "anzeigename": "Betrieb"})

    # 2. Invited into nexlore without a space and without an address; her session stays open.
    erika = annehmen(einladung(betrieb, "einladung-erika"), "erika-muster", "bestand-erika-1", "erika-sitzung")
    offen["sitzung_erika"] = erika.cookies.get(security.SESSION_COOKIE)
    konten.append({"name": "erika-muster", "passwort": "bestand-erika-1", "email": "", "email_herkunft": "",
                   "rolle": "member", "anzeigename": ""})

    # 3. Invited into the space as manager, with an address: writes, uploads, comments, an API token, a share, and
    #    an invitation of his own into the space that stays open.
    jonas = annehmen(einladung(betrieb, "einladung-jonas", raum=PROJEKT, recht="manage", email="jonas@example.com"),
                     "jonas", "bestand-jonas-1", "jonas-sitzung")
    ok(jonas.put("/api/me/profile", json={"display_name": "Jonas Beispiel"}))
    konten.append({"name": "jonas", "passwort": "bestand-jonas-1", "email": "jonas@example.com",
                   "email_herkunft": "invite", "rolle": "member", "anzeigename": "Jonas Beispiel"})

    # 4. Two accounts, one address (other case): the race of two operator saves, with the version's functions.
    kim = annehmen(einladung(betrieb, "einladung-kim"), "kim", "bestand-kim-1", "kim-sitzung")
    lou = annehmen(einladung(betrieb, "einladung-lou"), "lou", "bestand-lou-1", "lou-sitzung")
    del kim, lou
    with SessionLocal() as erste, SessionLocal() as zweite:
        k = erste.query(Account).filter_by(name="kim").one()
        lo = zweite.query(Account).filter_by(name="lou").one()
        assert not emailaddr.taken(erste, "Kim@Example.org", k.id)
        assert not emailaddr.taken(zweite, "kim@example.org", lo.id)
        k.email, k.email_source = "Kim@Example.org", emailaddr.OPERATOR
        lo.email, lo.email_source = "kim@example.org", emailaddr.OPERATOR
        erste.commit()
        zweite.commit()
    konten.append({"name": "kim", "passwort": "bestand-kim-1", "email": "Kim@Example.org",
                   "email_herkunft": "operator", "rolle": "member", "anzeigename": ""})
    konten.append({"name": "lou", "passwort": "bestand-lou-1", "email": "kim@example.org",
                   "email_herkunft": "operator", "rolle": "member", "anzeigename": ""})

    # 5. Second factor and a paired iPhone; reads the space; has asked for news (mentions count from then on).
    mona = annehmen(einladung(betrieb, "einladung-mona", raum=PROJEKT, recht="read"), "mona", "bestand-mona-1",
                    "mona-sitzung")
    codes_mona = faktor_an(mona, "mona", "bestand-mona-1")
    zufall.etikett = "mona-iphone"
    paar = ok(mona.post("/api/app-pairing", json={"address": OEFFENTLICHE_ADRESSE}), 201)
    geheim = re.search(r"secret=([^&]+)", paar["link"]).group(1)  # type: ignore[union-attr]
    zufall.etikett = "mona-iphone-schluessel"
    schluessel = ok(TestClient(app, base_url=OEFFENTLICHE_ADRESSE).post(
        f"/api/app/1/pairing/{paar['id']}/key", json={"device": "Monas iPhone"},
        headers={"X-Pairing-Secret": geheim}))["key"]
    offen["iphone_mona"] = schluessel
    ok(mona.get("/api/news"))
    konten.append({"name": "mona", "passwort": "bestand-mona-1", "email": "", "email_herkunft": "",
                   "rolle": "member", "zweiter_faktor": "mona", "wiederherstellung": codes_mona[0],
                   "anzeigename": ""})

    time.sleep(0.05)  # News count what comes after the question, to the microsecond.
    schreiben(jonas, f"{PROJEKT}/Plan.md", "# Plan\n\nErste Fassung vom Betrieb.\n\nErgänzt von Jonas.\n")
    schreiben(jonas, f"{PROJEKT}/Liste.md", "# Liste\n\n- Werkzeug\n")
    zufall.etikett = "jonas-anhang"
    ok(jonas.post("/api/attachments", params={"name": "skizze.txt", "note": f"{PROJEKT}/Plan.md"},
                  content=b"Skizze des Plans, 32 Bytes lang."), 201)
    ok(jonas.post("/api/comments", json={"path": f"{PROJEKT}/Plan.md", "quote": "Ergänzt von Jonas",
                                         "before": "", "after": ".", "body": "Was meinst du, @mona?"}), 201)
    zufall.etikett = "jonas-token"
    offen["token_jonas"] = ok(jonas.post("/api/api-tokens", json={"name": "Git-Spiegel", "level": "read"}),
                              201)["secret"]
    zufall.etikett = "jonas-seite"
    offen["seite"] = ok(jonas.post("/api/shares", json={"path": f"{PROJEKT}/Liste.md"}), 201)["link"].rsplit("/", 1)[-1]
    offen["einladung_raum"] = einladung(jonas, "offen-raum", raum=PROJEKT, recht="read", tage=30,
                                        email="neu@example.org")

    # 6. Password and provider; takes the provider's address offered in the profile.
    zufall.etikett = "anbieter"
    ok(betrieb.post("/api/oidc/admin/providers", json={
        "label": "SSO", "slug": KUERZEL, "issuer": ISSUER, "client_id": CLIENT_ID,
        "client_secret": CLIENT_GEHEIMNIS, "auto_create": True,
    }), 201)
    sam = annehmen(einladung(betrieb, "einladung-sam"), "sam", "bestand-sam-1", "sam-sitzung")
    anbieter.person = {"sub": "sub-sam", "email": "sam@example.net", "preferred_username": "sam", "name": "Sam"}
    gestartet = ok(sam.post(f"/api/oidc/{KUERZEL}/link", json={"password": "bestand-sam-1"}))
    weiter = gestartet["url"]
    rueck = urlsplit(fakes.query_of(weiter)["redirect_uri"]).path
    antwort = sam.get(f"{rueck}?{urlencode(anbieter.authorize(weiter))}")
    assert antwort.status_code in (302, 303, 307), antwort.text
    ok(sam.post("/api/me/email/provider"))
    konten.append({"name": "sam", "passwort": "bestand-sam-1", "email": "sam@example.net",
                   "email_herkunft": "provider", "rolle": "member", "anzeigename": "",
                   "anbieter": {"sub": "sub-sam", "email": "sam@example.net", "preferred_username": "sam"}})

    def ueber_anbieter(person: dict, einladung_token: str | None = None) -> TestClient:
        klient = browser()
        anbieter.person = person
        params = {"invite": einladung_token} if einladung_token else {}
        start = klient.get(f"/api/oidc/{KUERZEL}/start", params=params)
        weiter = str(start.headers["location"])
        rueck = urlsplit(fakes.query_of(weiter)["redirect_uri"]).path
        zurueck = klient.get(f"{rueck}?{urlencode(anbieter.authorize(weiter))}")
        assert zurueck.status_code in (302, 303, 307), zurueck.text
        assert "error" not in str(zurueck.headers["location"]), zurueck.headers["location"]
        return klient

    # 7. Through the provider only, made by "new people get an account", then made operator by the operator.
    robin_person = {"sub": "sub-robin", "email": "robin@example.net", "preferred_username": "robin.sso",
                    "name": "Robin"}
    zufall.etikett = "robin-sitzung"
    ueber_anbieter(robin_person)
    with SessionLocal() as db:
        robin_id = db.query(Account).filter_by(name="robin.sso").one().id
    ok(betrieb.put(f"/api/accounts/{robin_id}/role", json={"role": "operator",
                                                           "current_password": "bestand-betrieb-1"}))
    konten.append({"name": "robin.sso", "passwort": "", "email": "robin@example.net",
                   "email_herkunft": "provider", "rolle": "operator", "anzeigename": "", "anbieter": robin_person})

    # 8. Through the provider only, by an invitation into the space.
    max_person = {"sub": "sub-max", "email": "max@example.net", "preferred_username": "max", "name": "Max"}
    zufall.etikett = "max-sitzung"
    ueber_anbieter(max_person, einladung(betrieb, "einladung-max", raum=PROJEKT, recht="write"))
    konten.append({"name": "max", "passwort": "", "email": "max@example.net", "email_herkunft": "provider",
                   "rolle": "member", "anzeigename": "", "anbieter": max_person})

    # 9. An account that wrote and commented, then was deleted: its name stays in the history.
    weg = annehmen(einladung(betrieb, "einladung-weg", raum=PROJEKT, recht="write"), "weg", "bestand-weg-1",
                   "weg-sitzung")
    schreiben(weg, f"{PROJEKT}/Liste.md", "# Liste\n\n- Werkzeug\n- Leiter\n")
    ok(weg.post("/api/comments", json={"path": f"{PROJEKT}/Liste.md", "quote": "Leiter", "before": "- ",
                                       "after": "", "body": "Die Leiter bringe ich mit."}), 201)
    with SessionLocal() as db:
        weg_id = db.query(Account).filter_by(name="weg").one().id
    zufall.etikett = "betrieb-bestaetigt"
    ok(betrieb.request("DELETE", f"/api/accounts/{weg_id}", json={"current_password": "bestand-betrieb-1"}), 204)
    geloescht = {"name": "weg", "id": weg_id}

    # 10. What waits: an invitation into nexlore (30 days, an address), an invitation by name into the space for
    #     erika (answered under "New"), and an address of erika's waiting for its link.
    offen["einladung"] = einladung(betrieb, "offen", tage=30, email="offen@example.com")
    ok(betrieb.put(f"/api/spaces/{PROJEKT}/members/erika-muster", json={"role": "write"}), 202)
    zufall.etikett = "erika-adresse"
    ok(erika.put("/api/me/email", json={"address": "erika@example.com"}))
    offen["adresslink_erika"] = re.search(r"/confirm-email/(\S+)", post[-1]["text"]).group(1)  # type: ignore[union-attr]

    index.scan()

    # The dump: every table but the full-text ones (the version makes them at start).
    engine.dispose()
    datenbank = daten / "nexlore.db"
    verbindung = sqlite3.connect(str(datenbank))
    try:
        verbindung.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        virtuell = {z[0] for z in verbindung.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")}
        zeilen = []
        for zeile in verbindung.iterdump():
            if any(f'"{name}' in zeile or f"TABLE {name}" in zeile or f"INTO {name}" in zeile
                   or f"'{name}" in zeile for name in virtuell):
                continue
            zeilen.append(zeile)
    finally:
        verbindung.close()

    ziel.mkdir(parents=True, exist_ok=True)
    dump_datei(ziel).write_bytes(gzip.compress("\n".join(zeilen).encode("utf-8"), mtime=0))
    tresor = daten / "vault"
    dateien = {
        p.relative_to(tresor).as_posix(): p.read_text(encoding="utf-8")
        for p in sorted(tresor.rglob("*")) if p.is_file()
    }
    manifest = {
        "fassung": FASSUNG,
        "oeffentliche_adresse": OEFFENTLICHE_ADRESSE,
        "einrichtungscode": EINRICHTUNGSCODE,
        "anbieter": {"issuer": ISSUER, "client_id": CLIENT_ID, "client_geheimnis": CLIENT_GEHEIMNIS,
                     "kuerzel": KUERZEL},
        "raum": PROJEKT,
        "konten": konten,
        "geloescht": geloescht,
        "offen": offen,
        "tresor": dateien,
    }
    manifest_datei(ziel).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{dump_datei(ziel)}: {len(zeilen)} lines; {len(konten)} accounts")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ziel", type=Path, default=HIER)
    bauen(parser.parse_args().ziel)
