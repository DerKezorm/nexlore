# Anbindung des Kontenmoduls (`nexkonten`) an nexlore

Plan vom 24.11.2026, gebaut am 25.11.2026 auf den Modulen 1.0.0 (Abschnitt 0). Maßgeblich sind der Entwurf in nexlore
(`Development/nexapps/Baupläne/Entwurf Konten, Einrichtung und Anmeldung.md`) und die Schnittstelle des Moduls
(`bauplaene/konten/SCHNITTSTELLE.md`, Zweig `konten`, Fassung 0.1.0). Vorbild für Aufbau und Oberfläche ist der Plan von
nexnotes (`nexnotes/docs/konten-anbindung.md`, Zweig `konten`); dieser Plan nennt Gleiches kurz und das Eigene
ausführlich. Was nexlore braucht und die Schnittstelle nicht hergibt, steht in Abschnitt 12.

**Das Eigene an nexlore:** Der Benutzername (`accounts.name`) ist hier nicht nur die Anmeldung, sondern **der Schlüssel
für alles, was Menschen in nexlore tun**: Autor jeder Version (und damit jedes Commits des Git-Spiegels), Besitzer
jedes hochgeladenen Anhangs (Speichergrenze), Autor von Kommentaren, `@name` in Kommentaren, wer gelöscht, verschoben,
übernommen, installiert hat. `models.py:393-395` sagt es selbst: „The key wherever a name is kept (versions,
comments, locks)“. Ein Umbenennen ohne Vorbereitung nähme jedem Konto seine Geschichte und seinen Speicherverbrauch.

## 0. Was gebaut ist / was fehlt

### Durchgang „Einstellungen“ (25./26.11.2026)

Nach dem Bauplan in nexlore `Development/nexapps/Baupläne/Bauplan Einstellungen.md` (samt E1 bis E38). Module aus
`bauplaene-stand` `68fd070` (je `tools/sync.py copy`, `check` grün, Vorlagen mit Kopfzeile `// Vorlage <Paket>
<Fassung>`): **`ui` 1.1.0, `log` 1.0.0, `sicherung` 1.0.1, `konten` 1.1.0, `oidc` 1.2.0, `post` 1.1.0,
`schluessel` 1.0.0**. App-Version unverändert 1.16.0, kein Release.

| Bereich | woher jetzt | was gewandert ist (alt → neu) |
|---|---|---|
| Gerüst | `SettingsLayout`, `SettingsNav`, `SettingsPage` (ui) in `pages/SettingsPage.tsx`, Karten je Bereich in `pages/settings/SettingsAreas.tsx`; Titel der gemeinsamen Bereiche aus `areaText` | eigene `SettingsNav`/`SettingsJump` fallen weg; Reihenfolge nach Bauplan (Notizen, Bereiche, Plugins vor Benachrichtigungen); `/settings/extensions` und `?tab=server&sub=extensions#…` leiten nach KI-Anbieter, Allgemein oder Server-Plugins um |
| Eigene Bausteine | `components/settings/ui.tsx` ist jetzt eine dünne Schicht über dem Bausatz (Card, CheckboxRow, Field, SelectField, Button mit Art/Größe/Symbol, CopyRow) | eigene Karte, Schalter, Felder, Knöpfe weg; Fenster, die nexlore auch außerhalb der Einstellungen öffnet (Rückfrage, Mitglieder, Teilen, Bereichsoptionen, Aufgaben-Status), behalten ihr Aussehen bis nach Stufe 1 (E33) |
| Profil | Profilkarte (konten `PAGES`) und `SignOutCard` des Moduls; neuer Weg `POST /api/me/email/prove` für „Adresse noch nicht bestätigt“ | eigene Abmelde-Karte → Modul |
| Darstellung | `AppearanceCard` des Moduls (Theme = `appearance.mode`), dann Themes, „Schriften und Breite“ (`Segment`, `CheckboxRow`), Eigenes CSS | Hell/Dunkel aus der Schriftkarte in „Aussehen“; neue Konten „Wie das System“, Bestand ohne Wahl behält „dunkel“ (Wanderung, Frage 1) |
| Benachrichtigungen | `NotifyWays` (Mail, Test), dann „Worüber du hörst“, „Webhook“ | eine Karte „Wege“ → drei Karten |
| Verbindungen | „Geräte“ (Rows, `sm` danger „Trennen“, primary „iPhone oder iPad verbinden“), „Auf diesem Gerät installieren“ (`components/settings/InstallCard.tsx`, E28), KI in Notizen, Kalender-Abo, `ApiKeysCard`, `ToolsCard` (mit „Rechte je Werkzeug“ als `extra`) | Installieren aus „Über“; `ApiTokens.tsx`, `McpKeys.tsx` fallen weg |
| Allgemein | „Grenzen“ (`limits`, Satz zum Speicher je Konto), „Funktionen für alle Konten“ (Kalender-Abos), `InterfacesCard` (API, MCP mit Höchststufe/Konnektoren/gesperrten Werkzeugen als `after.mcp`, iPhone-App), Sprachen, Titel eingefügter Links, Eigenes CSS, Anleitung | `ApiTokensCard`, `McpCard`, `AppPairingSwitch`, `CalendarFeedSwitch` → diese Karten |
| Anmeldung | `SignInPage` (konten) mit `SignInProviders` (oidc); Wege `GET/PUT /api/server/sign-in`, `GET /api/server/sign-in/readiness` (`routers/server_signin.py`); `PUT /api/settings` behält die Schalter, nach den Regeln des Moduls (`current_password` beim Abschalten des Faktors) | `SignInCards.tsx` fällt weg; Platzhalter `lore.example.com`; nexsuite-Zweige weg; Fund: der Passkey-Schalter wurde vorher nie gespeichert (`passkeys_allowed` fehlte in `SettingsIn`) |
| Mail | `MailCard` (post) über `/api/server/mail` (`routers/server_mail.py`); `services/mailer.py` gelöscht, alles über post (`services/kontenpost.py`: Kontomails, Einladung, Testmail; `services/notify.py`: Benachrichtigungen als `app_letters` DE/EN in die Outbox, Test sofort); Outbox mit `key`, `waiting`, `on_commit`, `recipient`; `outbox_runner` statt eigenem `nudge` | eigene Mail-Karte weg; Webhook behält seine englischen Worte |
| Speicher und Sicherung | Modul sicherung: Haken `services/backup_hooks.py` (Format unverändert: `nexlore-backup.json`, `database/nexlore.db`, `vault/`, `trash/`, `secret.key`; Tresor-Inhalt wird getauscht), `routers/backups.py` = neue Wege `/api/server/storage` + alte `/api/backups` (`x-nexlore-password`); Seite `pages/settings/StorageArea.tsx` | neu: Speicher-Karte (Tresor als Teil, auch außerhalb des Datenordners), Uhrzeit (`backup_time`, 03:00), „Jeden Monat“; gescheitertes Wiederherstellen startet mit den alten Daten und meldet es |
| KI-Anbieter, Plugins, Öffentliche Seiten | `AiCard`, `AdminPluginsCard`, `SharesCard` je eigener Server-Bereich (`ai-provider`, `server-plugins`, `shares`) | aus „KI, API und Plugins“ |
| Konten | Kontenliste mit `capsOf('nexlore', …)`: mehrere Betreiber, Sperren, Löschen mit 30 Tagen (`manage.remove`, `restore`, Hausputz `manage.purge_due` stündlich), Speichergrenze (`PUT /api/accounts/{id}/storage-limit`) und „KI erlaubt“ (`PUT /api/accounts/{id}/right`) je Konto; `WhatYouSeeCard`, `AllKeysCard`, „Alle Bereiche“ | Löschen bisher sofort und endgültig → 30 Tage; `quota_mb` des Servers → Grenze jedes Kontos (E24), KI-Recht je Konto (Serverschalter bleibt Hauptschalter) |
| Schlüssel | `services/schluessel_store.py` über `api_tokens` (`nxa_`) und `mcp_keys` (`nxl_`, Programme `kind=oauth`), Ids `api-<n>`/`mcp-<n>`; `routers/connections.py` (`/api/connections`); neue Spalte `mcp_keys.blocked_at` (Sperren auch für MCP-Schlüssel) | alte Wege `/api/api-tokens`, `/api/mcp/keys`, `/api/admin/api-tokens` antworten wie bisher, laufen aber über `keys.listing/make/revoke/overview/block` (E33; alte Fehlerkennungen über `old_refusal`) |
| Log | Modul log: `services/logs.py` = `configure` + `from app.vendor.nexlog import *`, `routers/logs.py` = `nexlog.api.router`, Karte des Moduls | Format, Datei, Schlüssel `log_mode`/`log_mode_until` unverändert; geschwärzt dazu `nxe_`, `nxd_`, Pfad `/email/`, Abfrage `invite` |
| Über | `AboutPage` (ui) in `pages/AboutPage.tsx` | eigene Seite → drei Karten des Bausatzes |

