/**
 * The own API tokens on the account page, at the top of Connections: for programs such as n8n or nexdeck
 * (`/api/v1`). List, make, delete. A token is shown once, right after it was made, with the header line a program
 * needs and a command to try it; afterwards only its first characters.
 *
 * A token may only read, or also write (make and change, never delete, move or share); it sees every space its
 * account may read or only those chosen; it runs out after 30, 90 or 365 days, or never. A week before, the list
 * marks it (and a notification goes out, when the account wants that). A token the operator blocked stays in the
 * list, marked, until the account deletes it.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, apiTokensApi, vaultApi, type ApiLevel, type ApiToken, type Space } from '../api/client'
import { errorText } from '../lib/errors'
import { formatDate, formatDay } from '../lib/markdown'
import { copyText } from '../lib/vaultActions'
import { useAuth } from '../state/auth'
import { Symbol } from './Symbol'

const LEVELS: ApiLevel[] = ['read', 'write']
/** Days until a token runs out; null: never (the default, design answer). */
const LIFETIMES: (number | null)[] = [30, 90, 365, null]
const WEEK = 7 * 24 * 60 * 60 * 1000

/** What the API offers, in short; the whole description is `docs/api.md`. */
const ROUTES: [string, string][] = [
  ['GET', '/api/v1/me'],
  ['GET', '/api/v1/spaces'],
  ['GET', '/api/v1/folder?path='],
  ['GET', '/api/v1/note?path='],
  ['GET', '/api/v1/links?path='],
  ['GET', '/api/v1/search?q='],
  ['GET', '/api/v1/recent'],
  ['GET', '/api/v1/tasks'],
  ['GET', '/api/v1/dashboard'],
  ['GET', '/api/v1/templates?space='],
  ['POST', '/api/v1/notes'],
  ['PUT', '/api/v1/note'],
  ['POST', '/api/v1/note/append'],
  ['POST', '/api/v1/daily'],
  ['POST', '/api/v1/inbox'],
  ['POST', '/api/v1/tasks/complete'],
]

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

/** One line to copy: what it is for, the text, and a button. */
function Line({ label, text, copied, onCopy }: { label: string; text: string; copied: boolean; onCopy: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-mist-400">
        <span className="flex-1">{label}</span>
        <button type="button" onClick={onCopy} aria-label={t('mcp.copyNamed', { what: label })} className="rounded-full border border-ink-700 px-2 py-0.5 text-[11px] text-mist-300 hover:bg-ink-850">
          {copied ? t('mcp.copied') : t('mcp.copy')}
        </button>
      </div>
      <pre className="nn-scroll overflow-x-auto rounded-lg bg-ink-950 px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre text-mist-200">{text}</pre>
    </div>
  )
}

