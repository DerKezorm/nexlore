"""Test "Bestand": every way in that worked in 1.16.0 still works in the running version, and what the account name
keys (versions, comments, uploads, spaces) still belongs to the same person.

The database comes from 1.16.0 itself (``tests/bestand/bauen.py``, stored as ``bestand-1.16.0.sql.gz``; accounts, test
values and the vault in ``bestand-1.16.0.json``). Each test loads it in place of the test database, puts the vault on
disk and then starts the app exactly like a container after an update (the lifespan: tables, columns, indexes). Then it
signs in the way each account could before: name and password (any case), second factor and recovery code, a
provider, an open browser session, a paired iPhone, an API token, open invitations into nexlore and into a space, an
invitation by name, an address waiting for its link, a public page; and the locked stay out as before.

⚠️ **Nothing here may be adapted to make a new version pass.** A red test means: an installation that runs 1.16.0
today loses a way in or a piece of its history after the update. Change the code, not the test. The only thing that
may change are the strict ``xfail`` marks (``KOMMT``): what the account module brings on purpose (draft "Konten,
Einrichtung und Anmeldung": sign-in with the address, "Passwort vergessen", the operator's link, renaming). When a
piece is built, its mark goes and the test must pass as written.

⚠️ **The fixture ages.** Sessions, invitations and the waiting address run out; loading pushes those dates into the
future, and nothing else is touched before the start.
"""

from __future__ import annotations

import gzip
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parent / "nexoidc"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "bestand"))

import oidc_fakes as fakes
from bauen import TAB, dump_datei, manifest_datei, totp_geheimnis

from app.config import get_settings
from app.db import SessionLocal, engine
from app.main import app
from app.models import Account
from app.security import MAX_FAILURES, SESSION_COOKIE, brake
from app.services import mailer, settings_service, totp
from app.vendor import nexoidc
from app.vendor.nexoidc import attempt, protocol

MANIFEST = json.loads(manifest_datei().read_text(encoding="utf-8"))
KONTEN = MANIFEST["konten"]
ANBIETER = MANIFEST["anbieter"]
OFFEN = MANIFEST["offen"]
RAUM = MANIFEST["raum"]
ADRESSE_DER_APP = MANIFEST["oeffentliche_adresse"]

MIT_PASSWORT = [k for k in KONTEN if k["passwort"]]
MIT_FAKTOR = [k for k in KONTEN if k.get("zweiter_faktor")]
MIT_ANBIETER = [k for k in KONTEN if k.get("anbieter")]
NUR_ANBIETER = [k for k in KONTEN if k.get("anbieter") and not k["passwort"]]
_ZAHL: dict[str, int] = {}
for _k in KONTEN:
    if _k["email"]:
        _ZAHL[_k["email"].lower()] = _ZAHL.get(_k["email"].lower(), 0) + 1
#: Addresses one account has, of accounts with a password: the draft lets them sign in (rule 2), today nobody can.
EINDEUTIGE_ADRESSE = [k for k in MIT_PASSWORT if k["email"] and _ZAHL[k["email"].lower()] == 1]
DOPPELTE_ADRESSE = [k for k in MIT_PASSWORT if k["email"] and _ZAHL[k["email"].lower()] > 1]

#: The tables whose rows the start must leave as they are (nothing renamed, nothing deleted).
ZAEHLEN = (
    "accounts", "auth_sessions", "invites", "memberships", "space_notices", "oidc_providers", "oidc_links",
    "api_tokens", "app_devices", "versions", "comments", "files", "shares", "spaces",
)

#: What the account module brings on purpose. Strict: the day it works, the mark has to go.
KOMMT = pytest.mark.xfail(strict=True, reason="comes with the account module (draft Konten, Einrichtung, Anmeldung)")


def _schema(datei: Path) -> tuple[dict[str, set[str]], dict[str, int]]:
    verbindung = sqlite3.connect(str(datei))
    try:
        tabellen = [z[0] for z in verbindung.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
        spalten = {t: {z[1] for z in verbindung.execute(f'PRAGMA table_info("{t}")')} for t in tabellen}
        # Table names from the constant above, never input.
        zahlen = {t: verbindung.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]  # noqa: S608
                  for t in ZAEHLEN if t in spalten}
    finally:
        verbindung.close()
    return spalten, zahlen