Neue Spalten (nur ergänzend, Sicherung davor wie bisher): `accounts.deleted_at`, `accounts.storage_limit`,
`accounts.ai_allowed` (1), `mail_outbox.key`, `mcp_keys.blocked_at`. Einmalige Wanderung `konten_110_migrated`
(`services/konten_wanderung._once_110`): bestätigte Adressen gelten als bewiesen (E23), `quota_mb` → Grenze jedes
Kontos (E24), Bestand ohne Hell/Dunkel-Wahl behält „dunkel“. Gelöschte Konten sind überall draußen
(`security.account_out`, Benachrichtigungen, Einladen per Name) und stehen in keiner Mitgliederliste, nicht im
@-Vorschlag, bekommen kein Recht (E33); ihre Mitgliedschaften warten aufs Zurückholen und gehen beim endgültigen
Löschen mit. Passwortfelder nur mit den Worten des Moduls (`FIELDS`). Browser-Mitteilungen (E34) hat nexlore nicht. Seit E38 hört der Store
`on_shut_out`/`on_back`; eine Benachrichtigung fragt beim Hinausgehen `notify.reaches` und erreicht ein
gesperrtes oder gelöschtes Konto nie, Webhook und Wahl bleiben. Wort der App: `settings.things`/`settings.thingsDative`
(Notizen/Notizen).

Umwege: keine offenen (der Umweg für sicherung 1.0.0 entfiel mit 1.0.1). Fragen: `einst-fragen/nexlore.md`.

Nacharbeit nach E44 und E39: Gelöschte Mitglieder zählen in den Rechten nicht (`rights.member_count`,
`spaces_with_members`; ein Bereich, dessen einziges Mitglied gelöscht ist, ist für 30 Tage des Betreibers). Unter
„Grenzen“ heißt das Feld „Speicher für neue Konten“ (leer = ohne Grenze, gespeichert wie bisher als `quota_mb`). Alle
Texte (Oberfläche, Anleitung, „Was ist neu“-Orte, README, docs, Mails, API-Meldungen) zeigen auf die neuen Orte und
Wörter; Wächter `tests/test_references.py`. Alter Betreiberweg `/api/admin/api-tokens`: `prefix` leer (E40).

Gemeinsame Runde (E45 bis E49): Module aus `bauplaene-stand` `68fd070`; Hell/Dunkel nach konten E45
(`theme_default_before="dark"`, `adopt_theme` in `/api/auth/me`, neue Konten `system`); Ortsangaben mit „›“ (E46);
angeglichen an nexnotes: Theme-Kacheln, Grenzen, Sprachen, Tastenkürzel, Bereich löschen, Plugins.

Modul sprachen 1.0.0 (E51, `bauplaene-stand` `68fd070`): eigene Sprachen aus `vendor/nexsprachen`
(`services/locales.py` konfiguriert es mit dem Ordner von vorher, `routers/locales.py` = `nexsprachen.api.router`),
Karte „Sprachen“ und i18n-Helfer aus dem Modul; schluessel mit „Neuer MCP-Schlüssel“ als md secondary.

Läufe am Ende (26.11.2026, Module `4f3e75e`, `reihe.sh nexlore ende`): ruff 0; pytest 2438 bestanden, 3 übersprungen
(11:49); lint 0; vitest 88 Dateien, 728 Tests; build 0. Playwright (`npm run e2e`, kopflos): 336 von 338 (14,9 min);
rot nur `canvas.spec.ts:398` und `sidebar.spec.ts:328` (beide warten auf eine Zeile der Seitenleiste, die sich unter
vielen Bereichen früherer Tests neu zeichnet; berühren die Einstellungen nicht), allein je zweimal grün.

Nach sprachen `68fd070` und E52 (nur Server, Seite unverändert): ruff 0; pytest 2451 bestanden, 3 übersprungen (11:39);
lint 0; vitest 88 Dateien, 728 Tests; build 0. Playwright nicht erneut (an der Seite hat sich nichts geändert).


Stand 25.11.2026 abends, Zweig `konten`, auf `main` mit dem neuen Einstellungs-Layout. Module aus `bauplaene` Zweig
`konten` (`3c55402`): **`konten` 1.0.0, `ui` 1.0.0, `oidc` 1.1.2, `post` 1.0.0**, kopiert mit `tools/sync.py copy`,
`check` grün. App-Version unverändert 1.16.0, kein Release. Die Abschnitte 1 bis 13 unten sind der Plan vom 24.11.2026
(gegen konten 0.1.0/0.2.x); wo der Bau davon abweicht, steht es hier.

**Gebaut (Backend):**