export function ApiTokens() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [state, setState] = useState<{ allowed: boolean; tokens: ApiToken[] } | null>(null)
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [level, setLevel] = useState<ApiLevel>('read')
  const [spaces, setSpaces] = useState<Space[]>([])
  // null: every space the account may read, later ones too; otherwise the ids chosen.
  const [chosen, setChosen] = useState<number[] | null>(null)
  const [days, setDays] = useState<number | null>(null)
  const [shown, setShown] = useState<{ name: string; secret: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  // The moment of the last load, for "runs out soon": a render must not read the clock.
  const [now, setNow] = useState(0)
  const load = () =>
    apiTokensApi.list().then(
      (found) => {
        setState(found)
        setNow(Date.now())
      },
      () => setState(null),
    )
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

  if (!state) return null
  const title = (
    <h2 id="api-tokens-title" className="mb-1 flex items-center gap-2 font-semibold">
      <Symbol name="key" className={'h-4 w-4 ' + (state.allowed ? 'text-accent-400' : 'text-mist-500')} /> {t('apiTokens.title')}
    </h2>
  )
  if (!state.allowed)
    return (
      <section id="api-tokens" className="rounded-2xl border border-ink-700 bg-ink-900 p-5" aria-labelledby="api-tokens-title">
        {title}
        <p className="text-sm text-mist-500" data-testid="api-tokens-off">
          {t('apiTokens.off')}{' '}
          {me?.role === 'operator' && (
            <Link to="/settings?tab=server&sub=extensions#api-tokens" className="text-accent-400 hover:underline">
              {t('apiTokens.offOperator')}
            </Link>
          )}
        </p>
      </section>
    )

  const ready = Boolean(name.trim()) && (chosen === null || chosen.length > 0)
  const header = (secret: string) => `Authorization: Bearer ${secret}`
  const curl = (secret: string) => `curl -H "Authorization: Bearer ${secret}" ${window.location.origin}/api/v1/me`
  const copy = (what: string, text: string) => void copyText(text).then((done) => done && setCopied(what))

  const make = async () => {
    setProblem(null)
    try {
      const made = await apiTokensApi.make(name.trim(), level, chosen, days)
      setShown({ name: made.token.name, secret: made.secret })
      setCopied(null)
      setMaking(false)
      setName('')
      setLevel('read')
      setChosen(null)
      setDays(null)
      await load()
    } catch (error) {
      setProblem(errorText(code(error)))
    }
  }

  const ending = (token: ApiToken) => {
    if (!token.expires_at) return { text: t('apiTokens.never'), soon: false }
    const at = new Date(token.expires_at).getTime()
    if (at <= now) return { text: t('apiTokens.ranOut', { day: formatDay(token.expires_at) }), soon: true }
    return { text: t('apiTokens.runsOut', { day: formatDay(token.expires_at) }), soon: at - now <= WEEK }
  }

  return (
    <section id="api-tokens" className="rounded-2xl border border-ink-700 bg-ink-900 p-5" aria-labelledby="api-tokens-title">
      {title}
      <p className="mb-4 text-sm text-mist-500">{t('apiTokens.text')}</p>
      {problem && <p role="alert" className="mb-3 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">{problem}</p>}
      {shown && (
        <div className="mb-4 rounded-xl border border-accent-500/40 bg-accent-500/10 p-3 text-sm" data-testid="api-token-shown">
          <p className="font-semibold text-mist-100">{t('apiTokens.shownOnce', { name: shown.name })}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-ink-950 px-2 py-1.5 font-mono text-xs text-mist-200">{shown.secret}</code>
            <button type="button" onClick={() => copy('token', shown.secret)} className="shrink-0 rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent">
              {copied === 'token' ? t('mcp.copied') : t('mcp.copy')}
            </button>
          </div>
          <Line label={t('apiTokens.header')} text={header(shown.secret)} copied={copied === 'header'} onCopy={() => copy('header', header(shown.secret))} />
          <Line label={t('apiTokens.tryIt')} text={curl(shown.secret)} copied={copied === 'curl'} onCopy={() => copy('curl', curl(shown.secret))} />
          <button type="button" onClick={() => setShown(null)} className="mt-2 text-xs text-mist-400 underline">
            {t('mcp.done')}
          </button>
        </div>
      )}
      {state.tokens.length === 0 ? (
        <p className="text-sm text-mist-500">{t('apiTokens.none')}</p>
      ) : (
        <ul className="divide-y divide-ink-800">
          {state.tokens.map((token) => {
            const end = ending(token)
            return (
              <li key={token.id} className="py-2.5 text-sm" data-testid="api-token">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-mist-100">{token.name}</span>
                  <code className="font-mono text-xs text-mist-500">{token.prefix}…</code>
                  <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs text-mist-300">{t(`apiTokens.level.${token.level}`)}</span>
                  <span className="text-xs text-mist-400">
                    {token.spaces === null ? t('mcp.spacesAll') : token.spaces.length ? token.spaces.join(', ') : t('mcp.spacesNone')}
                  </span>
                  <button
                    type="button"
                    onClick={() => void apiTokensApi.remove(token.id).then(load, (error) => setProblem(errorText(code(error))))}
                    className="ml-auto text-xs text-bad-500 hover:underline"
                    aria-label={t('apiTokens.deleteNamed', { name: token.name })}
                  >
                    {t('apiTokens.delete')}
                  </button>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-mist-500">
                  {token.blocked ? (
                    <span className="text-bad-500" data-testid="api-token-blocked">{t('apiTokens.blocked')}</span>
                  ) : (
                    <span className={end.soon ? 'rounded bg-warn-500/15 px-1.5 text-warn-500' : ''} data-testid="api-token-end">
                      {end.text}
                    </span>
                  )}
                  <span>{token.last_used_at ? t('mcp.used', { when: formatDate(token.last_used_at) }) : t('mcp.unused')}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {!shown && (
        <details className="mt-3 rounded-xl border border-ink-700 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-mist-300">{t('apiTokens.whatItDoes')}</summary>
          <p className="mt-2 text-xs text-mist-400">{t('apiTokens.whatItDoesText')}</p>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-mist-300">
            {ROUTES.map(([method, path]) => (
              <li key={method + path}>
                <span className="inline-block w-10 text-mist-500">{method}</span> {path}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!making ? (
        <button
          type="button"
          onClick={() => setMaking(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1.5 text-sm text-mist-200 hover:bg-ink-850"
        >
          <Symbol name="plus" /> {t('apiTokens.new')}
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
            {t('apiTokens.name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              autoFocus
              placeholder="n8n"
              className="mt-1 block h-9 w-full rounded-lg border border-ink-700 bg-ink-950 px-2 text-mist-100 outline-none focus:border-accent-500"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm text-mist-300">{t('apiTokens.levelTitle')}</legend>
            {LEVELS.map((option) => (
              <label key={option} className={'flex cursor-pointer gap-3 rounded-xl border p-3 ' + (level === option ? 'border-accent-500/60 bg-accent-500/10' : 'border-ink-700')}>
                <input type="radio" name="api-level" checked={level === option} onChange={() => setLevel(option)} className="mt-1" />
                <span>
                  <span className="block text-sm font-medium text-mist-100">{t(`apiTokens.level.${option}`)}</span>
                  <span className="block text-xs text-mist-500">{t(`apiTokens.levelText.${option}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm text-mist-300">{t('apiTokens.where')}</legend>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-mist-100">
              <input type="radio" name="api-spaces" checked={chosen === null} onChange={() => setChosen(null)} />
              {t('mcp.allSpaces')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-mist-100">
              <input type="radio" name="api-spaces" checked={chosen !== null} onChange={() => setChosen([])} />
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
                        setChosen((before) => (event.target.checked ? [...(before ?? []), space.id] : (before ?? []).filter((id) => id !== space.id)))
                      }
                    />
                    {space.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm text-mist-300">{t('apiTokens.lifetime')}</legend>
            <div className="flex flex-wrap gap-2">
              {LIFETIMES.map((option) => (
                <label key={String(option)} className={'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ' + (days === option ? 'border-accent-500/60 bg-accent-500/10 text-mist-100' : 'border-ink-700 text-mist-300')}>
                  <input type="radio" name="api-days" checked={days === option} onChange={() => setDays(option)} />
                  {option === null ? t('apiTokens.lifetimeNever') : t(`apiTokens.lifetimeDays.${option}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMaking(false)} className="rounded-full px-3 py-1 text-sm text-mist-400">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={!ready} className="rounded-full bg-accent-500 px-3 py-1 text-sm font-semibold text-on-accent disabled:opacity-50">
              {t('apiTokens.make')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
