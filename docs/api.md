# The API for programs: `/api/v1`

Programs such as n8n, nexdeck or a script of your own use nexlore over plain HTTP and JSON, with an API token. A token
acts as the account that made it and never sees more: the same rights as the interface, and less if the token is
limited to some spaces. It reads, and with the level Write it makes and changes notes. It never deletes, moves,
renames, shares or touches members: no route for that exists here.

MCP for AI programs is a separate way in with its own keys, see [mcp.md](mcp.md).

## Switching it on

API tokens are off until the operator opens them: Settings, Server, AI, API and plugins, card "API tokens". There the
operator also sees every token (whose it is, its level, when it was last used, never the token itself) and may block
one for good. Switched off again, every token answers `401 api_off`; the tokens stay and work again when switched on.

Then every account makes its tokens on its account page: My account, Connections, card "API tokens".

- **Name**, to tell tokens apart.
- **Level**: Read (spaces, notes, search, links, tasks, numbers) or Write (also makes and changes notes, appends, the
  daily note, the inbox, ticks tasks off).
- **Spaces**: all the account may read, later ones too, or only the ones chosen.
- **Runs out**: in 30 days, 90 days, a year, or never (the default). A week before, the list marks it and the account
  gets a notification (occasion "API tokens run out", on by default, see My account, Notifications).

The token is `nxa_` and 43 more characters, shown once. nexlore keeps only its SHA-256 and its first characters.

## Calling

```
GET https://notes.example.com/api/v1/me
Authorization: Bearer nxa_...
```

- Every request carries the token in `Authorization: Bearer`. Never in the address.
- A request with an `Origin` header is refused (`403 origin_refused`): the API is for programs, not web pages. A
  browser always sends one; n8n, curl and server side code do not.
- No cookie counts here, and `X-Nexlore-Client` is not needed.
- Bodies are JSON (`Content-Type: application/json`), answers are JSON, times are ISO 8601 in UTC
  (`2026-10-02T05:30:00Z`).
- **Rate:** 600 requests per minute and token. Above that `429 slow_down` with `Retry-After: 60`.
- Paths are vault paths: the space first, then folders, then the file, with `/`: `Garden/Projects/Plan.md`.

### Errors

Every error has the same shape:

```json
{"detail": {"code": "not_found", "message": "Not found."}}
```

| Status | Code | Meaning |
|---|---|---|
| 401 | `api_off` | The operator has switched API tokens off. |
| 401 | `token_invalid` | No token, an unknown one, one that ran out or was blocked, or its account is locked. |
| 403 | `origin_refused` | The request came from a web page. |
| 403 | `read_only_token` | A write with a token of the level Read. |
| 403 | `forbidden` | The account may read the space but not write in it. |
| 404 | `not_found` | Not there, **or** in a space the token may not see. The two look the same on purpose. |
| 409 | `base_unknown` | `PUT /note` with a `base_hash` the note never had. Read it again. |
| 409 | `note_locked` | Appending while somebody edits the note. Try again in a moment. |
| 409 | `task_changed` | The task is no longer where it was. List the tasks again. |
| 413 | `too_large` | A note holds at most 5 MB. |
| 422 | `invalid_input` and others | A parameter is missing or not valid. |
| 429 | `slow_down` | Too many requests with this token. |

### The promise

What is under `/api/v1` stays as it is. New routes and new fields in answers may come, so a program must ignore fields
it does not know. Nothing is renamed or taken away. A change that would break a program goes to `/api/v2` beside it.

### Time

Dates in notes depend on the clock of whoever writes. Programs give theirs:

- `today` (`YYYY-MM-DD`) on reading routes that count days (tasks, dashboard).
- `now` (ISO with offset, `2026-10-02T07:30:00+02:00`) on writing routes that put a date or time into a note.

Left out, the server's own clock counts.

## Reading

All of these work with both levels.

### `GET /api/v1/me`

The token's account and limits. Good for a "test connection" button.

```json
{"account": "alex", "display_name": "Alex", "level": "write", "spaces": null,
 "expires_at": null, "version": "0.4.0"}
```

`spaces`: the spaces the token is limited to, `null` for every space the account may read.

### `GET /api/v1/spaces`

```json
[{"name": "Garden", "role": "manage", "notes": 42, "daily_folder": "Daily", "template_folder": "Templates"}]
```