| Teil | Wo |
|---|---|
| Store | `services/konten_store.py` (Store, FactorStore, PasskeyStore, SessionStore, PictureStore über `accounts`, `invites`, `auth_sessions`, `app_devices`, `api_tokens`, `mcp_keys` und die neuen Tabellen); alte Fehlerkennungen `OLD_CODES` (`invalid_email`, `name_taken`, `invalid_name`), daneben `account_code` |
| Neue Spalten | `accounts`: `email_confirmed` (1), `email_proven` (0), `provider_email_from`, `totp_pending`, `totp_pending_until`, `password_changed_at` (leer = unbekannt), `passkey_handle`, `device_key`, `new_sign_in_mail` (1), `new_password_origin`, `password_reset_notice`, `browser_language`, `avatar_source`, `blocked_at`; `auth_sessions`: `uid`, `remember` (1), `stage` (`full`), `kind` (`browser`); `invites`: `display_name`, `mailed` (0) |
| Neue Tabellen | `models_accounts.py`: `former_names`, `setup_claims`, `passkeys`, `failed_unknown`, `mail_outbox`, `password_resets` |
| Wartende Adresse | bleibt in `accounts.email_pending*` wie in 1.16.0 (Hash ohne Präfix-Prüfung): offene Bestätigungslinks von 1.16.0 gelten über `POST /api/email/confirm`, neue über `/api/email/{token}` |
| Wanderung | `services/konten_wanderung.py` aus `db.init_db`: `uid` für alte Sitzungen, eindeutiger Index auf `lower(name)` erst nach Zählen, Indizes auf `lower(email)`, `former_names`, `versions.author`, `files.owner`, `comments.author`; **einmal** (Einstellung `konten_migrated`): Adressen mit Herkunft `own` gelten als **per Link bewiesen** (alle zählen), und **Namen gelöschter Konten aus der Geschichte** (`versions.author`, `files.owner`, `files.deleted_by`, `move_jobs.author`, `comments.author`/`resolved_by`, `proposals.decided_by`, `plugins.installed_by`, `space_notices.actor` ohne Konto) kommen als reserviert nach `former_names` (Frage 2 des Plans) |
| Umbenennen | `KontenStore.set_username` zieht in derselben Transaktion `versions.author`, `files.owner`, `files.deleted_by`, `move_jobs.author`, `comments.author`/`resolved_by`, `proposals.decided_by`, `plugins.installed_by`, `space_notices.actor` (und `subject` der Betreiber-Mitteilungen) mit; der alte Name bleibt für immer reserviert (`former_names`). Erwähnungen (`@alt`) finden das Konto auch über frühere Namen (`services/comments.py`). Git-Spiegel liefert danach den neuen Namen (`docs/api.md`) |
| Löschen | endgültig wie bisher; der Name kommt als reserviert nach `former_names` (behebt, dass ein neues Konto die Geschichte eines gelöschten erbte) |
| Anmelden | `POST /api/auth/login` über `login.sign_in` (Bremse des Moduls, bekannter Browser über `sessions.known_mark`, Cookies von 1.16.0 werden eine Fassung lang mitgelesen), Feld `name` bis 255, `remember`, Mail „Neue Anmeldung“ mit Knopf auf `/settings/security` |
| Einrichtung | `POST /api/setup` über `setup.setup` (`display_name`, `name`, `email`, `password_confirm` neu; das Formular von 1.16.0 ohne Anzeigenamen nimmt den Benutzernamen) |
| Passwort vergessen | `POST /api/auth/forgot`, `forgot_in_background`, sofort über `kontenpost.deliver_now` → `mailer.deliver_letter` → `mailer._send` (nie die Outbox) |
| Einladung | `GET/POST /api/invite/{token}` über `invite_form`/`accept_invite` (das Formular von 1.16.0 geht weiter: Anzeigename = Benutzername, Adresse der Einladung, wenn sie frei ist), `POST /api/invites` und `POST /api/spaces/{name}/invites` mit `display_name`; Link über `invites.invite_link(..., request_base=…)`; Listen liefern abgelaufene mit `expired`; Mail an ein bestehendes Konto mit `member=True` (post 1.0.0); `…/join` und Einladung per Name bleiben nexlores eigene |
| Reset-Link | `GET/POST /api/reset/{token}`; Betreiber `POST /api/accounts/{id}/reset-link`; `PUT /api/accounts/{id}/password` antwortet **410 `use_reset_link`** |
| Profil | `PUT /api/me/profile` (`name`, `email`, `password` neu), `PUT/DELETE /api/me/email` mit Passwort, `POST /api/me/email/resend`, `DELETE /api/me/email/pending`, `POST/DELETE /api/me/email/provider` (übernehmen mit Passwort, „Nein, danke“), `PUT /api/me/new-sign-in-mail` |
| Sitzungen | `GET /api/auth/sessions` (Browser und gekoppelte iPhones), `DELETE /api/auth/sessions/{uid}`, `GET /api/auth/access` (Geräte, API-Tokens, MCP-Schlüssel, Kalenderadresse, Passkeys), `POST /api/auth/access/disconnect`, `/seen`, `POST /api/me/password-reset-notice/seen` |
| Betreiber | `routers/accounts.py`: Liste mit `email_duplicate`, `passkeys`, `blocked`, `spaces`, `storage_used`; `impact` (Bereiche, in denen das Konto allein ist), Löschen, Sperren/Entsperren, Rolle, Name, Anzeigename, Adresse nur entfernen (`DELETE …/email`; `PUT …/email` nur noch leer, sonst 409 `not_allowed`), Faktor-Reset mit Übersicht |
| Sperren (neu) | `blocked_at`; gesperrt zählt keine Sitzung, kein API-Token, kein MCP-Schlüssel, kein OAuth-Token, kein gekoppeltes iPhone, keine Kalenderadresse, kein Anbieter (`account_state.blocked`); Anmelden mit richtigem Passwort sagt `account_blocked` |
| Zweiter Faktor, Passkeys | `routers/totp.py` und `routers/passkeys.py` wie nexnotes; Nothammer `NEXLORE_SECOND_FACTOR_OFF` |
| Bestätigen | `deps.confirm_operator`: Betreiber ohne Passwort mit frischer Anbieter-Anmeldung (5 Minuten) statt gar nicht (Lücke L1, Entwurf); Bremse `confirm:<Konto>` des Moduls |
| Profilbilder | alle angemeldeten Konten sehen sie (`GET /api/avatars/{id}`), Anbieterbild über `oidc` 1.1.x |
| OIDC | `services/oidc_store.py`: Namensregeln und belegte Namen aus dem Modul, Anzeigename aus dem Claim, Bild, Adresse über `profiles.provider_email` |
| Mail | `services/post_store.py` (Outbox, Minutenrunde in `main`), `services/kontenpost.py`, `services/mailer.py` (Briefe von post, Sprache des Kontos) |
| Notfallbefehl | `python -m app.emergency reset-link <Benutzername oder E-Mail> [--days 1/7/30]` |
| Einstellungen | `passkeys_allowed`, `smtp_sender_name`, `mail_last_*` |

**Frontend:** `pages/AuthPages.tsx` (Einrichtung, Anmelden, Passwort vergessen, Neues Passwort, E-Mail-Link,
Einladung), `pages/settings/AccountCards.tsx`, `SecondFactorBoxes.tsx`, `SecurityBoxes.tsx` (Profil und Sicherheit aus
`PAGES`), `pages/settings/AccountsList.tsx` und `accountList.ts` (Kontenliste 0.3.9/0.3.10 mit „Verwalten“, CAPS:
alles an außer `restore` und `inviteRole`), Karte „Alle Bereiche“ bleibt darunter; Bausatz `ui` in nexlores Türkis
(`styles/index.css`, `--nexui-*` hell und dunkel), `lucide-react` nur für Bausatz und Kontoseiten; eigene Kontotexte
unter `me.*`.

**Tests und Läufe (25.11.2026 abends, Testplatz):** Backend `pytest -q -n 2` 2192 grün, 9 übersprungen (darin
Vertrag `tests/nexkonten`, `tests/nexpost`, `tests/nexoidc` und Test „Bestand“ zusammen 410 grün, 2 übersprungen:
Einladung mit festem Benutzernamen; „Bestand“ 40 grün, nur die Marken `KOMMT` entfernt); `ruff check` sauber; Frontend
`vitest --maxWorkers=2` 605 grün in 81 Dateien, `npm run build`, `npm run lint`, `tsc -b` sauber. Playwright angepasst,
nicht ausgeführt (`e2e/accounts.spec.ts`, `email.spec.ts`, `firststep.spec.ts`, `twofactor.spec.ts`,
`nexoidc.spec.ts`, `languages.spec.ts`, `people.spec.ts`, `global-setup.ts`, `playwright.config.ts`).

**Abweichungen vom Modul (bewusst):** Sofort-Mails („Passwort vergessen“, Einladung, Testmail) gehen über nexlores
`mailer._send` (dieselbe Stelle wie die Benachrichtigungen), nicht über `nexpost.send.deliver`; der Brief ist der des
Moduls. Deshalb fängt `nexpost.testing.catch_mail` nur, was in die Outbox geht. „Überall sonst abmelden“ beendet wie in
1.16.0 auch die per OAuth verbundenen MCP-Konnektoren.

**Fehlt noch:** Sichtprüfung, Playwright-Lauf (zentral), nexlore-ios (Name beim Laden auffrischen), Seite für eine
frische Anbieter-Anmeldung vor Betreiber-Handlungen (`fresh_sign_in_required` zeigt bisher nur den Fehlertext).

## 1. Bestand heute (1.16.0)

### Datenmodell (`backend/app/models.py`)

| Tabelle | Was zum Konto gehört |
|---|---|
| `accounts` (`:387-457`) | `id`; `name` String 64 `unique=True`, **immer klein** (`accounts.check_name`, Muster `^[a-z0-9][a-z0-9._-]{1,63}$` = Muster des Moduls), bei der Einrichtung und Einladung **vom Menschen eingegeben** („Name“); `display_name` (80, leer: der Name wird gezeigt); `role` (`operator`/`member`); `sign_in` (`password`/`oidc`); `password_hash` (Argon2id, leer = nur Anbieter); `email` (255, **ohne eindeutigen Index**), `email_source` (`own`/`operator`/`invite`/`provider`, leer bei Adressen von vor der Spalte, `emailaddr.source_of` leitet sie dann ab); **`email_pending`, `email_pending_hash`, `email_pending_until`** (wartende Adresse mit Bestätigungslink, 24 h, Präfix `nxe_`); `provider_email`, `provider_email_off` (Angebot der Anbieteradresse); `language`; `failed_logins`, `locked_until` (10 Fehlversuche, 15 min); `totp_*`; `avatar`, `avatar_at`. **Kein** `blocked_at`, **kein** `deleted_at`: Löschen ist endgültig (`routers/auth.py:553-570`), Sperren gibt es nur durch Fehlversuche |
| `invites` (`:544-559`) | `token_hash`, `space_id` und `space_role` (Einladung in nexlore **oder in einen Bereich mit Recht**), `email`, `created_by`, `expires_at` (1, 7 oder 30 Tage); **kein Anzeigename, kein Name** |
| `memberships` (`:533-541`) | Recht je Bereich (`read`/`write`/`manage`), an der Konto-ID |
| `space_notices` (`:562-585`) | Einladung **per Name** in einen Bereich (wartet unter „Neu“ auf Ja/Nein) und Mitteilungen des Betreibers; `actor` = Name als Text |
| `auth_sessions`, `app_devices`, `app_pairings`, `api_tokens`, `mcp_keys`, `oauth_codes`, `oidc_links` | an der Konto-ID |
| **kein** `password_resets` | nexlore kennt keinen Link zum Zurücksetzen: der Betreiber setzt das Passwort selbst |
| **Name als Text** | `versions.author` (`:337`), `files.owner` (`:118`, Speichergrenze), `files.deleted_by` (`:113`), `move_jobs.author` (`:297`), `locks.holder_name` (`:352`), `comments.author` und `resolved_by` (`:750`, `:759`; dazu `account_id`, bei Löschen NULL), `proposals.decided_by` (`:793`), `plugins.installed_by` (`:966`), `space_notices.actor` (`:580`) |