@pytest.fixture
def bestand(vault: Path):
    """The 1.16.0 database and vault in place of the test ones, then the start of the running version.

    Gives back what the old database had (columns per table, rows per counted table), read before the start.
    """
    engine.dispose()
    ziel = get_settings().database_path
    for rest in ("", "-wal", "-shm"):
        Path(str(ziel) + rest).unlink(missing_ok=True)
    verbindung = sqlite3.connect(str(ziel))
    try:
        verbindung.executescript(gzip.decompress(dump_datei().read_bytes()).decode("utf-8"))
        verbindung.execute("UPDATE auth_sessions SET expires_at = datetime('now', '+30 days')")
        verbindung.execute("UPDATE invites SET expires_at = datetime('now', '+30 days')")
        verbindung.execute("UPDATE accounts SET email_pending_until = datetime('now', '+1 day') "
                           "WHERE email_pending <> ''")
        verbindung.commit()
    finally:
        verbindung.close()
    for pfad, text in MANIFEST["tresor"].items():
        datei = vault / pfad
        datei.parent.mkdir(parents=True, exist_ok=True)
        datei.write_text(text, encoding="utf-8")
    vorher = _schema(ziel)
    with TestClient(app, base_url=ADRESSE_DER_APP, headers=TAB):
        pass
    brake.forget()
    totp.forget()
    yield vorher
    shutil.rmtree(vault, ignore_errors=True)
    vault.mkdir(parents=True, exist_ok=True)


@pytest.fixture
def anbieter():
    netz = fakes.Network()
    nexoidc.use_transport(netz.transport())
    protocol.clear_caches()
    attempt.forget_used_states()
    fake = netz.add(fakes.FakeProvider(ANBIETER["issuer"], client_id=ANBIETER["client_id"],
                                       client_secret=ANBIETER["client_geheimnis"]))
    yield fake
    nexoidc.use_transport(None)
    protocol.clear_caches()
    attempt.forget_used_states()


@pytest.fixture
def post(monkeypatch):
    """Mail goes into a list instead of out; the fixture has a mail server and a public address."""
    gesendet: list[dict] = []

    def senden(db, message):
        body = message.get_body(("plain",))
        gesendet.append({"an": str(message["To"]), "text": body.get_content() if body else str(message)})

    monkeypatch.setattr(mailer, "_send", senden)
    return gesendet


def browser() -> TestClient:
    return TestClient(app, base_url=ADRESSE_DER_APP, follow_redirects=False, headers=TAB)


def ich(klient: TestClient) -> dict | None:
    antwort = klient.get("/api/auth/me")
    return antwort.json() if antwort.status_code == 200 else None


def konto_id(name: str) -> int:
    with SessionLocal() as db:
        return db.scalar(select(Account.id).where(Account.name == name))


def code_wieder_frei() -> None:
    """A TOTP code counts once per 30 seconds; a second sign-in in the same test needs the step freed again."""
    with engine.begin() as verbindung:
        verbindung.exec_driver_sql("UPDATE accounts SET totp_last_step = 0")


def anmelden(klient: TestClient, konto: dict, eingabe: str | None = None, *, code: str | None = None) -> dict:
    """The sign-in form of 1.16.0: field ``name``, then the code if the account has a second factor."""
    antwort = klient.post("/api/auth/login", json={"name": eingabe or konto["name"], "password": konto["passwort"]})
    assert antwort.status_code == 200, (konto["name"], eingabe, antwort.status_code, antwort.text)
    if antwort.json().get("second_factor"):
        zweiter = klient.post("/api/auth/login/totp", json={
            "code": code or totp.code_at(totp_geheimnis(konto["zweiter_faktor"]), time.time())})
        if zweiter.status_code == 401 and code is None:
            # The code was made at the end of a 30-second step and checked in the next: once more, fresh.
            zweiter = klient.post("/api/auth/login/totp", json={
                "code": totp.code_at(totp_geheimnis(konto["zweiter_faktor"]), time.time())})
        assert zweiter.status_code == 200, (konto["name"], zweiter.text)
    angemeldet = ich(klient)
    assert angemeldet is not None and angemeldet["name"] == konto["name"], angemeldet
    return angemeldet


def ueber_anbieter(klient: TestClient, fake, person: dict, einladung: str | None = None):
    fake.person = person
    params = {"invite": einladung} if einladung else {}
    start = klient.get(f"/api/oidc/{ANBIETER['kuerzel']}/start", params=params)
    weiter = str(start.headers["location"])
    rueck = urlsplit(fakes.query_of(weiter)["redirect_uri"]).path
    return klient.get(f"{rueck}?{urlencode(fake.authorize(weiter))}")


