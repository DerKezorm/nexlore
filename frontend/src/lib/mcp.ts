/** What a program needs to reach nexlore over MCP, ready to paste: the address and a key. */

/** What a program that reads an `mcp.json` needs (Cursor, for example, or a project's `.mcp.json`): JSON. */
export function mcpJson(address: string, token: string): string {
  return JSON.stringify({ mcpServers: { nexlore: { type: 'http', url: address, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
}