### Dienste und Router

| Ort | Was |
|---|---|
| `services/accounts.py` | `by_name` (klein, `:59-60`), `check_name` (`invalid_name`, `name_taken`), `create_with_password`, `setup_code`/`announce_setup_code`/`create_operator` (Code schon heute, `NEXLORE_SETUP_TOKEN`, Sperre `_setup_lock`), `authenticate` (Blindhash, Sperre am Konto, „bekannter Browser“ darf trotz Sperre, Prüfungen eines Kontos nacheinander, `:166-196`), `set_password` (Betreiber setzt), Einladungen (`create_invite`, `find_invite` ohne abgelaufene und nur, solange der Einladende den Bereich noch verwaltet, `consume`, `redeem`, `accept_invite`) |
| `services/emailaddr.py` | Adresse je Konto: `request` (Bestätigungslink, **nur mit Mailserver und öffentlicher Adresse**, sonst `mail_off`/`public_url_missing`), `confirm`, `remove`, Angebot der Anbieteradresse (`take_offer`, `decline_offer`), `set_by_operator` (**Betreiber setzt eine Adresse, gilt sofort**, Mitteilung `operator_email`), `from_provider` (Konten nur über Anbieter folgen der Adresse des Anbieters), `unlinked`; `taken` ohne Groß/Klein mit `limit(1)` |
| `services/oidc_store.py` | Store für `vendor/nexoidc` 1.0.14: `clean_name` (`:83-92`), `name_taken` (`:264`), `create_account(name, invite, email)` (`:267-276`): Name aus dem Modul, **Anzeigename bleibt leer**, Adresse vom Anbieter (auch bei einer Einladung mit Adresse) |
| `routers/auth.py` | `GET/POST /api/setup` (`name`, `password`, `language`, `code`), `POST /api/auth/login` (`name` **höchstens 64 Zeichen**, `password`; Bremse `login:<ip>|<eingetippt>` und `login-ip:<ip>`), `/auth/me`, `PUT /api/auth/password`, `PUT /api/me/profile` (nur `display_name`, darf keinem fremden Namen oder Anzeigenamen gleichen: `_taken_by_another`, `display_name_taken`), `/me/email…`, `POST /api/email/confirm`, `GET /api/people` (Anzeigenamen zu Namen), Betreiber: `GET /api/accounts`, `DELETE /api/accounts/{id}`, `…/sign-out`, `…/role`, `PUT …/email` (setzen), **`PUT …/password` (setzen)** |
| `routers/members.py` | Mitglieder je Bereich, **Einladen per Name** (`PUT /api/spaces/{name}/members/{person}`), Einladungslinks in nexlore (Betreiber) und in Bereiche (wer den Bereich verwaltet), `GET/POST /api/invite/{token}` (`name`, `password`), `POST /api/invite/{token}/join` (angemeldet: nur das Recht dazu) |
| `deps.confirm_operator` (`:181-193`) | Betreiberhandlungen mit eigenem Passwort; **ein Betreiber ohne Passwort (nur Anbieter) wird gar nicht gefragt** |
| `security.end_all_sessions` (`:139-150`) | Browser, über OAuth verbundene MCP-Konnektoren, gekoppelte iPhones; **bleiben**: von Hand gemachte MCP-Schlüssel, API-Tokens, Kalenderadresse. Committet selbst |
| `services/mailer.py` | Einladung, Bestätigungslink, Testmail; kein Rücksetzen per Mail |

### Wanderung

`db.init_db()` bei jedem Start (`main.lifespan`): `create_all`, fehlende Spalten per `ALTER TABLE … ADD COLUMN` mit der
Vorgabe des Modells (`_add_missing_columns`, davor eine Sicherung `backups.UPDATE`), Volltexttabellen, fehlende
Indizes (`table_index.create(checkfirst=True)`, ohne Prüfung, ob sie anlegbar sind). Kein Alembic, keine
Schemanummer.

### Frontend

`pages/SetupPage.tsx` (Code, „Name“, Passwort, **Passwort wiederholen schon heute**, nur im Browser geprüft),
`LoginPage.tsx` („Name“, Passwort, Anbieterknöpfe; **kein „Passwort vergessen?“**), `InvitePage.tsx` („Name“, Passwort
zweimal, „Beitreten als …“ für Angemeldete, Anbieter), `ConfirmEmailPage.tsx`, `AccountPage.tsx` (Karte Profil:
Bild, Anzeigename mit Hinweis, darunter Name und Rolle als Text, `MailAddress`), `components/settings/AdminCards.tsx`
(`AccountsCard`: Liste, Einladen, Passwort setzen, Rolle, Adresse setzen, Löschen), `components/MembersDialog.tsx`
(Mitglieder, Einladen per Name oder Link). Bausteine: `AuthFrame`, `Field`, `PrimaryButton`, `Problem`
(`components/AuthFrame.tsx`), `Card`, `Input`, `Select`, `Toggle`, `Button`, `Feedback`, `CopyLink`
(`components/settings/ui.tsx`), `ConfirmDialog`, `ProviderButtons`, `Avatar`, `Person`. Anzeigenamen zu Namen holt
`lib/people.ts` (merkt sie für die Lebenszeit der Seite).

### iPhone-App (`nexlore-ios`, geprüft)

Kein eigenes Formular: Koppeln per QR-Code. Erkannt wird ein Serverkonto über **Adresse und Konto-ID**
(`SharedServer.identity`, `LoreCore/LocalLibrary.swift:79`, `:160`, `:280-291`). Gespeichert wird beim Koppeln der
**Anzeigename oder Name** (`me.account.name`, den `/api/app/1/me` als `display_name or name` liefert) in
`VaultRegistry.Entry.kind.server(account:)` und `SharedServer.accountName` (`LocalLibrary.swift:99-101`, `:321`,
`SharedServers.swift:20`), nur zur Anzeige; `/api/app/1/me` liefert den Benutzernamen zusätzlich als `username`
(`routers/app1.py:233`). Nach einer Änderung bleibt die gespeicherte Anzeige alt bis zum Neukoppeln; brechen tut nichts.

## 2. Wo der Benutzername mehr ist als Anzeige

**bricht** = Umbenennen macht etwas kaputt; **lösen** = vor dem Ändern-Knopf anfassen; **harmlos** = nur Anzeige oder
Protokoll.

