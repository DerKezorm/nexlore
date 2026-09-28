# Backups and Obsidian

Back to [[00 Welcome|Welcome]].

## Backups

Under Settings → Server → Backups the operator sets how often nexlore backs up and how many backups it keeps. A backup holds every note, every attachment and the database. Restoring shows first what would come in, what would change and what would go.

> [!warning] A backup on the same server is no backup
> Download backups, or copy the data folder somewhere else as well.

## Beside Obsidian

nexlore and Obsidian get along on the same folder:

- Wiki links, embeds, callouts, properties, tags and tasks are written the way Obsidian writes them.
- Code of other plugins (Dataview, Templater, Excalidraw) is shown as text and never touched.
- The `.obsidian` folder is left alone.
- If Obsidian changes a file while it is open in nexlore, nexlore loads it quietly; changes at the same time give a conflict copy.

Bring in an existing Obsidian vault as a ZIP on the **Files** page; nexlore then shows a report of what it found.

Next: [[13 Shortcuts]].
