/** Settings: the language for real, the rest as a sketch (sign-in, spaces, AI access over MCP, plugins). */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Symbol, type SymbolName } from '../components/Symbol'
import { changeLanguage, downloadTemplate, languageOptions, type LanguageOption } from '../i18n'
import { ApiError, vaultApi } from '../api/client'
import { errorText } from '../lib/errors'
import { formatDate } from '../lib/markdown'
import { MCP_KEYS } from '../mock/later'
import { useStore } from '../state/store'

type Right = 'readNotes' | 'readOpen' | 'writeOpen' | 'writeNew'
type Plugin = { id: 'calendar' | 'mermaid' | 'kanban' | 'templates' | 'readingTime'; rights: Right[]; on: boolean; installed: boolean }

const PLUGINS: Plugin[] = [
  { id: 'calendar', rights: ['readNotes'], on: true, installed: true },
  { id: 'mermaid', rights: ['readOpen'], on: true, installed: true },
  { id: 'kanban', rights: ['writeOpen'], on: false, installed: true },
  { id: 'templates', rights: ['writeNew'], on: false, installed: false },
  { id: 'readingTime', rights: ['readOpen'], on: false, installed: false },
]

const MCP_MODES = ['read', 'drafts', 'write'] as const

export function SettingsPage() {
  const { t } = useTranslation()
  const [mcpOn, setMcpOn] = useState(true)
  const [mode, setMode] = useState<(typeof MCP_MODES)[number]>('drafts')
  const [plugins, setPlugins] = useState(PLUGINS)

  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
          <p className="mt-1 text-sm text-mist-500">{t('settings.sketch')}</p>
        </div>

        <LanguageCard />

        <Card symbol="shield" title={t('settings.signin.title')} text={t('settings.signin.text')}>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
            <span className="h-2 w-2 rounded-full bg-ok-500" />
            <span className="font-medium">authentik</span>
            <span className="font-mono text-xs text-mist-500">https://auth.example.com</span>
            <span className="ml-auto text-xs text-mist-500">{t('settings.signin.signedIn', { count: 4 })}</span>
          </div>
        </Card>

        <Card symbol="users" title={t('settings.spaces.title')} text={t('settings.spaces.text')}>
          <SpaceList />
        </Card>

        <Card symbol="sparkle" title={t('settings.mcp.title')} text={t('settings.mcp.text')}>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
            <span>
              <span className="font-medium">{t('settings.mcp.allow')}</span>
              <span className="block text-xs text-mist-500">{t('settings.mcp.allowHint')}</span>
            </span>
            <input type="checkbox" checked={mcpOn} onChange={(e) => setMcpOn(e.target.checked)} className="h-5 w-5 accent-accent-500" />
          </label>
          {mcpOn && (
            <>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {MCP_MODES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={'rounded-xl border px-3 py-2.5 text-left text-sm ' + (mode === value ? 'border-accent-500 bg-accent-500/10' : 'border-ink-700 hover:bg-ink-850')}
                  >
                    <span className="block font-medium">{t(`settings.mcp.mode.${value}`)}</span>
                    <span className="mt-0.5 block text-xs text-mist-500">{t(`settings.mcp.mode.${value}Text`)}</span>
                  </button>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-ink-700">
                <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-2.5 text-sm">
                  <span className="text-mist-500">{t('settings.mcp.address')}</span>
                  <code className="rounded bg-ink-800 px-2 py-0.5 font-mono text-xs">https://notes.example.com/mcp</code>
                </div>
                {MCP_KEYS.map((entry) => (
                  <div key={entry.name} className="flex flex-wrap items-center gap-3 border-b border-ink-700/60 px-4 py-3 text-sm last:border-0">
                    <Symbol name="key" className="h-4 w-4 text-mist-500" />
                    <span className="font-medium">{entry.name}</span>
                    <span className="font-mono text-xs text-mist-600">{entry.key}</span>
                    <span className="ml-auto text-xs text-mist-500">
                      {formatDate(entry.used)} ·{' '}
                      {entry.did.kind === 'draft'
                        ? t('settings.mcp.createdDraft', { title: entry.did.title })
                        : t('settings.mcp.readNotes', { count: entry.did.count })}
                    </span>
                    <button type="button" className="rounded-full border border-ink-700 px-2.5 py-0.5 text-xs text-mist-400 hover:border-bad-500/50 hover:text-bad-500">
                      {t('settings.mcp.revoke')}
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="mt-3 inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
                <Symbol name="plus" /> {t('settings.mcp.newKey')}
              </button>
            </>
          )}
        </Card>

        <Card symbol="plug" title={t('settings.plugins.title')} text={t('settings.plugins.text')}>
          <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
            {plugins.map((plugin, index) => {
              const name = t(`settings.plugins.${plugin.id}.name`)
              return (
                <li key={plugin.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{name}</span>
                    <span className="block text-xs text-mist-500">{t(`settings.plugins.${plugin.id}.text`)}</span>
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {plugin.rights.map((right) => (
                        <span key={right} className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-mist-400">
                          {t(`settings.plugins.right.${right}`)}
                        </span>
                      ))}
                      <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-mist-600">{t('settings.plugins.noNetwork')}</span>
                    </span>
                  </span>
                  {plugin.installed ? (
                    <input
                      type="checkbox"
                      checked={plugin.on}
                      onChange={(e) => setPlugins((list) => list.map((p, i) => (i === index ? { ...p, on: e.target.checked } : p)))}
                      className="h-5 w-5 accent-accent-500"
                      aria-label={t('settings.plugins.enable', { name })}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPlugins((list) => list.map((p, i) => (i === index ? { ...p, installed: true, on: true } : p)))}
                      className="rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-400"
                    >
                      {t('settings.plugins.install')}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </main>
  )
}

/** The one part that works for real: the language menu, with the operator's own languages from the server. */
/** The spaces as they are on disk: folders at the top of the vault. Members and rights come with M4. */
function SpaceList() {
  const { t } = useTranslation()
  const { spaces, reload } = useStore()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const create = async () => {
    if (!name.trim()) return
    try {
      await vaultApi.createSpace(name.trim())
      setName('')
      setProblem(null)
      await reload()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  return (
    <>
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
        {spaces.map((space) => (
          <li key={space.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="font-medium">{space.name}</span>
            <span className="font-mono text-xs text-mist-600">vault/{space.name}/</span>
            <span className="ml-auto text-xs text-mist-500">{t('settings.spaces.count', { count: space.notes })}</span>
          </li>
        ))}
        {spaces.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('settings.spaces.none')}</li>}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('settings.spaces.newName')}
          aria-label={t('settings.spaces.newName')}
          className="h-9 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 text-sm outline-none focus:border-accent-500"
        />
        <button type="submit" className="h-9 rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400">
          {t('settings.spaces.create')}
        </button>
        {problem && <span className="w-full text-xs text-bad-500">{errorText(problem)}</span>}
      </form>
    </>
  )
}

function LanguageCard() {
  const { t, i18n } = useTranslation()
  const [options, setOptions] = useState<LanguageOption[]>([])

  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setOptions(list))
    return () => {
      alive = false
    }
  }, [])

  return (
    <Card symbol="globe" title={t('settings.language.title')} text={t('settings.language.text')}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
        <label htmlFor="language" className="font-medium">
          {t('settings.language.choose')}
        </label>
        <select
          id="language"
          value={i18n.language}
          onChange={(e) => void changeLanguage(e.target.value)}
          className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-mist-100"
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
              {option.added ? ` (${t('settings.language.added')})` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={downloadTemplate}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800"
          title={t('settings.language.templateHint')}
        >
          <Symbol name="download" /> {t('settings.language.template')}
        </button>
      </div>
      <p className="mt-2 text-xs text-mist-500">{t('settings.language.templateHint')}</p>
    </Card>
  )
}

function Card({ symbol, title, text, children }: { symbol: SymbolName; title: string; text: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
      <div className="mb-4 flex gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/12 text-accent-400">
          <Symbol name={symbol} />
        </span>
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-sm text-mist-500">{text}</p>
        </div>
      </div>
      {children}
    </section>
  )
}