| Stelle | Rolle des Namens | Bewertung |
|---|---|---|
| `services/index.py:474-504`, `:639-696` (`record`, `add_version`), gefüllt aus `Actor.name` (`services/vault.py:317-447`, `:773-881`, `:1328`, `routers/bases.py:152`, `routers/mcp.py:194`, `routers/v1.py:91`, `services/inbox.py:143`, `services/attachments.py:328`, `services/tagrename.py:167`, `services/mentions.py:214`) → `versions.author` | Autor jeder Version | **bricht**: alte Versionen tragen den alten Namen. Verlauf zeigt ihn ohne Anzeigenamen (`/api/people` findet ihn nicht mehr); „Neu seit deinem Besuch“ (`routers/news.py:66`) hält die eigenen alten Änderungen für fremde |
| `routers/v1.py:445-453` `_authors` (`Account.name.in_(names)`) | **Git-Spiegel** (`GET /api/v1/versions`, `docs/examples/git-mirror.py:110-114`) | **bricht**: alte Versionen bekommen `author: null` und erscheinen im Spiegel als „outside nexlore“, sobald sie (neu) gespiegelt werden. Schon gespiegelte Commits bleiben, wie sie sind (Git ändert nichts nachträglich); neue tragen den neuen Namen, und ohne Adresse eine neue Mail `name@<host>`: in Git eine zweite Person (`.mailmap` hilft). **Schlimmer:** Nimmt ein anderes Konto den frei gewordenen Namen, bekommt es die alten Versionen samt seiner **eigenen Adresse** zugeschrieben (`email` für eigene Token und den Betreiber) |
| `services/attachments.py:119-121` `used_by(db, name)`, `:329` `file.owner = actor.name`, `:384` Speichergrenze | **Speicherverbrauch je Konto** | **bricht**: nach dem Umbenennen zählt nichts Hochgeladenes mehr (die Grenze ist umgangen); wer den alten Namen nimmt, erbt den fremden Verbrauch |
| `services/comments.py:101`, `:124` `author = who.name`; `:203` `resolved_by` | Autor eines Kommentars | lösen: Anzeige läuft über den Namen; `account_id` gibt es daneben (Recht zum Ändern hängt an der ID, `:165`) |
| `services/comments.py:143` und `:214-228` `@name` in Kommentaren (`mentioned`, `mentions_of`) | Erwähnungen und Mitteilungen | **bricht** für alte Erwähnungen: `@alt` erreicht nach dem Umbenennen niemanden mehr; **nimmt ein anderes Konto den alten Namen**, sieht es unter „Neu“ die alten Erwähnungen in Bereichen, die es lesen darf, und bekommt Mitteilungen für Antworten. Text in Kommentaren schreibt nexlore nie um |
| `services/index.py:708` `files.deleted_by`, `services/vault.py:1145`, `:1255` `move_jobs.author`, `routers/proposals.py:176`, `:186` `decided_by`, `services/plugins.py:192` `installed_by`, `services/notices.py:66`, `:82` `actor` | Wer gelöscht, verschoben, entschieden, installiert hat | harmlos (Anzeige); beim Umbenennen mitziehen, damit der Papierkorb und die Vorschläge den neuen Namen zeigen |
| `services/vault.py:198` `locks.holder_name`, `routers/vault.py:327`, `:413`, `routers/canvas.py:55` (`own` = gleicher Name) | Sperre beim Bearbeiten | harmlos: läuft in Sekunden ab |
| `services/accounts.py:59-60` `by_name`, `routers/members.py:129-219` `/spaces/{name}/members/{person}` | Mitglieder per Name einladen, Recht ändern, herausnehmen | harmlos: gespeichert wird die ID; Skripte, die einen Namen nennen, müssen den neuen nehmen |
| `routers/auth.py:452-460` `_taken_by_another` | Anzeigename darf keinem fremden Namen gleichen | **lösen**: gilt künftig auch umgekehrt (ein neuer Benutzername darf keinem fremden Anzeigenamen gleichen), Lücke N1 |
| `routers/auth.py:76-78` `LoginIn.name` `max_length=64`, ebenso `SetupIn`, `AcceptIn`, `AccountName` | Feldlänge | **lösen**: eine Adresse über 64 Zeichen gäbe 422 statt `wrong_credentials` (Lücke N2) |
| `routers/auth.py:256` Bremse `login:<ip>|<eingetippt>` | Zähler je eingetipptem Text | **lösen** (Lücke L2 der Vorlagen): mit Anmelden per Adresse wären es zwei Zähler je Absender |
| `oidc_store.py:83-92`, `:261-276` | Name fürs OIDC-Modul, Anzeigename leer | lösen mit `nexoidc` 1.1.0 |
| `routers/totp.py` `provisioning_uri(seed, name)`, alle `logs.set_actor(name)` und `name=%s` | Beschriftung, Protokoll | harmlos |
| `routers/auth.py:161-178` `name`, `routers/app1.py:233` `username`, `routers/v1.py:162` `account`, `routers/members.py:121` Mitgliederliste, `routers/apitokens.py:139` | Antwortfelder | harmlos, Feldnamen bleiben |
| `frontend/src/lib/people.ts` (Anzeigenamen je Name, für die Lebenszeit der Seite) | Anzeige | harmlos: alter Name bis zum Neuladen |
| Sitzungen, iPhones, API-Tokens, MCP-Schlüssel, OAuth, Kalenderadresse (`calendar_feed_hash`, Pfad mit Token), Profilbild (`/api/avatars/{id}`), Bereiche (`memberships`), Freigaben (`shares.created_by`), Favoriten, Themes, Entwürfe, Lore | an der ID | harmlos |
| **Löschen** (`routers/auth.py:553-570`, endgültig) | Name wird sofort frei, die Geschichte behält ihn als Text | **bricht schon heute**: ein neues Konto mit dem Namen eines gelöschten wird Autor seiner Versionen (samt eigener Adresse im Git-Spiegel), Besitzer seiner Anhänge (Speicher) und Empfänger seiner Erwähnungen. Der Test „Bestand“ hält das Konto `weg` (gelöscht, mit Version und Kommentar) dafür bereit |

### Lösung (vor dem Ändern-Knopf)

1. **Umbenennen zieht mit, in einer Transaktion** (`Store.set_username` der App): `versions.author`, `files.owner`,
   `files.deleted_by`, `move_jobs.author`, `comments.author`, `comments.resolved_by`, `proposals.decided_by`,
   `plugins.installed_by`, `space_notices.actor` von `alt` auf `neu`. Kein neues Schema, kein Umbau der Lesestellen;
   der Git-Spiegel liefert alte Versionen danach mit dem neuen Namen (und Anzeigenamen/Adresse). `versions.author` hat
   keinen Index; ein `UPDATE … WHERE author = :alt` liest die Tabelle einmal, bei großen Tresoren einige Sekunden unter
   der Schreibsperre. Alternative: Spalten `*_account_id` (größerer Umbau aller Lesestellen, gelöschte Konten bräuchten
   trotzdem den Namen als Text).
2. **Alte Namen bleiben reserviert** (Tabelle `account_aliases`: `account_id` nullable, `kind`, `value`): beim
   Umbenennen der alte Name, beim Löschen der Name des gelöschten Kontos. `username_taken` zählt sie als belegt.
   Grund: `@alt` in Kommentaren und Notizen, Logzeilen, schon gespiegelte Commits und alte Mitteilungen nennen den
   Namen weiter; ein anderes Konto darf ihn nie bekommen. Das widerspricht dem Entwurf („Der alte Name wird frei“) und
   braucht eine Entscheidung (Frage 1) und eine Änderung am Modul (Lücke N3). Zurück auf den eigenen alten Namen darf
   ein Konto (Alias derselben ID).
3. **Löschen** reserviert den Namen ebenso (sonst bleibt der Fehler von heute).
4. **Erwähnungen**: `mentioned`/`mentions_of` finden ein Konto auch über seine früheren Namen (Aliasse), damit `@alt`
   weiter ankommt.
5. Test „Bestand“ hat dafür das strikte `xfail` `test_after_the_change_a_renamed_account_keeps_its_history`.

## 3. Zuordnung nexlore ↔ Modul

| Modul | nexlore |
|---|---|
| `id` (`int`) | `accounts.id` |
| `username` | `accounts.name` (Feldname der Schnittstelle bleibt `name`) |
| `display_name` | `display_name` |
| `email` | `email` |
| `email_source` | `provider` → `"provider"`; `own`, `invite`, `operator`, leer → `""` (eigene). Die Spalte bleibt mit ihren vier Werten (Betreiberliste, Mitteilung); `set_email(source="provider")` schreibt `provider`, sonst `own` |
| `email_confirmed` | neu `email_confirmed` (Abschnitt 4) |
| `pending_email` | die vorhandenen Spalten `email_pending*` (eine wartende je Konto passt zum Vertrag) |
| `has_password` | `sign_in == "password" and password_hash != ""` |
| `blocked` | immer `False` (nexlore kennt kein Sperren durch den Betreiber; gelöscht ist gelöscht) |
| `operator` | `role == "operator"` |
| `picture` | `avatar_at` leer → `""`, sonst `avatar_source or "own"` |
| `Invite` | `invites`; `rights` = die Zeile (`space_id`, `space_role`, Einladender); `display_name` neue Spalte; `username` immer `""` |
| `Reset` | neue Tabelle `password_resets` |

Store `services/konten_store.py` (neu), eine Instanz je Anfrage. Besonderheiten:

