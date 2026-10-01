/**
 * Approvals (block Y): what an AI program asked to do with a tool set to "Ask". Each request shows its tool and its
 * arguments as they were sent; approving runs exactly those, declining does nothing. A request runs out after a day.
 * Decided ones stay below for a while, with what came of them.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, mcpApi, type McpRequest } from '../api/client'
import { Symbol } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { formatDate } from '../lib/markdown'
import { REQUESTS_EVENT } from '../lib/mcpRequests'

/** Long texts (a whole note, a file as base64) are cut for the list; the full text runs all the same. */
const SHOWN = 600

function Value({ value }: { value: unknown }) {
  const { t } = useTranslation()
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const [all, setAll] = useState(false)
  const long = text.length > SHOWN
  return (
    <span className="font-mono text-xs break-words whitespace-pre-wrap text-mist-100">
      {all || !long ? text : text.slice(0, SHOWN) + ' …'}
      {long && (
        <button type="button" onClick={() => setAll((open) => !open)} className="ml-2 font-sans text-accent-400 underline">
          {all ? t('requests.less') : t('requests.more', { count: text.length })}
        </button>
      )}
    </span>
  )
}

function Request({ request, onChange }: { request: McpRequest; onChange: () => void }) {
  const { t, i18n } = useTranslation()
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const waiting = request.status === 'waiting'
  const decide = async (approve: boolean) => {
    setBusy(true)
    setProblem(null)
    try {
      await (approve ? mcpApi.approve(request.id, always) : mcpApi.decline(request.id))
      onChange()
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
    } finally {
      setBusy(false)
    }
  }
  const title = i18n.exists(`mcp.tools.${request.tool}`) ? t(`mcp.tools.${request.tool}`) : request.description
  const tone = { waiting: 'text-warn-500 bg-warn-500/15', done: 'text-ok-500 bg-ok-500/15', failed: 'text-bad-500 bg-bad-500/15', declined: 'text-mist-300 bg-ink-700', expired: 'text-mist-300 bg-ink-700' }[request.status]
  return (
    <article className="rounded-2xl border border-ink-700 bg-ink-900 p-4" data-testid={`request-${request.id}`} aria-labelledby={`request-${request.id}-title`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={'rounded-full px-2 py-0.5 font-medium ' + tone}>{t(`requests.status.${request.status}`)}</span>
        <span className="font-semibold text-mist-100">{t('requests.number', { id: request.id })}</span>
        <span className="text-mist-500">
          {t('requests.from', { key: request.key_name, when: formatDate(request.created_at) })}
          {/* Ahead, not past: formatDate would call every time to come "today". */}
          {waiting && ` · ${t('requests.until', { when: new Date(request.expires_at).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) })}`}
        </span>
      </div>
      <h2 id={`request-${request.id}-title`} className="mt-2 font-semibold">
        {title}
      </h2>
      <p className="text-xs text-mist-500">
        {t('requests.tool')} <code className="font-mono">{request.tool}</code>
      </p>
      <dl className="mt-3 divide-y divide-ink-700 rounded-xl border border-ink-700 bg-ink-950 text-sm">
        {Object.entries(request.arguments).map(([name, value]) => (
          <div key={name} className="grid grid-cols-[minmax(6rem,9rem)_1fr] gap-3 px-3 py-2">
            <dt className="text-mist-500">{name}</dt>
            <dd className="min-w-0">
              <Value value={value} />
            </dd>
          </div>
        ))}
        {Object.keys(request.arguments).length === 0 && <p className="px-3 py-2 text-mist-500">{t('requests.noArguments')}</p>}
      </dl>
      {waiting ? (
        <>
          <p className="mt-2 text-xs text-mist-500">{t('requests.exactly')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void decide(true)} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50">
              {t('requests.approve')}
            </button>
            <button type="button" disabled={busy} onClick={() => void decide(false)} className="rounded-full border border-ink-700 px-4 py-1.5 text-sm text-mist-300 hover:border-bad-500/50 hover:text-bad-500 disabled:opacity-50">
              {t('requests.decline')}
            </button>
            <label className="flex items-center gap-1.5 text-xs text-mist-400">
              <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} />
              {t('requests.always', { tool: request.tool })}
            </label>
          </div>
        </>
      ) : (
        request.result !== null &&
        request.result !== undefined && (
          <div className="mt-3 text-xs text-mist-400">
            <span className="mr-1">{t('requests.result')}</span>
            <Value value={request.result} />
          </div>
        )
      )}
      <div aria-live="polite">{problem && <p className="mt-2 text-sm text-bad-500">{problem}</p>}</div>
    </article>
  )
}

export function McpRequestsPage() {
  const { t } = useTranslation()
  const [requests, setRequests] = useState<McpRequest[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => {
    void mcpApi.requests().then(
      (found) => {
        setRequests(found)
        setProblem(null)
        window.dispatchEvent(new Event(REQUESTS_EVENT))
      },
      (error) => setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error')),
    )
  }, [])
  useEffect(load, [load])
  const waiting = requests?.filter((request) => request.status === 'waiting') ?? []
  const decided = requests?.filter((request) => request.status !== 'waiting') ?? []
  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Symbol name="key" className="h-5 w-5 text-accent-400" /> {t('requests.title')}
          </h1>
          <p className="mt-1 text-sm text-mist-500">{t('requests.text')}</p>
        </div>
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
        {requests && waiting.length === 0 && <p className="text-sm text-mist-500" data-testid="requests-none">{t('requests.none')}</p>}
        {waiting.map((request) => (
          <Request key={request.id} request={request} onChange={load} />
        ))}
        {decided.length > 0 && (
          <details className="rounded-2xl border border-ink-700 px-4 py-2">
            <summary className="cursor-pointer text-sm text-mist-300">{t('requests.decided', { count: decided.length })}</summary>
            <div className="mt-3 space-y-3 pb-2">
              {decided.map((request) => (
                <Request key={request.id} request={request} onChange={load} />
              ))}
            </div>
          </details>
        )}
      </div>
    </main>
  )
}
