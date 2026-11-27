# Dein Konto und andere Apps

Zurück zu [[00 Willkommen|Willkommen]].

## Die Einstellungen

Das Zahnrad unten in der Seitenleiste öffnet die Einstellungen, auf dem Handy dein Bild oben rechts. Unter **Mein Konto** steht, was nur dich betrifft: Profil, Sicherheit, Darstellung, Notizen, Bereiche, Plugins, KI, Benachrichtigungen und Verbindungen. Der Betreiber sieht dazu **Server** mit allem, was für alle Konten gilt.

## Anmelden

Du meldest dich mit deinem Benutzernamen oder mit deiner Mailadresse an, sobald sie gilt (siehe [[09 Teilen und Rechte#Deine Mailadresse]]).

- **Passwort vergessen?** steht auf der Anmeldeseite, wenn der Betreiber einen Mailserver eingetragen hat. nexlore schickt dir dann einen Link an deine Adresse, mit dem du ein neues Passwort setzt. Er gilt eine Stunde und nur einmal. Danach bist du in allen Browsern abgemeldet; Passkeys und API-Schlüssel bleiben. Ohne Mailserver erstellt dir der Betreiber so einen Link.
- **Passkeys:** Unter **Mein Konto › Sicherheit** legst du mit **Passkey hinzufügen** einen an. Danach meldest du dich mit **Mit Passkey anmelden** per Fingerabdruck, Gesicht oder der PIN deines Geräts an, ohne Passwort. Passkeys gibt es, sobald nexlore unter einer Adresse mit https läuft und der Betreiber sie erlaubt (Einstellungen › Server › Anmeldung, ab Werk an). Ein Passkey zählt auch als zweiter Faktor.
- **Mail bei neuer Anmeldung:** Meldet sich jemand aus einem Browser an, den nexlore noch nicht kennt, bekommst du eine Mail. Abschalten kannst du das unter **Mein Konto › Sicherheit**.

## Notizen aus nexnotes

nexnotes ist eine eigene nex-App für schnelle Notizen. Was du dort festhältst und behalten willst, legst du mit einem Klick in einen Bereich von nexlore: in nexnotes im Menü einer Notiz **An nexlore**, dann den Bereich wählen. Die Notiz kommt mit Titel und Text als neue Notiz an; in nexnotes bleibt sie, wie sie ist.

Dafür verbindest du beide Apps einmal, ohne Schlüssel zum Abtippen:

1. Unter **Mein Konto › Verbindungen** steht bei **Andere nex-Apps** die Karte **nexnotes**.
2. Dort wählst du, in welche Bereiche nexnotes Notizen ablegen darf: alle, auch spätere, oder nur einzelne. Zur Wahl stehen nur Bereiche, in denen du schreiben darfst.
3. **Mit nexnotes verbinden** öffnet nexnotes. Dort meldest du dich an, siehst, was nexnotes darf, und stimmst einmal zu. Danach bist du wieder hier.

Fängst du in nexnotes an, fragt dich nexlore auf der Seite, auf der du zustimmst, nach denselben Bereichen.

> [!note] Was nexnotes darf
> Genau eins: Notizen in die Bereiche legen, die du ihm gegeben hast. nexnotes sieht dein Konto und die Namen dieser Bereiche, nie den Inhalt deiner Notizen, und es kann nichts ändern, verschieben oder löschen.

Die Karte zeigt, mit welchem Konto in nexnotes du verbunden bist, seit wann, wann nexnotes zuletzt etwas gebracht hat und welche Bereiche es nutzt. **Zugriff beenden** trennt die Verbindung auf beiden Seiten; was schon in nexlore liegt, bleibt.

Sagt die Karte, dass nexnotes auf diesem Server nicht eingerichtet ist, ist der Betreiber dran: Er trägt die Adresse von nexnotes einmal unter **Einstellungen › Server › Allgemein › Andere nex-Apps** ein, danach verbindet jedes Konto mit einem Klick. Läuft nexnotes im eigenen Netz (LAN, VPN), erlaubt er dort auch **Verbindungen ins eigene Netz**. Der Schalter **Verbindungen mit anderen nex-Apps** lässt alle Verbindungen ruhen; gelöscht wird dabei nichts. API-Schlüssel für Programme wie n8n gelten davon unberührt weiter, siehe [[11 KI]].

## Für den Betreiber: Konten

Unter **Einstellungen › Server › Konten** hat jedes Konto eine Zeile mit **Verwalten**. Dort:

- **Sperren** nimmt dem Konto jeden Weg hinein; alles darin bleibt. **Entsperren** lässt es wieder herein, frühere Anmeldungen bleiben beendet.
- **Konto löschen** nimmt es sofort für alle weg. 30 Tage lang holst du es mit **Zurückholen** zurück, mit seinen Bereichen und Rechten. Danach ist es endgültig gelöscht: Seine Notizen bleiben, wo sie sind, und ein Bereich, in dem es das einzige Mitglied war, gehört dann dem Betreiber.
- **Link für ein neues Passwort** erzeugt einen Link, mit dem die Person selbst ein neues Passwort setzt; ein Passwort für jemanden setzt du nie. Mit Mailserver geht der Link an ihre Adresse, sonst zeigt nexlore ihn dir einmal zum Weitergeben.
- Eine **Mailadresse** trägt jeder selbst ein; du kannst sie nur entfernen.
- Dazu legst du die **Speichergrenze** des Kontos fest und ob es KI nutzen darf.

Dein eigenes Konto sperrst und löschst du hier nicht, und es bleibt immer ein Betreiber, der sich anmelden kann.

Das war die Anleitung. Viel Freude mit deinen Notizen. Zurück zu [[00 Willkommen|Willkommen]].