| Store | nexlore |
|---|---|
| `count_accounts` | `accounts.count` |
| `find_by_username` | `name == lower(eingabe)` **und** Aliasse (Abschnitt 2), damit `username_taken` alte und gelöschte Namen als belegt zählt; zum Anmelden nur der aktuelle Name (Frage 1) |
| `find_by_email` | `lower(email) == lower(eingabe)`, alle Treffer |
| `add_account` | wie `create_with_password` (`whats_new_seen`); Einladung: `accounts.redeem` (Recht im Bereich, Einladender wird Verwalter eines Bereichs ohne Mitglieder); `IntegrityError` auf `name` → `Taken("username")` |
| `set_username` | `name = neu` und das Mitziehen aus Abschnitt 2, alter Name nach `account_aliases`; Logzeile mit beiden |
| `set_display_name` | vorher `_taken_by_another` (Lücke N1) |
| `set_email` | `email`, `email_confirmed`, `email_source`; `provider_email_off` leeren, wenn gleich |
| `check_password` | `verify_password` bzw. `_dummy_hash()` |
| `set_password` | wie `accounts.set_password` (Anmeldeweg Passwort, Sperre weg) |
| `end_sessions` | `security.end_all_sessions` ohne eigenes `commit` (heute committet es selbst); was dazugehört, Lücke L7 |
| `find_invite` | **auch abgelaufene** (heute `None`), mit der Prüfung „Einladender verwaltet den Bereich noch“ |
| `start/find/consume_email_change` | auf `email_pending*`, Hash wie heute (`emailaddr._hash`), damit offene Links von 1.16.0 gelten; neue Tokens ohne Präfix `nxe_` (Route darf das Präfix nicht mehr verlangen) |
| `start/find/consume/drop_reset` | neue Tabelle |

`nexoidc` 1.1.0 im selben Zug (`clean_name`, `name_taken`, Anzeigename aus dem Claim, Bild).
`nexkonten.configure(AppConfig(app_name="nexlore", setup_token=lambda: get_settings().setup_token,
logger_name="nexlore.auth"))`; `accounts.setup_code`, `_generated_code`, `announce_setup_code` fallen weg.

## 4. Neue Spalten und Wanderung (nur ergänzend)

| Neu | Typ, Vorgabe | Bedeutung der Vorgabe |
|---|---|---|
| `accounts.email_confirmed` | Boolean, `server_default '1'` | Bestandsadressen gelten als bestätigt (Regel 2). Ein Schritt in `services/konten_wanderung.py` setzt danach **einmal** `0` für Adressen, die nur dem Anbieter folgen (`sign_in = 'oidc'` und Herkunft Anbieter): sie hat nie ein Mensch bestätigt, und ohne Passwort melden sie sich ohnehin nicht mit Passwort an. Vom Konto übernommene Anbieteradressen (`take_offer`) bleiben bestätigt (Lücke L6). Betreiber-Adressen: Frage 3 |
| `accounts.avatar_source` | String(16), `server_default ''` | vorhandene Bilder sind eigene |
| `invites.display_name` | String(80), `server_default ''` | Bestandseinladungen ohne Anzeigename |
| Tabelle `password_resets` | `account_id` (FK CASCADE, ein offener je Konto), `token_hash` (eindeutig), `created_by` (nullable), `expires_at` | leer |
| Tabelle `account_aliases` | `account_id` (nullable, SET NULL), `kind`, `value`, `created_at`; Index auf `(kind, lower(value))` | leer; Namen gelöschter Konten von vor der Fassung lassen sich nicht mehr finden (nur aus `versions.author` usw. ohne Konto), Frage 2 |
| Index auf `lower(email)` | nicht eindeutig | Doppel möglich (Fixture `kim`/`lou`) |

Rückweg auf 1.16.0 eine Fassung lang: neue Spalten mit Vorgabe, 1.16.0 kennt die neuen Tabellen nicht und stört sich
nicht daran. **Achtung:** Ein in der neuen Fassung umbenanntes Konto meldet sich auf 1.16.0 mit dem neuen Namen an;
seine Geschichte trägt dann schon den neuen Namen (gut). Ein Konto, das nur per Mail-Link ein Passwort bekam, merkt
nichts.

## 5. Routen

**Feldnamen bleiben**, Antworten bekommen höchstens Felder dazu.

| Route | Heute | Künftig |
|---|---|---|
| `POST /api/setup` | `name`, `password`, `language`, `code` | `name` ist weiter der Benutzername; dazu `display_name` (Pflicht laut Entwurf; fehlt er, gilt der Name: Frage 5), `email`, `password_confirm` → `nexkonten.setup` |
| `POST /api/auth/login` | `name` (64), `password` | `name` auf 254 Zeichen; `resolve_login` + Sperre/bekannter Browser der App + Passwort; Fehlertext „Benutzername, E-Mail oder Passwort stimmt nicht.“, Kennung bleibt `wrong_credentials` |
| neu `POST /api/auth/forgot`, `GET/POST /api/reset/{token}` | – | Passwort vergessen per Mail, Link einlösen |
| `PUT /api/me/profile` | `display_name` | dazu `name`, `password` (Bestätigung); `display_name_taken` bleibt |
| `PUT /api/me/email` | Bestätigungslink, ohne Mailserver `mail_off` | `change_email`: ohne Mailserver gilt sie sofort (Entwurf); dazu `password` |
| `POST /api/invites`, `POST /api/spaces/{name}/invites` | `role`, `days`, `email`, `send` | dazu `display_name`; `days` bleibt oder fällt (Lücke L3) |
| `GET/POST /api/invite/{token}` | `name`, `password` | GET dazu `display_name`, `name` (Vorschlag), `email`; POST dazu `display_name`, `email`, `password_confirm` (das Formular von 1.16.0 geht weiter, Test „Bestand“) |
| `POST /api/invite/{token}/join` | angemeldet beitreten | bleibt App-Sache (Lücke R5) |
| `PUT /api/accounts/{id}/password` | Betreiber setzt ein Passwort | **fällt weg** zugunsten `POST /api/accounts/{id}/reset-link` (Entwurf). Eine Fassung lang `410 use_reset_link`, damit Skripte eine klare Antwort bekommen (Frage 4) |
| `PUT /api/accounts/{id}/email` | Betreiber setzt eine Adresse | nur noch leer (entfernen) erlaubt, sonst `not_allowed` (Entwurf) |
| neu `PUT /api/accounts/{id}/name`, `…/display-name` | – | Betreiber mit eigenem Passwort (ein Betreiber ohne Passwort: Lücke L1) |
| `GET /api/accounts` | … | dazu `email_confirmed`, `email_duplicate` |

Fehlerkennungen, die sich ändern: `invalid_name` → `username_invalid`, `name_taken` → `username_taken`; dazu bleiben
nexlore-eigene (`display_name_taken`, `mail_off`, `public_url_missing`, `email_from_provider`), die das Modul nicht kennt
(Lücke L10 der Vorlagen).

## 6. Oberfläche

Vorgabe: optisch so wenig wie möglich, Vorbild nexnotes, nur vorhandene Bausteine (`AuthFrame`, `Field`,
`PrimaryButton`, `Problem`, `Card`, `Input`, `Select`, `Button`, `Feedback`, `CopyLink`, `ConfirmDialog`,
`ProviderButtons`, `Avatar`, `MailAddress`). Kein neuer Baustein. Wortlaute aus `vendor/nexkonten` (Namensraum
`account`) neben den eigenen in `i18n/{de,en}.json`.

| Bildschirm | Heute | Künftig | Sichtbar anders |
|---|---|---|---|
| **Ersteinrichtung** (`SetupPage`) | Code, „Name“ (Hinweis: Regeln, „Damit meldest du dich an“), Passwort, Passwort wiederholen | Code, **Anzeigename**, **Benutzername** (folgt dem Anzeigenamen), **E-Mail**, Passwort, Passwort wiederholen, Sprache (Frage der Vorlagen) | zwei Felder mehr; „Name“ heißt „Benutzername“ |
| **Anmelden** (`LoginPage`) | „Name“, Passwort, Anbieter, „Als Betreiber mit Passwort“ | „Benutzername oder E-Mail“, Passwort, **„Passwort vergessen?“** (mit Mailserver zur neuen Seite, ohne der Satz `account.forgotNoMail`), Anbieter | Beschriftung, ein Link mehr |
| **Passwort vergessen**, **Neues Passwort** (neu) | – | `AuthFrame` mit einem `Field` bzw. zwei Passwortfeldern, `PrimaryButton` | zwei neue Seiten |
| **E-Mail bestätigen** (`ConfirmEmailPage`) | gibt es | bleibt | nichts |
| **Einladung annehmen** (`InvitePage`) | „Name“, Passwort zweimal; „Beitreten als …“; Anbieter | Anzeigename, **Benutzername** (Vorschlag), E-Mail, Passwort zweimal; „Beitreten als …“ und Anbieter wie heute | zwei Felder mehr |
| **Profil** (`AccountPage`, Karte Profil) | Bild; Anzeigename mit „Speichern“; darunter **Name und Rolle als Text**; `MailAddress` (Bestätigung, Angebot der Anbieteradresse) | Bild; Anzeigename, **Benutzername als Feld**, E-Mail (`MailAddress` bleibt, „wartet“ mit „Zurücknehmen“ hat es schon); Benutzername/E-Mail geändert und Passwort vorhanden: `ConfirmDialog` mit Passwortfeld; Rolle klein darunter | Name wird ein Feld |
| **Konten** (`AccountsCard`) | Zeile Anzeigename/Name, Menü: Passwort setzen, Adresse setzen, Rolle, Abmelden, Löschen; Einladen mit Gültigkeit | Zeile Anzeigename, darunter „Benutzername · E-Mail“, Hinweis doppelte Adresse; Menü: **Link zum Zurücksetzen** statt Passwort setzen, Adresse nur entfernen, Benutzername/Anzeigename ändern; Einladen dazu Anzeigename | „Passwort setzen“ wird „Link erstellen“ |
| **Mitglieder** (`MembersDialog`) | Einladen per Name oder Link | Feld heißt „Benutzername“; Link-Einladung dazu Anzeigename | Beschriftung |

