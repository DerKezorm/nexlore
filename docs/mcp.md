# AI from outside: MCP

nexlore speaks the Model Context Protocol, so an AI program on your computer or an agent can search and read your
notes, propose changes, or write, depending on the key you give it. It sees only what your account may read, and
less if you limit the key to some spaces.

## Switching it on

MCP is off until the operator opens it: Settings, AI (MCP). There the operator also sets the highest level a key may
have. Lowering it later applies to keys made before.

Then every account makes its own keys on its account page: a name, a level and which spaces the key may see (all
spaces the account may read, later ones too, or only the ones chosen). The key is shown once. nexlore keeps only its
hash and its first characters, to tell keys apart.

## Levels

| Level | Tools |
|---|---|
| Read | `list_spaces`, `search`, `find_notes`, `read_note`, `list_folder`, `note_links`, `list_tasks` |
| Drafts | the above, plus `propose_change` and `propose_note` |
| Write | the above, plus `write_note`, `edit_note` and `create_note` |

Search results mark the words found «like this» in their snippet.

A tool above the key's level does not exist for it. A space the key may not see answers "Not found.", exactly like
one that does not exist.

**Drafts** wait in nexlore: a bar on the note offers to compare and take them over or throw them away, and the
account menu lists all open drafts. Taking one over saves it like the editor does, against the text the AI read; if
the note changed in the meantime, the draft goes into a conflict copy.

**Writing** needs the hash `read_note` gave (`base_hash`). Lines the AI did not change stay byte for byte as they
were. If the note changed since it was read, or somebody is editing it right now, the new text goes into a conflict
copy and nothing is overwritten. Every write is a version with the source "AI (MCP)".

## Connecting a client

The endpoint is `https://<your nexlore>/api/mcp`, the transport "Streamable HTTP" without streams: every request gets
its answer as JSON. The key goes into the `Authorization` header:

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

## What is refused

- A request that carries an `Origin` header (every web page sends one): 403. No web page can use a key it got hold
  of.
- MCP switched off: 404, even with a valid key.
- No key, a wrong or revoked key, a locked account, or an account that must set up its second factor first: 401.
- More than 240 requests a minute with one key: 429 with `Retry-After`.
- An `MCP-Protocol-Version` header naming a version this server does not speak: 400.
- The session cookie of the browser counts for nothing here.

An account holds at most 20 keys and 200 open drafts of at most 5 MB each.
