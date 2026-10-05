# Backups and moving in

Back to [[00 Welcome|Welcome]].

## Backups

Under Settings → Server → Backups the operator sets how often nexlore backs up and how many backups it keeps. A backup holds every note, every attachment and the database. Restoring shows first what would come in, what would change and what would go.

> [!warning] A backup on the same server is no backup
> Download backups, or copy the data folder somewhere else as well.

## Moving the whole server

You move to a new server with a backup: on the old one, under Settings → Server → Backups, **Download** a backup; set up nexlore on the new one and choose the ZIP there with **Upload a backup**. It then appears in the list as "uploaded"; **Check**, then **Restore**. After the restart you sign in with your old account, and every space, note, attachment and account is there.

## Moving a space

To take a single space to another nexlore, right-click it in the sidebar, **Download as ZIP**, and bring it in there under **Files → Import a ZIP as a space**. It becomes a new space you manage. Every file in it comes along; versions, comments, members, public pages and the space's settings stay behind.

## Beside Obsidian

nexlore and Obsidian get along on the same folder:

- Wiki links, embeds, callouts, properties, tags and tasks are written the way Obsidian writes them.
- Code of other plugins (Dataview, Templater, Excalidraw) is shown as text and never touched.
- The `.obsidian` folder is left alone.
- If Obsidian changes a file while it is open in nexlore, nexlore loads it quietly; changes at the same time give a conflict copy.

Bring in an existing Obsidian vault the same way, as a ZIP under **Files → Import a ZIP as a space**; nexlore then shows a report of what it found.

Next: [[13 Shortcuts]].