`role` is the account's right: `read`, `write` or `manage`.

### `GET /api/v1/folder?path=Garden&offset=0&limit=200`

What lies directly in a space or folder. `limit` at most 500.

```json
{"path": "Garden",
 "folders": [{"path": "Garden/Projects", "name": "Projects", "notes": 7}],
 "files": [{"path": "Garden/Plan.md", "name": "Plan.md", "title": "Plan", "is_note": true, "size": 812,
            "modified": "2026-10-01T18:02:11Z"}],
 "total_files": 1}
```

### `GET /api/v1/note?path=Garden/Plan.md`

```json
{"path": "Garden/Plan.md", "title": "Plan", "content": "# Plan\n\n- [ ] Water the beans\n",
 "hash": "9f2c...", "tags": ["garden"], "front": {"status": "active"},
 "modified": "2026-10-01T18:02:11Z", "readonly": false}
```

Keep `hash` to change the note later. `readonly`: the file is not UTF-8; it is shown but never written from text.

### `GET /api/v1/links?path=Garden/Plan.md`

```json
{"outgoing": [{"target": "Beans", "path": "Garden/Beans.md", "line": 3}],
 "backlinks": [{"path": "Garden/Beans.md", "title": "Beans", "line": 3, "context": "Back to Plan"}]}
```

An outgoing link with `path: null` leads to no note (or to one the token may not see).

### `GET /api/v1/search?q=...&limit=30&offset=0`

The search of the search page, with its operators: words (each must occur), `"a phrase"`, `-left_out`, `OR`,
`tag:#x`, `path:Folder`, `file:name`, `task:words`, `task-todo:`, `task-done:`, `line:(a b)`, `section:(a b)`,
`[property:value]`. `limit` at most 100.

```json
{"notes": [{"path": "Garden/Beans.md", "title": "Beans",
            "lines": [{"line": 3, "text": "Back to Plan. zucchini later"}]}],
 "more": false}
```

### `GET /api/v1/recent?limit=10&space=Garden`

The notes changed last, newest first. `space` optional, `limit` at most 100.

```json
[{"path": "Garden/Beans.md", "title": "Beans", "space": "Garden", "modified": "2026-10-02T05:12:40Z"}]
```

### `GET /api/v1/templates?space=Garden`

```json
[{"path": "Garden/Templates/Meeting.md", "title": "Meeting"}]
```

### `GET /api/v1/tasks`

Tasks in the Obsidian Tasks format, across the spaces the token sees.

| Parameter | Values |
|---|---|
| `status` | `open` (default), `done`, `cancelled`, `all` |
| `when` | `overdue`, `today`, `week` (the next six days), `later`, `none` (no date); left out: all |
| `today` | `YYYY-MM-DD`, see Time |
| `space`, `tag`, `q` | one space, one tag, words in the task |
| `offset`, `limit` | `limit` at most 500, default 100 |

```json
{"total": 1,
 "counts": {"open": 3, "done": 5, "cancelled": 0, "overdue": 1, "today": 1, "week": 1, "later": 0, "none": 0},
 "items": [{"path": "Garden/Plan.md", "title": "Plan", "line": 5, "raw": "- [ ] Water the beans 📅 2026-10-02",
            "text": "Water the beans", "status": "open", "due": "2026-10-02", "scheduled": null,
            "completed": null, "priority": 0, "tags": [], "file_hash": "9f2c..."}]}
```

`counts` are for the same spaces, tag and words whatever `status` and `when` say: one request gives the numbers for
every chip. Open tasks come by date, the undated last.

### `GET /api/v1/dashboard?today=2026-10-02&space=Garden`

The numbers for a dashboard in one request. `space` optional.

```json
{"spaces": 2, "notes": 120, "tasks_open": 14, "tasks_overdue": 2, "tasks_today": 3, "tasks_week": 5, "inbox": 4}
```

`inbox`: entries waiting in the inbox notes (`Inbox.md` or `Eingang.md` at the top of a space), one per list item.

## Writing

Only with a token of the level Write, and only where the account may write. Each change becomes a version of the note
with the source "Program (API)" and the account as author.

### `POST /api/v1/notes`

```json
{"folder": "Garden/Projects", "title": "Fence", "content": "# Fence\n\nMeasure first.\n"}
```

Or from a template of the same space, its placeholders filled (`content` is then ignored):

