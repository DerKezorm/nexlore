# Tagesnotizen und Vorlagen

Zurück zu [[00 Willkommen|Willkommen]].

## Tagesnotizen

**Heute** in der Kopfleiste (oder `Alt+T`) öffnet die Notiz des heutigen Tages, zum Beispiel `⟦+0⟧.md` im Ordner „Daily“. Gibt es sie noch nicht, legt nexlore sie an. Welcher Ordner, welche Vorlage und wie die Notizen heißen (zum Beispiel `DD.MM.YYYY` oder `YYYY/MM/YYYY-MM-DD` mit Unterordnern), stellt der Verwalter eines Bereichs unter **Optionen** des Bereichs ein. Liegen schon Tagesnotizen in einem anderen Format im Bereich, schlägt nexlore dieses Format vor.

Über einer Tagesnotiz führen **Vortag** und **Folgetag** einen Tag zurück oder vor.

## Vorlagen

Eine Vorlage ist eine ganz normale Notiz im Ordner „Templates“ des Bereichs. Dieser Bereich hat eine: [[Templates/Besprechung]]. Sie erscheint im Dialog **Neue Notiz** zur Auswahl.

Beim Anlegen ersetzt nexlore diese Platzhalter:

| Platzhalter | wird zu |
| --- | --- |
| `{{title}}` | dem Titel der neuen Notiz |
| `{{date}}` | dem heutigen Datum |
| `{{time}}` | der Uhrzeit |
| `{{date:DD.MM.YYYY}}` | dem Datum im angegebenen Format |

In eine offene Notiz fügst du eine Vorlage über die Befehlspalette (`Strg+P`) mit **Vorlage einfügen** ein, das heutige Datum mit **Heutiges Datum einfügen**.

Eine neue Vorlage legst du im Dialog **Neue Notiz** mit **Neue Vorlage** an, oder mit Rechtsklick auf eine Notiz und **Als Vorlage speichern**.

Weiter mit [[08 Anhänge und Bilder]].
