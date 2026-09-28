/** What a program needs to reach nexlore over MCP, ready to paste: the address and a key. */

/** What a program that reads an `mcp.json` needs (Cursor, for example, or a project's `.mcp.json`): JSON. */
export function mcpJson(address: string, token: string): string {
  return JSON.stringify({ mcpServers: { nexlore: { type: 'http', url: address, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
}


/** The same for Claude Code, as one command. */
export function mcpCommand(address: string, token: string): string {
  return `claude mcp add --transport http nexlore ${address} --header "Authorization: Bearer ${token}"`
}
