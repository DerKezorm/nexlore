/**
 * nexlore's own part of the card "KI-Werkzeuge (MCP)" (schluessel 1.0.0, `ToolsCard extra`): per MCP key and per
 * connected program, what it may do with each tool (block Y: allow, ask, deny), in a window of the ui kit.
 */
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { mcpApi, type McpKey, type McpTools } from '../../api/client'
import { Button, Dialog } from '../../vendor/nexui'
import type { KeyEntry } from '../../vendor/nexschluessel/schluessel'
import { ToolRights } from '../ToolRights'

/** The row id of an MCP key in the module's list (`mcp-<row>`), or null for an API key. */
function rowOf(entry: KeyEntry): number | null {
  const found = /^mcp-(\d+)$/.exec(String(entry.id))
  return entry.kind === 'mcp' && found ? Number(found[1]) : null
}

let shared: Promise<[McpKey[], McpTools]> | null = null

export function McpToolRights({ entry }: { entry: KeyEntry }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<{ key: McpKey; catalog: McpTools } | null>(null)
  const id = rowOf(entry)
  useEffect(() => {
    if (!open || id === null) return
    shared = Promise.all([mcpApi.keys().then((answer) => answer.keys), mcpApi.tools()])
    void shared.then(([keys, catalog]) => {
      const key = keys.find((one) => one.id === id)
      if (key) setFound({ key, catalog })
    })
  }, [open, id])
  if (id === null) return null
  return (
    <>
      <Button kind="secondary" size="sm" icon={SlidersHorizontal} onClick={() => setOpen(true)} testId="tool-rights-open">
        {t('mcp.rights.open')}
      </Button>
      {open && (
        <Dialog title={t('mcp.rights.title', { name: entry.name ?? '' })} onClose={() => setOpen(false)} closeLabel={t('common.close')} testId="tool-rights-dialog">
          {found && <ToolRights mcpKey={found.key} catalog={found.catalog} onSaved={(key) => setFound({ ...found, key })} />}
        </Dialog>
      )}
    </>
  )
}