```json
{"folder": "Garden", "title": "Monday", "template": "Garden/Templates/Meeting.md", "now": "2026-10-05T09:00:00+02:00"}
```

Answers `201` with the note as `GET /note` gives it. A title that is taken gets a number (`Fence 2.md`).

### `PUT /api/v1/note`

Replace a note's text.

```json
{"path": "Garden/Plan.md", "content": "# Plan\n\n- [x] Water the beans\n", "base_hash": "9f2c..."}
```

```json
{"path": "Garden/Plan.md", "hash": "1b7e...", "saved": true, "conflict": null}
```

- `base_hash` is the `hash` of the text the change starts from.
- Lines that did not change stay byte for byte as they were (line ends, a byte order mark).
- **Conflict:** when the note changed since, or somebody is editing it right now, nothing is overwritten. The text
  goes into a conflict copy next to the note, `saved` is `false` and `conflict` names the copy. The account sees the
  copy in nexlore and merges it there.

### `POST /api/v1/note/append`

Text at the end of a note, after a blank line, in the note's own line ends.

```json
{"path": "Garden/Log.md", "text": "Rain all day."}
```

```json
{"path": "Garden/Log.md"}
```

### `POST /api/v1/daily`

The daily note of a space, made from its daily template when missing; with `text`, that is added at its end.

```json
{"space": "Garden", "text": "Planted garlic.", "now": "2026-10-02T21:15:00+02:00"}
```

```json
{"path": "Garden/Daily/2026-10-02.md", "created": true}
```

`date` (`YYYY-MM-DD`) picks another day; left out, the day of `now`.

### `POST /api/v1/inbox`

Quick capture: the words go on top of the space's inbox note, with the time. Words that start as a task (`[ ] Buy
milk`) become one: `- [ ] Buy milk (07:30)`.

```json
{"text": "[ ] call the plumber", "now": "2026-10-02T07:30:00+02:00"}
```

```json
{"path": "Garden/Inbox.md"}
```

`space` optional. Left out: the account's main space (Settings, General), else its first own space it writes in.

### `POST /api/v1/tasks/complete`

Tick a task off, or open it again with `"done": false`. Give `path`, `line`, `raw` and `file_hash` (as `hash`) from
the task list.

```json
{"path": "Garden/Plan.md", "line": 5, "raw": "- [ ] Water the beans 📅 2026-10-02",
 "hash": "9f2c...", "today": "2026-10-02"}
```

```json
{"path": "Garden/Plan.md", "line": 5, "raw": "- [x] Water the beans 📅 2026-10-02 ✅ 2026-10-02",
 "conflict": null, "added": null}
```

Only the task's line changes. When the note changed since the list, the task is found by its text; when it is not there
exactly once, nothing is written (`409 task_changed`). A recurring task gets its next one above it (`added`).

## A dashboard card

What a card such as nexdeck's needs, and the requests for it:

| Part of the card | Request | Level |
|---|---|---|
| Test the connection | `GET /api/v1/me` | Read |
| Numbers (notes, open, due today, overdue, inbox) | `GET /api/v1/dashboard?today=...` | Read |
| Tasks due, with a box to tick | `GET /api/v1/tasks?when=today&today=...`, `GET /api/v1/tasks?when=overdue&today=...`, then `POST /api/v1/tasks/complete` | Write for ticking |
| Changed last | `GET /api/v1/recent?limit=5` | Read |
| Quick capture | `POST /api/v1/inbox` | Write |
| Open in nexlore | `https://notes.example.com/note/<path>`, each part of the path URL-encoded | |

A card that only shows needs a Read token; ticking and capturing need Write. With a Read token, `POST` answers
`403 read_only_token`: a card can hide its boxes and its capture field when `GET /me` says `"level": "read"`.

Every few minutes is plenty: the rate is 600 requests per minute and token.

## In n8n

HTTP Request node: Authentication "Generic Credential Type", "Header Auth", name `Authorization`, value
`Bearer nxa_...`. Then any route above, with JSON bodies for `POST` and `PUT`.

## Testing it by hand

```bash
curl -H "Authorization: Bearer $NEXLORE_TOKEN" https://notes.example.com/api/v1/dashboard
```

```bash
curl -X POST -H "Authorization: Bearer $NEXLORE_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "from curl"}' https://notes.example.com/api/v1/inbox
```
