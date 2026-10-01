/**
 * What one MCP key may do with each tool (block Y, design answers Y1 and Y4): under the key on the account page, in the
 * four groups of the server. Allow runs at once, Ask keeps the call for approval in nexlore, Deny hides the tool. A
 * tool above the key's level or blocked by the operator cannot be chosen. Every change is saved at once.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, mcpApi, type McpGroup, type McpKey, type McpRight, type McpTools } from '../api/client'
import { errorText } from '../lib/errors'

const GROUPS: McpGroup[] = ['read', 'draft', 'change', 'risky']
const RIGHTS: McpRight[] = ['allow', 'ask', 'deny']
const ORDER = ['read', 'draft', 'write']
const ON: Record<McpRight, string> = {
  allow: 'bg-ok-500/15 font-semibold text-ok-500',
  ask: 'bg-warn-500/15 font-semibold text-warn-500',
  deny: 'bg-bad-500/15 font-semibold text-bad-500',
}

export function ToolRights({ mcpKey, catalog, onSaved }: { mcpKey: McpKey; catalog: McpTools; onSaved: (key: McpKey) => void }) {
  const { t, i18n } = useTranslation()
  const [rights, setRights] = useState<Record<string, McpRight>>(mcpKey.rights)
  const [filter, setFilter] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const blocked = useMemo(() => new Set(catalog.blocked), [catalog.blocked])

  const save = async (next: Record<string, McpRight>) => {
    const before = rights
    setRights(next)
    setSaved(false)
    try {
      const answer = await mcpApi.setRights(mcpKey.id, next)
      setRights(answer.rights)
      setSaved(true)
      setProblem(null)
      onSaved(answer)
    } catch (error) {
      setRights(before)
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }

  const what = (name: string, fallback: string) => (i18n.exists(`mcp.tools.${name}`) ? t(`mcp.tools.${name}`) : fallback)
  const words = filter.trim().toLowerCase()
  return (
    <div className="mt-2 rounded-xl border border-ink-700 bg-ink-850 p-3" data-testid={`tool-rights-${mcpKey.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-mist-100">{t('mcp.rights.title', { name: mcpKey.name })}</h3>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('mcp.rights.search')}
          aria-label={t('mcp.rights.search')}
          className="h-8 w-44 rounded-lg border border-ink-700 bg-ink-950 px-2 text-sm"
        />
        <button type="button" onClick={() => void save({})} className="rounded-full border border-ink-700 px-3 py-1 text-xs text-mist-300 hover:bg-ink-800">
          {t('mcp.rights.defaults')}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-mist-500">{t('mcp.rights.text')}</p>
      <div aria-live="polite" className="text-xs">
        {problem && <p className="mt-2 text-bad-500">{problem}</p>}
        {saved && <p className="mt-2 text-ok-500">{t('mcp.rights.saved')}</p>}
      </div>
      {GROUPS.map((group) => {
        const tools = catalog.tools.filter(
          (tool) => tool.group === group && (!words || tool.name.includes(words) || what(tool.name, tool.description).toLowerCase().includes(words)),
        )
        if (!tools.length) return null
        return (
          <section key={group} className="mt-4" aria-label={t(`mcp.rights.group.${group}`)}>
            <h4 className="mb-1 text-xs font-medium tracking-wide text-mist-400 uppercase">
              {t(`mcp.rights.group.${group}`)} <span className="ml-1 rounded-full bg-ink-700 px-1.5 text-[10px] text-mist-300">{tools.length}</span>
            </h4>
            {tools.map((tool) => {
              const above = ORDER.indexOf(tool.level) > ORDER.indexOf(mcpKey.level)
              const off = blocked.has(tool.name)
              const current = rights[tool.name] ?? catalog.defaults[group]
              return (
                <div key={tool.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-700 py-2">
                  <div className="min-w-0 flex-1">
                    <code className="font-mono text-xs text-mist-100">{tool.name}</code>
                    <p className="text-xs text-mist-500">{what(tool.name, tool.description)}</p>
                    {(above || off) && (
                      <p className="text-[11px] text-mist-600">{off ? t('mcp.rights.blocked') : t('mcp.rights.above')}</p>
                    )}
                  </div>
                  <div role="radiogroup" aria-label={tool.name} className="inline-flex overflow-hidden rounded-full border border-ink-600">
                    {RIGHTS.map((right) => (
                      <button
                        key={right}
                        type="button"
                        role="radio"
                        aria-checked={current === right}
                        disabled={above || off || (group === 'read' && right === 'ask')}
                        onClick={() => void save({ ...rights, [tool.name]: right })}
                        className={
                          'px-2.5 py-1 text-xs transition-colors not-first:border-l not-first:border-ink-600 disabled:cursor-not-allowed disabled:opacity-35 ' +
                          (current === right ? ON[right] : 'text-mist-400 hover:bg-ink-800')
                        }
                      >
                        {t(`mcp.rights.${right}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
