# Daily notes and templates

Back to [[00 Welcome|Welcome]].

## Daily notes

**Today** in the header (or `Alt+T`) opens the note of today, like `⟦+0⟧.md` in the folder "Daily". If it is not there yet, nexlore makes it. Which folder, which template and how the notes are named (like `DD.MM.YYYY` or `YYYY/MM/YYYY-MM-DD` with subfolders), whoever manages a space sets under the space's **Options**. If daily notes in another format lie in the space already, nexlore offers that format.

Above a daily note, **Day before** and **Day after** go back or forward one day.

## Templates

A template is an ordinary note in the space's "Templates" folder. This space has one: [[Templates/Meeting]]. It is offered in the **New note** dialog.

When a note is made from it, nexlore fills in these placeholders:

| Placeholder | becomes |
| --- | --- |
| `{{title}}` | the title of the new note |
| `{{date}}` | today's date |
| `{{time}}` | the time |
| `{{date:YYYY-MM-DD}}` | the date in that format |

Into an open note, the command palette (`Ctrl+P`) inserts a template with **Insert template** and today's date with **Insert today's date**.

Make a new template with **New template** in the **New note** dialog, or right-click a note and choose **Save as template**.

Next: [[08 Attachments and pictures]].