# --- The start -------------------------------------------------------------------------------------------------------


def test_the_start_only_adds(bestand):
    spalten_vorher, zahlen_vorher = bestand
    spalten_nachher, zahlen_nachher = _schema(get_settings().database_path)
    for tabelle, spalten in spalten_vorher.items():
        assert spalten <= spalten_nachher.get(tabelle, set()), (tabelle, spalten - spalten_nachher.get(tabelle, set()))
    assert zahlen_nachher == zahlen_vorher


def test_every_account_is_there_as_it_was(bestand):
    with SessionLocal() as db:
        for konto in KONTEN:
            zeile = db.scalar(select(Account).where(Account.name == konto["name"]))
            assert zeile is not None, konto["name"]
            assert (zeile.email, zeile.email_source, zeile.role) == (
                konto["email"], konto["email_herkunft"], konto["rolle"]), konto["name"]
            assert zeile.display_name == konto["anzeigename"], konto["name"]
            assert bool(zeile.password_hash) == bool(konto["passwort"]), konto["name"]
        assert db.scalar(select(Account).where(Account.name == MANIFEST["geloescht"]["name"])) is None


# --- Name and password -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("konto", MIT_PASSWORT, ids=lambda k: k["name"])
def test_name_and_password_still_sign_in(bestand, konto):
    anmelden(browser(), konto)
    code_wieder_frei()
    anmelden(browser(), konto, konto["name"].upper())


@pytest.mark.parametrize("konto", MIT_FAKTOR, ids=lambda k: k["name"])
def test_a_recovery_code_still_counts(bestand, konto):
    anmelden(browser(), konto, code=konto["wiederherstellung"])


def test_a_wrong_password_and_an_unknown_name_answer_alike(bestand):
    falsch = browser().post("/api/auth/login", json={"name": "jonas", "password": "not the password"})
    unbekannt = browser().post("/api/auth/login", json={"name": "niemand", "password": "not the password"})
    assert falsch.status_code == unbekannt.status_code == 401
    assert falsch.json()["detail"]["code"] == unbekannt.json()["detail"]["code"] == "wrong_credentials"


@pytest.mark.parametrize("konto", NUR_ANBIETER, ids=lambda k: k["name"])
def test_accounts_through_the_provider_only_have_no_password(bestand, konto):
    antwort = browser().post("/api/auth/login", json={"name": konto["name"], "password": ""})
    assert antwort.status_code in (401, 422)


def test_the_lock_counts_at_the_account_whatever_the_spelling(bestand):
    jonas = next(k for k in KONTEN if k["name"] == "jonas")
    for versuch in range(MAX_FAILURES):
        brake.forget()  # The sender's brake is not what this is about; the account's count is.
        eingabe = ("jonas", "JONAS", " Jonas ")[versuch % 3]
        assert browser().post("/api/auth/login", json={"name": eingabe, "password": "wrong"}).status_code == 401
    brake.forget()
    gesperrt = browser().post("/api/auth/login", json={"name": "jonas", "password": jonas["passwort"]})
    assert gesperrt.status_code == 401


@pytest.mark.parametrize("konto", DOPPELTE_ADRESSE, ids=lambda k: k["name"])
def test_a_shared_address_signs_nobody_in(bestand, konto):
    """True today (nexlore signs in by name only) and after the module (rule 3: doubles find no account)."""
    for schreibweise in (konto["email"], konto["email"].lower(), konto["email"].upper()):
        antwort = browser().post("/api/auth/login", json={"name": schreibweise, "password": konto["passwort"]})
        assert antwort.status_code in (401, 422), (konto["name"], schreibweise, antwort.text)


# --- Provider ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("konto", MIT_ANBIETER, ids=lambda k: k["name"])
def test_the_provider_still_signs_in_the_same_account(bestand, anbieter, konto):
    klient = browser()
    zurueck = ueber_anbieter(klient, anbieter, konto["anbieter"])
    assert zurueck.status_code in (302, 303, 307), zurueck.text
    if "error" in str(zurueck.headers["location"]) and konto["passwort"]:
        pytest.fail(f"provider refused {konto['name']}: {zurueck.headers['location']}")
    angemeldet = ich(klient)
    if angemeldet is None and konto.get("zweiter_faktor"):
        pytest.skip("the provider does not check the second factor here")
    assert angemeldet is not None, zurueck.headers["location"]
    assert (angemeldet["name"], angemeldet["role"]) == (konto["name"], konto["rolle"])


