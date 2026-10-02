# AI from outside: MCP

nexlore speaks the Model Context Protocol, so an AI program on your computer, an agent or an AI app can search and
read your notes, propose changes, or change them, depending on the key you give it and the rights you set per tool. It
sees only what your account may read, and less if you limit the key to some spaces. It never gets the powers of an
operator: members and public pages need the right to manage the space itself.

## Switching it on

MCP is off until the operator opens it: Settings, Server, AI and plugins. There the operator also sets the highest
level a key may have (lowering it later applies to keys made before), whether connectors may sign in, and which tools
are blocked for everybody.

Then every account connects its programs on its account page (My account, AI), in one of two ways:

- **A key** for programs that take a fixed header: a name, a level and which spaces the key may see (all spaces the
  account may read, later ones too, or only the ones chosen). The key is shown once. nexlore keeps only its hash and
  its first characters, to tell keys apart.
- **A connector** for programs that sign in themselves (OAuth), such as the connector settings of AI apps: they need
  only the address `https://<your nexlore>/api/mcp`. You sign in to nexlore, choose the level and the spaces, and agree.
  The connector then appears in the same list, like a key.

## Levels and tools

The level decides which tools a key can have at all:

| Level | Tools |
|---|---|
| Read | searching, reading notes, links, tasks, versions, tags, comments, attachments, the trash, members |
| Drafts | the above, plus `propose_change` and `propose_note` |
| Write | the above, plus every tool that makes, changes, moves, deletes or shares |

The tools follow what the interface can do: spaces (`create_space`, `set_space_options`), folders (`create_folder`,
`rename_folder`, `move_folder`), notes (`create_note`, `create_from_template`, `write_note`, `edit_note`,
`set_property`, `rename_note` and `move_note` with links following, `merge_notes`), versions (`list_versions`,
`read_version`, `restore_version`), the trash (`list_trash`, `trash_note`, `trash_folder`, `restore_from_trash`,
`empty_trash`), tags (`list_tags`, `rename_tag`), comments (`read_comments`, `add_comment`, `reply_comment`,
`resolve_comment`), tasks and daily notes (`list_tasks`, `complete_task`, `append_to_daily`, `capture_to_inbox`),
attachments (`list_attachments`, `upload_attachment` as base64, at most 10 MB), links (`note_links`,
`unlinked_mentions`, `link_mention`, `cleanup_report`), members (`list_members`, `invite_member`, `set_member_role`,
`remove_member`), public pages (`list_shares`, `create_share`, `remove_share`) and `delete_space`. `tools/list` gives
each with its description and input schema, and marks reading tools `readOnlyHint` and deleting, sharing and member
tools `destructiveHint`. A space cannot be renamed in the interface, so no tool does it.

Search results mark the words found «like this» in their snippet.

## Rights per tool

Under each key, "Rights per tool" sets for every tool:

- **Allow**: it runs at once.
- **Ask**: the call waits for you in nexlore (see below).
- **Deny**: the tool does not exist for the key. It is missing from `tools/list`, and calling it answers like a tool
  that does not exist.

New keys start with the defaults: reading and drafts allowed, making and changing asks, deleting, sharing and members
denied. Reading tools are allowed or denied, never asked for. A tool above the key's level, or blocked by the operator
(at first `delete_space` and `empty_trash`), cannot be chosen and does not exist for the key, whatever it says.

## Approvals

A tool set to Ask answers at once with a request number:

```json
{"request": 17, "status": "waiting", "expires_at": "...", "note": "Waiting for approval in nexlore, request 17. ..."}
```

The request appears under "New since your last visit", in the account menu (Approvals) and on the approvals page,
with the tool and its arguments exactly as they were sent. Approving runs exactly those arguments, against the state
of the notes at that moment (a note changed in the meantime gets a conflict copy, as always); the program cannot
change a request, only make a new one. The rights of the key are checked again on approval: a key revoked, a tool
denied or blocked since, or MCP switched off, and nothing runs. "From now on allow without asking" sets the tool to
Allow for that key. A request runs out after 24 hours; an account has at most 100 waiting.

The program learns what came of it with `request_status` (`waiting`, `done` with the tool's answer, `failed`,
`declined`, `expired`). Only the key that asked sees its request.

Asking inside the program itself (MCP elicitation) is not used: it needs a stream from server to program that this
endpoint does not keep, and not every program supports it.

## Drafts and writing

**Drafts** wait in nexlore: a bar on the note offers to compare and take them over or throw them away, and the
account menu lists all open drafts. Taking one over saves it like the editor does, against the text the AI read; if
the note changed in the meantime, the draft goes into a conflict copy.

**Writing** needs the hash `read_note` gave (`base_hash`). Lines the AI did not change stay byte for byte as they
were. If the note changed since it was read, or somebody is editing it right now, the new text goes into a conflict
copy and nothing is overwritten. Every write is a version with the source "AI (MCP)"; restoring a version or the
trash says "restored", and links rewritten after a rename say who renamed, as in the interface.

## Connecting a client

The endpoint is `https://<your nexlore>/api/mcp`, the transport "Streamable HTTP" without streams: every request gets
its answer as JSON.

**With a key**, it goes into the `Authorization` header:

```
Authorization: Bearer nxl_...
```

In a client that takes a JSON configuration of remote servers, that usually looks like this:

```json
{
  "mcpServers": {
    "nexlore": {
      "type": "http",
      "url": "https://notes.example.com/api/mcp",
      "headers": { "Authorization": "Bearer nxl_..." }
    }
  }
}
```

A quick check from a shell:

```
curl -s https://notes.example.com/api/mcp \
  -H "Authorization: Bearer nxl_..." -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**As a connector**, give the program only the address. It finds the rest itself:

- The 401 of `/api/mcp` names `/.well-known/oauth-protected-resource`, which names nexlore as its authorization server
  (`/.well-known/oauth-authorization-server`).
- The program registers itself (`/api/oauth/register`): public clients only, redirect addresses over HTTPS or to the
  own machine (`http://localhost`, `http://127.0.0.1`).
- It sends you to `/oauth/authorize` with PKCE (S256). You sign in, choose and agree.
- It trades the code once (`/api/oauth/token`), within 10 minutes. Access tokens last an hour; the refresh token changes
  with every refresh, and an old one is refused.

For connectors of hosted AI apps, nexlore must be reachable from the internet over HTTPS, and the addresses it names
come from the public address in Settings, Server (or `NEXLORE_PUBLIC_URL`): set it when nexlore runs behind a reverse
proxy. Revoking the connector in the list ends it at once.

## What is refused

- A request that carries an `Origin` header (every web page sends one): 403. No web page can use a key it got hold
  of.
- MCP switched off: 404, even with a valid key.
- No key, a wrong, revoked or expired key, a locked account, or an account that must set up its second factor first:
  401.
- More than 240 requests a minute with one key: 429 with `Retry-After`.
- An `MCP-Protocol-Version` header naming a version this server does not speak: 400.
- Arguments that do not fit a tool's schema are refused before anything runs or waits.
- The session cookie of the browser counts for nothing here.

An account holds at most 20 keys and connectors, 200 open drafts of at most 5 MB each, and 100 waiting requests.
