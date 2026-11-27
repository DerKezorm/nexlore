/**
 * nexlore's side of the shared MCP module in the browser (mcp 1.1.0, `vendor/nexmcp`): the client its parts call
 * (nexlore's `api`: the tab in every request, its errors with `code`) and nexlore's words for the tools and levels.
 */
import { useTranslation } from 'react-i18next'

import { api } from '../api/client'
import type { McpRequest, McpWords } from '../vendor/nexmcp'

export const mcpRequest: McpRequest = <T,>(path: string, init: Parameters<McpRequest>[1] = {}) =>
  api<T>(path, { method: init.method, body: init.body } as Parameters<typeof api>[1])

/** Where the page of one waiting request is (the module's `RequestPage`). */
export const requestHref = (entry: { id: number | string }) => `/mcp/requests/${entry.id}`

/** The tools and levels in nexlore's words (`mcp.tools.*`, `mcp.level.*`); a tool without words keeps its name. */
export function useMcpWords(): McpWords {
  const { t, i18n } = useTranslation()
  // The whole list of tool names at once, from the loaded words (a test without i18next has none).
  const read = (language: string) =>
    typeof i18n.getResource === 'function' ? (i18n.getResource(language, 'translation', 'mcp.tools') as unknown) : undefined
  const found = read(i18n.resolvedLanguage ?? i18n.language) ?? read('en')
  return {
    tools: found && typeof found === 'object' ? (found as Record<string, string>) : {},
    levels: { read: t('mcp.level.read'), draft: t('mcp.level.draft'), write: t('mcp.level.write') },
  }
}