def test_an_operator_without_password_still_acts_as_operator(bestand, anbieter):
    """1.16.0 asks an operator who signs in through the provider for no password (``deps.confirm_operator``). The
    module asks every actor for one (gap L1): this test keeps that from slipping in unnoticed."""
    robin = next(k for k in KONTEN if k["name"] == "robin.sso")
    klient = browser()
    ueber_anbieter(klient, anbieter, robin["anbieter"])
    assert ich(klient)["role"] == "operator"
    antwort = klient.put(f"/api/accounts/{konto_id('erika-muster')}/role", json={"role": "member"})
    assert antwort.status_code == 200, antwort.text


# --- What stays signed in ------------------------------------------------------------------------------------------------


def test_an_open_browser_session_stays(bestand):
    klient = browser()
    klient.cookies.set(SESSION_COOKIE, OFFEN["sitzung_erika"])
    assert ich(klient)["name"] == "erika-muster"


def test_the_paired_iphone_stays(bestand):
    antwort = TestClient(app, base_url=ADRESSE_DER_APP).get(
        "/api/app/1/me", headers={"Authorization": f"Bearer {OFFEN['iphone_mona']}"})
    assert antwort.status_code == 200, antwort.text
    assert antwort.json()["account"]["username"] == "mona"


def test_the_api_token_still_reads_the_versions_with_their_authors(bestand):
    """The Git mirror (``docs/examples/git-mirror.py``) reads this: every version keeps the name of who wrote it."""
    klient = TestClient(app, base_url=ADRESSE_DER_APP)
    antwort = klient.get("/api/v1/versions", params={"since": "2000-01-01T00:00:00Z"},
                         headers={"Authorization": f"Bearer {OFFEN['token_jonas']}"})
    assert antwort.status_code == 200, antwort.text
    autoren = {(v["path"], (v.get("author") or {}).get("name")) for v in antwort.json()["versions"]}
    assert (f"{RAUM}/Plan.md", "betrieb") in autoren
    assert (f"{RAUM}/Plan.md", "jonas") in autoren
    eigene = [v for v in antwort.json()["versions"] if (v.get("author") or {}).get("name") == "jonas"]
    assert eigene and all(v["author"]["email"] == "jonas@example.com" for v in eigene)


def test_uploads_still_count_for_their_account(bestand):
    klient = browser()
    anmelden(klient, next(k for k in KONTEN if k["name"] == "jonas"))
    assert klient.get("/api/attachments/usage").json()["used"] == 32


def test_a_mention_still_reaches_its_account(bestand):
    klient = browser()
    anmelden(klient, next(k for k in KONTEN if k["name"] == "mona"))
    erwaehnt = klient.get("/api/news").json()["mentions"]
    assert [(m["author"], m["path"]) for m in erwaehnt] == [("jonas", f"{RAUM}/Plan.md")]


def test_comments_keep_their_authors(bestand):
    klient = browser()
    anmelden(klient, next(k for k in KONTEN if k["name"] == "jonas"))
    autoren = set()
    for pfad in (f"{RAUM}/Plan.md", f"{RAUM}/Liste.md"):
        for faden in klient.get("/api/comments", params={"path": pfad}).json()["threads"]:
            autoren.update(kommentar["author"] for kommentar in faden["comments"])
    assert autoren == {"jonas", MANIFEST["geloescht"]["name"]}


def test_the_public_page_still_opens(bestand):
    antwort = TestClient(app, base_url=ADRESSE_DER_APP).get(f"/api/public/{OFFEN['seite']}")
    assert antwort.status_code == 200 and antwort.json()["name"] == "Liste.md"


# --- What waits ---------------------------------------------------------------------------------------------------------


def test_the_open_invitation_still_makes_an_account_with_the_form_of_1_16_0(bestand):
    klient = browser()
    antwort = klient.post(f"/api/invite/{OFFEN['einladung']}", json={"name": "neu", "password": "bestand-neu-01"})
    assert antwort.status_code == 200, antwort.text
    angemeldet = ich(klient)
    assert (angemeldet["name"], angemeldet["email"]) == ("neu", "offen@example.com")
    assert anmelden(browser(), {"name": "neu", "passwort": "bestand-neu-01"})["role"] == "member"