Vor dem Festschreiben wird jede geänderte Ansicht gezeigt und abgenommen. Die E2E-Tests (`frontend/e2e`) suchen
„Name“ an Feldern; sie wandern mit den Wortlauten.

## 7. Passwort vergessen: beide Wege

- **Selbst per Mail** (neu): `POST /api/auth/forgot`, eine Stunde, einmal, beendet Sitzungen; Mailtext DE/EN neu in
  `services/mailer.py` (`send_reset`, `send_username_changed`).
- **Link vom Betreiber** (neu, ersetzt „Passwort setzen“): 24 Stunden (oder wählbar, Lücke L3); mit Mailserver und
  Adresse per Mail, sonst einmal angezeigt. Für ein Konto nur über Anbieter gibt er ein erstes Passwort, wenn die
  Passwort-Anmeldung an ist (heute kann der Betreiber das mit „Passwort setzen“ auch).
- Der zweite Faktor bleibt bei beiden Wegen (heute bei „Passwort setzen“ ebenso).

## 8. Test „Bestand“

`backend/tests/test_bestand.py` mit `backend/tests/bestand/bestand-1.16.0.sql.gz` (gebaut von 1.16.0 mit
`tests/bestand/bauen.py`, Beschreibung und Tresor in `bestand-1.16.0.json`). Start:

    cd backend && .venv/Scripts/python -m pytest tests/test_bestand.py -q

Konten: `betrieb` (Einrichtung mit Code, eigene Adresse per Bestätigungslink, zweiter Faktor, legt den Bereich
`Projekt` an), `erika-muster` (Einladung in nexlore ohne Adresse, offene Sitzung, **offene Einladung per Name** in
`Projekt`, **wartende Adresse** mit offenem Bestätigungslink), `jonas` (Einladung in `Projekt` als Verwalter mit
Adresse, schreibt Versionen, lädt einen Anhang hoch, kommentiert mit `@mona`, API-Token für den Git-Spiegel,
öffentliche Seite, offene Einladung in den Bereich), `kim`/`lou` (dieselbe Adresse in anderer Schreibweise,
nachgestellter Wettlauf zweier Betreiber-Speicherungen), `mona` (Einladung in `Projekt` lesend, zweiter Faktor,
gekoppeltes iPhone, wartet auf „Neu“), `sam` (Passwort und Anbieter, hat die Anbieteradresse übernommen),
`robin.sso` (nur Anbieter, über „Neue Menschen bekommen ein Konto“, dann Betreiber), `max` (nur Anbieter, über
eine Einladung in den Bereich), `weg` (schrieb und kommentierte, dann gelöscht), offene Einladung in nexlore (30 Tage).

Geprüft (33 grün): Start ergänzt nur; jedes Konto mit Name, Adresse, Herkunft, Rolle, Anzeigename; Anmelden mit Name
(auch in Großbuchstaben), zweiter Faktor, Wiederherstellungscode; falsches Passwort und unbekannter Name antworten
gleich; nur Anbieter hat kein Passwort; Sperre nach 10 Fehlversuchen am Konto (Schreibweisen gemischt); doppelte
Adresse meldet niemanden an; Anbieter (Rolle bleibt); **Betreiber ohne Passwort handelt weiter ohne Passwort**;
Sitzung, iPhone (`username`), API-Token mit **Autoren der Versionen** (Name und eigene Adresse), **Speicherverbrauch**
des Hochladenden, **Erwähnung** kommt an, Kommentare behalten ihre Autoren (auch der des gelöschten Kontos),
öffentliche Seite; offene Einladung in nexlore und in den Bereich mit dem Formular von 1.16.0, Einladung per Name
annehmen, wartende Adresse per Link bestätigen.

Strikte `xfail` (7): Anmelden mit eindeutiger Adresse (`betrieb`, `jonas`, `sam`), „Passwort vergessen“ per Mail
(Name und Adresse), Link vom Betreiber statt Passwort, **ein umbenanntes Konto behält seine Geschichte** (Versionen im
Git-Spiegel, Speicherverbrauch, Kommentare). Immer grün: eine doppelte Adresse bekommt nie einen Link.

Gegen Mutationen geprüft (Abschnitt 13).

Für den Vertragstest des Moduls (`Adapter.legacy()`) liefert die Fixture Datenbank und Liste `(eingetippt, Passwort,
geht)`: Name geht; Adresse geht in 1.16.0 nie, nach dem Umbau die eindeutigen.

Vor dem Aufspielen dieselbe Probe auf einer **Kopie** der Live-Datenbank (Regel 11): doppelte Adressen zählen
(`SELECT lower(email), count(*) FROM accounts WHERE email <> '' GROUP BY 1 HAVING count(*) > 1`), Namen in der
Geschichte ohne Konto zählen (`SELECT DISTINCT author FROM versions WHERE author NOT IN (SELECT name FROM accounts)`:
die Namen gelöschter Konten, die reserviert werden sollten), dann die neue Fassung gegen die Kopie starten.

## 9. Risiken

1. **Geschichte und Speicher hängen am Namen** (Abschnitt 2). Ohne Mitziehen verliert jedes umbenannte Konto seine
   Autorenschaft im Verlauf und im Git-Spiegel und umgeht die Speichergrenze. Der Ändern-Knopf darf erst kommen, wenn
   das `xfail` grün ist.
2. **Freigewordene Namen** (Umbenennen und, schon heute, Löschen) geben einem Fremden die Geschichte, den Verbrauch
   und die Erwähnungen des Vorgängers, im Git-Spiegel samt dessen neuer Adresse.
3. **Git-Spiegel**: Commits vor dem Umbenennen tragen den alten Namen, danach den neuen; ohne Adresse ändert sich auch
   die Mail. Hinweis in `docs/api.md` und im Beispielskript (`.mailmap`).
4. **Betreiber setzt kein Passwort mehr** und keine Adresse: wer heute ohne Mailserver betreibt, gibt künftig einen
   Link weiter; Skripte gegen `PUT /api/accounts/{id}/password` brechen (Frage 4).
5. **Adresse ohne Mailserver gilt sofort** (Entwurf), heute wird sie verweigert: im Heimnetz kann sich künftig jeder
   eine beliebige Adresse eintragen, die nie geprüft wurde, und mit ihr anmelden. Mit Passwort, also nicht gefährlich,
   aber eine Änderung.
6. **Anmelden per Adresse ist neu** für nexlore: Betreiber-Adressen (`operator`) wurden nie vom Menschen bestätigt
   (Frage 3).
7. **Anzeigename Pflicht bei Einrichtung und Einladung** (Entwurf), heute darf er leer sein; Kollision mit
   `_taken_by_another` (Lücke N1).
8. Wie nexnotes: Bremse am Konto, eindeutiger Adressindex nie beim Start, Fehlerkennungen, Link-Dauern, neue Mailtexte.

## 10. Offene Fragen

1. **Alte und gelöschte Namen reservieren** (Vorschlag, Abschnitt 2) statt „Der alte Name wird frei“? Und: Darf man
   sich mit einem früheren Namen noch anmelden (wie bei nextime für CalDAV vorgeschlagen), oder ist er nur belegt?
