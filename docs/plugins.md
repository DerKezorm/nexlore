# Plugins

Plugins add to a note: a panel beside it, a code block of their own language, or a view instead of the reading view.
They run locked up in the browser and can do only what their manifest asks for.

## Installing and using

The operator installs plugins under Settings, Plugins, from the catalog that comes with nexlore:

| Plugin | What it does | May |
|---|---|---|
| Contents | The headings of the note, its words and its reading time, beside the note | read the note |
| Queries | A ` ```query ` block lists notes by tag or folder, as a list or a table (read only, never Dataview code) | list notes |
| Kanban | Notes with `kanban-plugin` in their front matter as a board, in the format of the Obsidian Kanban plugin; moving a card writes the lanes it touches the way that plugin does | read and write the note |
| Rediscover | A random older note, and what was written a year ago today | list notes |

Installed means off for everybody. Once the operator lets a plugin out, each person switches it on for themselves on
the account page.

Every file of the catalog has its SHA-256 pinned in `backend/app/catalog/catalog.json`; a changed file is not
installed.

## How a plugin is locked up

Each plugin runs in a sandboxed frame without an origin of its own: no cookie, no storage of the app, no way to load
anything from the network or to navigate the app. Its only way out is to ask the page it sits in, through
`postMessage`, and the page answers only what the manifest lists under `permissions`. The server checks the right
to write once more.

Browsers do not let a page block every way out for such a frame: through WebRTC, code in it could send what it is
shown elsewhere. That is why plugin files that are not from the catalog need the operator to open a latch first, with
a plain warning, and are marked "own file, not checked".

## Writing one

A plugin is two files, `manifest.json` and `main.js`.

```json
{
  "id": "word-count",
  "version": "1.0.0",
  "author": "you",
  "name": { "en": "Word count", "de": "Wörter" },
  "description": { "en": "Counts the words of the note." },
  "permissions": ["note:read"],
  "place": { "panel": true },
  "strings": { "en": { "words_one": "{{count}} word", "words_other": "{{count}} words" } }
}
```

- `id`: lower case letters, digits and `-`, 2 to 32 characters, not an id of the catalog.
- `version`: like `1.0.0`.
- `permissions`: any of `note:read`, `note:write`, `vault:read`.
- `place`: exactly one of `{ "panel": true }`, `{ "block": "<language>" }` (not `dataview`, `dataviewjs`, `tasks`,
  `mermaid`, `math`, `latex`, `query-results`) or `{ "view": { "frontmatter": "<key>" } }` (for notes whose front
  matter has that key).
- `name`, `description`: a text, or texts per language with at least `en`.
- `strings`: the plugin's own texts per language, for `nexlore.t`.

`main.js` runs after a small library that provides `nexlore`:

```js
nexlore.ready(function (context) {
  // context: { place, path, language, strings, theme, source }  (source: the block's text, for a block)
  nexlore.ask('note.read').then(function (note) {
    var words = note.content.split(/\s+/).filter(Boolean).length
    document.getElementById('app').textContent = nexlore.t('words', { count: words })
  })
})
nexlore.on('changed', function () { /* the note changed: read it again */ })
```

| Request | Needs | Answer |
|---|---|---|
| `nexlore.ask('note.read')` | `note:read` | `{ path, title, content, hash }` |
| `nexlore.ask('note.write', { content, base_hash })` | `note:write` | `{ saved, conflict, hash }`; a changed note ends in a conflict copy |
| `nexlore.ask('vault.query', { tag, folder, space, sort, limit, random, day })` | `vault:read` | notes the account may read, at most 200 |
| `nexlore.ask('note.open', { path })` | nothing | opens a note the account may read |
| `nexlore.ask('note.reveal', { heading, index })` | nothing | scrolls the note to a heading |

`nexlore.t(key, { count })` picks `key_one` or `key_other` by the count. `nexlore.resize()` fits the frame to its
content (it also happens by itself).

Limits: `main.js` at most 512 KB, the manifest at most 64 KB.