def test_the_open_invitation_into_the_space_still_gives_its_right(bestand):
    klient = browser()
    antwort = klient.post(f"/api/invite/{OFFEN['einladung_raum']}",
                          json={"name": "gast", "password": "bestand-gast-01"})
    assert antwort.status_code == 200, antwort.text
    raeume = {r["name"]: r.get("role") for r in klient.get("/api/spaces").json()}
    assert raeume.get(RAUM) == "read", raeume


def test_the_invitation_by_name_can_still_be_accepted(bestand):
    klient = browser()
    klient.cookies.set(SESSION_COOKIE, OFFEN["sitzung_erika"])
    offen = [n for n in klient.get("/api/notices").json() if n["kind"] == "invite"]
    assert len(offen) == 1 and offen[0]["space"] == RAUM
    assert klient.post(f"/api/notices/{offen[0]['id']}/accept").status_code == 200
    raeume = {r["name"]: r.get("role") for r in klient.get("/api/spaces").json()}
    assert raeume.get(RAUM) == "write", raeume


def test_the_waiting_address_still_takes_its_link(bestand):
    antwort = browser().post("/api/email/confirm", json={"token": OFFEN["adresslink_erika"]})
    assert antwort.status_code == 200, antwort.text
    with SessionLocal() as db:
        erika = db.scalar(select(Account).where(Account.name == "erika-muster"))
        assert (erika.email, erika.email_source) == ("erika@example.com", "own")


# --- What the module brings (strict xfail) -------------------------------------------------------------------------------


@pytest.mark.parametrize("konto", EINDEUTIGE_ADRESSE, ids=lambda k: k["name"])
def test_after_the_change_a_unique_address_signs_in(bestand, konto):
    """Rule 2 of the draft: the confirmed addresses of nexlore count, in any case."""
    anmelden(browser(), konto, konto["email"].upper())


@pytest.mark.parametrize("eingabe", ["jonas", "JONAS@example.com"])
def test_after_the_change_a_forgotten_password_goes_by_mail(bestand, post, eingabe):
    with SessionLocal() as db:
        settings_service.save(db, {"smtp_host": "smtp.example.com", "smtp_from": "lore@example.com"})
    antwort = browser().post("/api/auth/forgot", json={"name": eingabe})
    assert antwort.status_code in (200, 202), antwort.text
    assert [m["an"] for m in post] == ["jonas@example.com"]


def test_a_shared_address_never_gets_a_link_by_mail(bestand, post):
    """Always: neither today (no such way) nor after the module (rule 3)."""
    for konto in DOPPELTE_ADRESSE:
        browser().post("/api/auth/forgot", json={"name": konto["email"]})
    assert post == []


def test_after_the_change_the_operator_makes_a_link_instead_of_a_password(bestand, anbieter):
    klient = browser()
    anmelden(klient, next(k for k in KONTEN if k["name"] == "betrieb"))
    antwort = klient.post(f"/api/accounts/{konto_id('erika-muster')}/reset-link",
                          json={"current_password": "bestand-betrieb-1"})
    assert antwort.status_code in (200, 201), antwort.text
    assert "/reset/" in antwort.json()["link"]


def test_after_the_change_a_renamed_account_keeps_its_history(bestand):
    """Renaming (draft: everyone in the profile) must not take away what 1.16.0 keys by the name: the authors of
    versions (and so of the Git mirror), uploads counted against the quota, comments, mentions."""
    jonas = next(k for k in KONTEN if k["name"] == "jonas")
    klient = browser()
    anmelden(klient, jonas)
    antwort = klient.put("/api/me/profile", json={"display_name": jonas["anzeigename"], "name": "jonas-neu",
                                                   "password": jonas["passwort"]})
    assert antwort.status_code == 200, antwort.text
    assert ich(klient)["name"] == "jonas-neu"
    assert klient.get("/api/attachments/usage").json()["used"] == 32
    versionen = TestClient(app, base_url=ADRESSE_DER_APP).get(
        "/api/v1/versions", params={"since": "2000-01-01T00:00:00Z"},
        headers={"Authorization": f"Bearer {OFFEN['token_jonas']}"}).json()["versions"]
    namen = {(v.get("author") or {}).get("name") for v in versionen}
    assert "jonas-neu" in namen and "jonas" not in namen
    autoren = {k["author"] for f in klient.get("/api/comments", params={"path": f"{RAUM}/Plan.md"}).json()["threads"]
               for k in f["comments"]}
    assert autoren == {"jonas-neu"}
