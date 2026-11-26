/**
 * nexlore's own part of the card "KI-Werkzeuge (MCP)" (schluessel, `ToolsCard children`): how a program connects. The
 * rights per tool and the waiting requests come from the shared module mcp 1.1.0 (`vendor/nexmcp`).
 */
import { useTranslation } from 'react-i18next'

import { mcpCommand, mcpJson } from '../../lib/mcp'
import { Collapsible, CopyRow } from '../../vendor/nexui'

/** nexlore's own box under "KI-Werkzeuge (MCP)" (`ToolsCard children`): how a program connects, the lines to copy
 * for the mcp.json format and for a command line, with a stand-in where the key goes (it was shown only once). */
export function McpRecipes() {
  const { t } = useTranslation()
  const address = `${window.location.origin}/api/mcp`
  const key = t('mcp.yourKey')
  return (
    <Collapsible title={t('mcp.howTo')} testId="mcp-how-to">
      <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('mcp.howToText')}</p>
      <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('mcp.connectorHow')}</p>
      <CopyRow label={t('mcp.recipeConnector')} value={address} testId="mcp-recipe-address" />
      <CopyRow label={t('mcp.recipeJson')} value={mcpJson(address, key)} testId="mcp-recipe-json" />
      <CopyRow label={t('mcp.recipeCommand')} value={mcpCommand(address, key)} testId="mcp-recipe-command" />
    </Collapsible>
  )
}