2. Namen gelöschter Konten aus der Zeit vor der neuen Fassung: bei der Wanderung aus `versions.author`,
   `files.owner`, `comments.author` ohne passendes Konto einmal als reserviert eintragen?
3. Adressen, die der Betreiber gesetzt hat (`email_source = operator`): gelten sie als bestätigt (Regel 2 wörtlich;
   der Betreiber konnte in 1.16.0 ohnehin Passwörter setzen), oder muss der Mensch sie einmal bestätigen?
4. `PUT /api/accounts/{id}/password` eine Fassung lang mit `410 use_reset_link` beantworten, oder sofort weg?
5. Einrichtung: Anzeigename Pflicht (Entwurf) oder darf er leer bleiben wie heute (dann zeigt nexlore den Namen)?
6. Wie in nexnotes: Betreiber nur über Anbieter (L1), Gültigkeit 1/7/30 Tage auch für Bereichseinladungen (L3),
   Sprache bei der Einrichtung sichtbar.

## 11. Reihenfolge beim Bau

1. **Zuerst, eigene Fassung:** Aliasse, Mitziehen beim Umbenennen als Funktion (ohne Knopf), Namen gelöschter Konten
   reservieren (behebt den Fehler von heute); `LoginIn` auf 254.
2. `nexkonten` und `nexoidc` 1.1.0 per `sync.py`, Vertragstests grün; Spalten, Tabellen, `services/konten_store.py`.
3. Login, Setup, Einladungen (nexlore und Bereich), Link vom Betreiber über das Modul; Bremse am Konto; `xfail` für
   Adresse und Betreiber-Link weg.
4. Profil (Benutzername, Adresse), Betreiberaktionen, „Passwort vergessen“ per Mail; alle `xfail` weg.
5. Oberfläche nach Abschnitt 6 zeigen und abnehmen lassen; `docs/api.md`, Git-Spiegel-Hinweis; nexlore-ios: Anzeige
   beim Laden des Kontos auffrischen.

## 12. Passt das Modul?

Gegenüber `SCHNITTSTELLE.md` (0.1.0). **L** = Lücke, **R** = Reibung, **N** = neu gefunden in nexlore. Die Lücken der
Vorlagen, geprüft für nexlore:

| | Bekannt aus | nexlore |
|---|---|---|
| L1 Betreiber ohne Passwort | nexnotes | **betroffen, stärker**: nexlore fragt ihn gar nicht (`deps.confirm_operator:187-188`); Test „Bestand“ hält das fest |
| L2 Sperre und Fehlversuche am Konto, bekannter Browser | nexnotes | **betroffen** (`accounts.authenticate`, 10 Fehlversuche, `_one_check_at_a_time`) |
| L3 Gültigkeit 1/7/30 Tage | nexnotes | **betroffen** für Einladungen (auch in Bereiche); Reset-Links gibt es noch keine |
| L5 Gelöschte Konten belegen ihren Namen | nexnotes | **betroffen, anders**: nexlore löscht endgültig, es gibt keine Zeile, die den Namen hält (Lücke N3) |
| L6 „bestätigt“ und „Herkunft“ unabhängig | nexnotes | **betroffen**: übernommene Anbieteradresse (`take_offer`) soll bestätigt sein, gefolgte (nur Anbieter) nicht; vier Herkunftswerte statt zwei |
| L7 Was `end_sessions` beendet | nextime | **betroffen**: API-Tokens, MCP-Schlüssel und Kalenderadresse bleiben heute bei neuem Passwort |
| L8 alte Namen als Alias | nextime | **betroffen, stärker** (Abschnitt 2, N3) |
| R7 Code aus `.env` | nexnotes | betroffen (`get_settings().setup_token`) |
| R10 Fehlerkennungen nach außen | nexnotes | betroffen (`invalid_name`, `name_taken`) |

Neu:

| | Was nexlore braucht | Was die Schnittstelle hergibt | Vorschlag |
|---|---|---|---|
| **N1** | Ein Anzeigename darf keinem **fremden Benutzernamen oder Anzeigenamen** gleichen (NFKC, ohne Groß/Klein; Schutz gegen Verwechslung beim Teilen und in Kommentaren, `routers/auth.py:452-460`, Fehler `display_name_taken`). Umgekehrt muss dann auch ein **neuer Benutzername** gegen fremde Anzeigenamen geprüft werden. nexdiary hat dieselbe Regel | `clean_display_name` prüft nur Form und Länge; `setup`, `accept_invite`, `change_display_name`, `change_username` und der OIDC-Anzeigename aus dem Claim kennen keine Eindeutigkeit; kein Fehlercode | Store-Haken `display_name_taken(name, except_id) -> bool` (Vorgabe: False) und Code `display_name_taken`; beim OIDC-Anzeigenamen bei Kollision leer lassen statt abbrechen |
| **N2** | Feld der Anmeldung nimmt eine Adresse bis 254 Zeichen; heute `max_length=64` (`LoginIn`, `SetupIn`, `AcceptIn`), ebenso in nexdiary | Vertrag sagt „Feldnamen bleiben“, nichts zur Länge | in SCHNITTSTELLE „Was je App bleibt“: das Anmeldefeld nimmt 254 Zeichen, sonst gibt eine lange Adresse 422 statt `wrong_credentials` |
| **N3** | Umbenennen hat Folgen in der App (Geschichte, Speicher, Erwähnungen ziehen mit) und **alte Namen bleiben belegt**, ebenso Namen endgültig gelöschter Konten | `set_username(id, name)` ohne alten Namen; `username_taken` fragt nur `find_by_username`; Entwurf: „Der alte Name wird frei“ | im Vertrag: `set_username` **darf** abhängige Daten in derselben Transaktion mitziehen; neuer Store-Haken `name_reserved(name, except_id) -> bool` (Vorgabe: False), den `username_taken`/`check_username` mitfragen; Entscheidung, ob alte Namen frei werden (je App oder überall) |
| **N4** | Der Betreiber setzt heute Adressen, die sofort gelten (`emailaddr.set_by_operator`), mit Mitteilung an das Konto | Entwurf: Betreiber nur entfernen | hinnehmen (Entwurf); Bestand: Frage 3 |
| **N5** | Einladung in einen **Bereich** durch jeden, der ihn verwaltet; Beitreten mit dem **angemeldeten** Konto (`/invite/{token}/join`); Einladung **per Name** (`space_notices`) | `invite_values`/`accept_invite` kennen nur neue Konten; `Invite.rights` ist frei | geht: `rights` = Zeile, `join` und Einladung per Name bleiben App-Sache. Im Vertrag erwähnen, dass `invite_form`/`accept_invite` nicht für bestehende Konten sind |
| **N6** | Ohne Mailserver verweigert nexlore eine eigene Adresse (`mail_off`) | Modul: ohne Mailserver gilt sie sofort | hinnehmen (Entwurf); sichtbare Änderung, Risiko 5 |
| **R1** | `find_invite` liefert heute keine abgelaufenen | Vertrag will sie mit `expires_at` | App ändert die Abfrage |
| **R2** | Bestätigungslinks mit Präfix `nxe_`, Route prüft es | Modul macht Tokens ohne Präfix | Route lockern; offene Links gelten über den Hash |
| **R3** | `end_all_sessions` committet selbst | Modul committet | Store ruft eine Fassung ohne Commit |
| **R4** | Anzeigename leer erlaubt (zeigt den Namen) | Modul: Pflicht bei Einrichtung und Einladung | hinnehmen oder Frage 5 |

## 13. Mutationen (Test „Bestand“, je `pytest tests/test_bestand.py -x`)

Skript im Scratchpad (`mut_nexlore.py`), jede Mutation Rückgabecode 1:

| Mutation | rot in |
|---|---|
| Name mit Groß/Klein verglichen | Anmelden in Großbuchstaben |
| Start löscht offene Einladungen / beendet Sitzungen / löscht das gekoppelte iPhone | „Start ergänzt nur“ |
| Start leert `files.owner` (Umbau auf IDs ohne Füllen) | Speicherverbrauch |
| Start leert `versions.author` | Autoren im Git-Spiegel |
| Start verwirft die wartende Adresse | Bestätigungslink |
| Sperre zählt nur die genaue Schreibweise | Sperre am Konto |
| Betreiber ohne Passwort muss eins nennen (L1 naiv gebaut) | Betreiber ohne Passwort |
| Erwähnungen über den Anzeigenamen | Erwähnung kommt an |
| Anmelden per Adresse vorab gebaut | das strikte `xfail` wird rot, wie es soll |
