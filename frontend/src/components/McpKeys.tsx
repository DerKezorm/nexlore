/**
 * The own MCP keys on the account page: list, make, revoke. A key is shown once, right after it was made, with the
 * address a program needs; afterwards only its first characters. Levels above what the operator allows are not
 * offered. A key sees every space its account may read, or only those chosen when it was made. Nothing here when the
 * operator has not switched MCP on.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, mcpApi, vaultApi, type McpKey, type McpLevel, type Space } from '../api/client'
import { errorText } from '../lib/errors'
import { formatDate } from '../lib/markdown'
import { Symbol } from './Symbol'

const LEVELS: McpLevel[] = ['read', 'draft', 'write']

export function McpKeys() {
  const { t } = useTranslation()
  const [state, setState] = useState<{ allowed: boolean; max_level: McpLevel; keys: McpKey[] } | null>(null)
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [level, setLevel] = useState<McpLevel>('read')
  const [spaces, setSpaces] = useState<Space[]>([])
  // null: every space the account may read, later ones too; otherwise the ids chosen.
  const [chosen, setChosen] = useState<number[] | null>(null)
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const load = () => mcpApi.keys().then(setState, () => setState(null))
  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    if (!making) return
    let current = true
    vaultApi.spaces().then((found) => current && setSpaces(found), () => undefined)
    return () => {
      current = false
    }
  }, [making])

  if (!state?.allowed) return null
  const ready = Boolean(name.trim()) && (chosen === null || chosen.length > 0)
  const offered = LEVELS.slice(0, LEVELS.indexOf(state.max_level) + 1)
  const address = `${window.location.origin}/api/mcp`

  const make = async () => {
    setProblem(null)
    try {
      const made = await mcpApi.make(name.trim(), level, chosen)
      setShown({ name: made.key.name, token: made.token })
      setCopied(false)
      setMaking(false)
      setName('')
      setLevel('read')
      setChosen(null)
      await load()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    }
  }

  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5" aria-labelledby="mcp-title">
      <h2 id="mcp-title" className="mb-1 flex items-center gap-2 font-semibold">
        <Symbol name="key" className="h-4 w-4 text-accent-400" /> {t('mcp.title')}
      </h2>
      <p className="mb-4 text-sm text-mist-500">{t('mcp.text')}</p>
      {problem && <p role="alert" className="mb-3 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">{problem}</p>}
      {shown && (
        <div className="mb-4 rounded-xl border border-accent-500/40 bg-accent-500/10 p-3 text-sm" data-testid="mcp-token">
          <p className="font-semibold text-mist-100">{t('mcp.shownOnce', { name: shown.name })}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-ink-950 px-2 py-1.5 font-mono text-xs text-mist-200">{shown.token}</code>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(shown.token).then(() => setCopied(true), () => undefined)}
              className="shrink-0 rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent"
            >
              {copied ? t('mcp.copied') : t('mcp.copy')}
            </button>
          </div>
          <p className="mt-2 text-xs text-mist-400">
            {t('mcp.address')} <code className="font-mono break-all">{address}</code>
          </p>
          <button type="button" onClick={() => setShown(null)} className="mt-2 text-xs text-mist-400 underline">
            {t('mcp.done')}
          </button>
        </div>
      )}
      {state.keys.length === 0 ? (
        <p className="text-sm text-mist-500">{t('mcp.none')}</p>
      ) : (
        <ul className="divide-y divide-ink-800">
          {state.keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <span className="font-medium text-mist-100">{key.name}</span>
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs text-mist-300">{t(`mcp.level.${key.level}`)}</span>
              <span className="text-xs text-mist-400" data-testid="mcp-key-spaces">
                {key.spaces === null ? t('mcp.spacesAll') : key.spaces.length ? key.spaces.join(', ') : t('mcp.spacesNone')}
              </span>
              <code className="font-mono text-xs text-mist-500">{key.prefix}…</code>
              <span className="text-xs text-mist-500">
                {key.last_used_at ? t('mcp.used', { when: formatDate(key.last_used_at) }) : t('mcp.unused')}
              </span>
              <button
                type="button"
                onClick={() => void mcpApi.revoke(key.id).then(load, (error) => setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error')))}
                className="ml-auto text-xs text-bad-500 hover:underline"
                aria-label={t('mcp.revokeNamed', { name: key.name })}
              >
                {t('mcp.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!making ? (
        <button
          type="button"
          onClick={() => setMaking(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1.5 text-sm text-mist-200 hover:bg-ink-850"
        >
          <Symbol name="plus" /> {t('mcp.new')}
        </button>
      ) : (
        <form
          className="mt-4 space-y-3 rounded-xl border border-ink-700 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (ready) void make()
          }}
        >
          <label className="block text-sm text-mist-300">
            {t('mcp.name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              autoFocus
              placeholder={t('mcp.namePlaceholder')}
              className="mt-1 block h-9 w-full rounded-lg border border-ink-700 bg-ink-950 px-2 text-mist-100 outline-none focus:border-accent-500"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm text-mist-300">{t('mcp.what')}</legend>
            {offered.map((option) => (
              <label key={option} className={'flex cursor-pointer gap-3 rounded-xl border p-3 ' + (level === option ? 'border-accent-500/60 bg-accent-500/10' : 'border-ink-700')}>
                <input type="radio" name="mcp-level" checked={level === option} onChange={() => setLevel(option)} className="mt-1" />
                <span>
                  <span className="block text-sm font-medium text-mist-100">{t(`mcp.level.${option}`)}</span>
                  <span className="block text-xs text-mist-500">{t(`mcp.levelText.${option}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm text-mist-300">{t('mcp.where')}</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-mist-100">
              <input type="radio" name="mcp-spaces" checked={chosen === null} onChange={() => setChosen(null)} />
              {t('mcp.allSpaces')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-mist-100">
              <input type="radio" name="mcp-spaces" checked={chosen !== null} onChange={() => setChosen([])} />
              {t('mcp.someSpaces')}
            </label>
            {chosen !== null && (
              <div className="ml-6 flex flex-wrap gap-2">
                {spaces.map((space) => (
                  <label key={space.id} className={'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ' + (chosen.includes(space.id) ? 'border-accent-500/60 bg-accent-500/10 text-mist-100' : 'border-ink-700 text-mist-300')}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(space.id)}
                      onChange={(event) =>
                        setChosen((before) =>
                          event.target.checked ? [...(before ?? []), space.id] : (before ?? []).filter((id) => id !== space.id),
                        )
                      }
                    />
                    {space.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMaking(false)} className="rounded-full px-3 py-1 text-sm text-mist-400">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={!ready} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent disabled:opacity-50">
              {t('mcp.make')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
