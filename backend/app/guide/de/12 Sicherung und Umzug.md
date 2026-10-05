# Sicherung und Umzug

Zurück zu [[00 Willkommen|Willkommen]].

## Sicherung

Der Betreiber stellt unter Einstellungen → Server → Sicherung ein, wie oft nexlore sichert und wie viele Sicherungen es behält. Eine Sicherung enthält alle Notizen, Anhänge und die Datenbank. Wiederherstellen zeigt vorher, was hinzukäme, was sich änderte und was wegfiele.

> [!warning] Eine Sicherung auf demselben Server ist keine Sicherung
> Lade Sicherungen herunter oder sichere den Datenordner zusätzlich woanders hin.

## Den ganzen Server umziehen

Auf einen neuen Server ziehst du mit einer Sicherung um: auf dem alten unter Einstellungen → Server → Sicherung eine Sicherung **Herunterladen**, auf dem neuen nexlore einrichten und dort mit **Sicherung hochladen** das ZIP wählen. Es steht dann als „hochgeladen“ in der Liste; **Prüfen**, dann **Wiederherstellen**. Nach dem Neustart meldest du dich mit deinem alten Konto an, und alle Bereiche, Notizen, Anhänge und Konten sind da.

## Einen Bereich umziehen

Einen einzelnen Bereich bringst du auf ein anderes nexlore, indem du in der Seitenleiste per Rechtsklick auf ihn **Als ZIP herunterladen** wählst und ihn dort unter **Dateien → ZIP als Bereich importieren** hereinholst. Er wird ein neuer Bereich, den du verwaltest. Mit kommen alle Dateien darin; Versionen, Kommentare, Mitglieder, öffentliche Seiten und die Einstellungen des Bereichs bleiben zurück.

## Neben Obsidian

nexlore und Obsidian vertragen sich auf demselben Ordner:

- Wiki-Links, Einbettungen, Hinweiskästen, Eigenschaften, Tags und Aufgaben schreibt nexlore so, wie Obsidian sie schreibt.
- Code anderer Plugins (Dataview, Templater, Excalidraw) zeigt nexlore als Text und fasst ihn nie an.
- Den Ordner `.obsidian` lässt nexlore in Ruhe.
- Ändert Obsidian eine Datei, während sie in nexlore offen ist, lädt nexlore sie still nach; bei gleichzeitigen Änderungen entsteht eine Konfliktkopie.

Einen vorhandenen Obsidian-Tresor holst du genauso herein, als ZIP unter **Dateien → ZIP als Bereich importieren**; nexlore zeigt danach einen Bericht, was es erkannt hat.

Weiter mit [[13 Tastenkürzel]].
