/**
 * A program asks to sign in for MCP (a connector, OAuth, block Y): the page it sends its user to. The account is signed
 * in already (else the login comes first and leads back here), chooses the level and the spaces, and agrees or turns
 * it down. The server answers with the address to go back to; nothing goes back to an address the program did not
 * register.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { ApiError, oauthApi, type ConsentInfo, type McpLevel } from '../api/client'
import { AuthFrame } from '../components/AuthFrame'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'

const LEVELS: McpLevel[] = ['read', 'draft', 'write']
const ASKED = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'response_type'] as const

export function ConnectPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params] = useSearchParams()
  const [info, setInfo] = useState<ConsentInfo | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [level, setLevel] = useState<McpLevel>('read')
  const [chosen, setChosen] = useState<number[] | null>(null)
  const [busy, setBusy] = useState(false)
  const query = Object.fromEntries(ASKED.map((name) => [name, params.get(name) ?? '']))

  useEffect(() => {
    let live = true
    void oauthApi.info(query).then(
      (found) => {
        if (!live) return
        setInfo(found)
        setLevel(found.max_level)
      },
      (error) => live && setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error')),
    )
    return () => {
      live = false
    }
    // The question stands in the address and does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const answer = async (approve: boolean) => {
    setBusy(true)
    setProblem(null)
    try {
      const { redirect } = await oauthApi.answer({
        client_id: query.client_id,
        redirect_uri: query.redirect_uri,
        code_challenge: query.code_challenge,
        code_challenge_method: query.code_challenge_method,
        state: params.get('state') ?? '',
        approve,
        level,
        spaces: chosen,
      })
      window.location.assign(redirect)
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      setBusy(false)
    }
  }

  if (problem && !info) {
    return (
      <AuthFrame title={t('connect.failed')}>
        <p role="alert" className="text-sm text-bad-500">
          {problem}
        </p>
      </AuthFrame>
    )
  }
  if (!info) return <p className="p-6 text-sm text-mist-500">{t('common.loading')}</p>
  const offered = LEVELS.slice(0, LEVELS.indexOf(info.max_level) + 1)
  return (
    <AuthFrame title={t('connect.title', { name: info.client_name })} text={t('connect.text', { account: me?.name ?? '', host: info.redirect_host })}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-mist-300">{t('mcp.what')}</legend>
        {offered.map((option) => (
          <label key={option} className={'flex cursor-pointer gap-3 rounded-xl border p-3 ' + (level === option ? 'border-accent-500/60 bg-accent-500/10' : 'border-ink-700')}>
            <input type="radio" name="connect-level" checked={level === option} onChange={() => setLevel(option)} className="mt-1" />
            <span>
              <span className="block text-sm font-medium text-mist-100">{t(`mcp.level.${option}`)}</span>
              <span className="block text-xs text-mist-500">{t(`mcp.levelText.${option}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="mt-4 space-y-2">
        <legend className="mb-1 text-sm text-mist-300">{t('mcp.where')}</legend>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-mist-100">
          <input type="radio" name="connect-spaces" checked={chosen === null} onChange={() => setChosen(null)} />
          {t('mcp.allSpaces')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-mist-100">
          <input type="radio" name="connect-spaces" checked={chosen !== null} onChange={() => setChosen([])} />
          {t('mcp.someSpaces')}
        </label>
        {chosen !== null && (
          <div className="ml-6 flex flex-wrap gap-2">
            {info.spaces.map((space) => (
              <label key={space.id} className={'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ' + (chosen.includes(space.id) ? 'border-accent-500/60 bg-accent-500/10 text-mist-100' : 'border-ink-700 text-mist-300')}>
                <input
                  type="checkbox"
                  checked={chosen.includes(space.id)}
                  onChange={(event) => setChosen((before) => (event.target.checked ? [...(before ?? []), space.id] : (before ?? []).filter((id) => id !== space.id)))}
                />
                {space.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <p className="mt-4 text-xs text-mist-500">{t('connect.after')}</p>
      <div aria-live="polite">{problem && <p className="mt-2 text-sm text-bad-500">{problem}</p>}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void answer(false)} className="rounded-full px-4 py-1.5 text-sm text-mist-300 hover:bg-ink-850 disabled:opacity-50">
          {t('connect.decline')}
        </button>
        <button
          type="button"
          disabled={busy || (chosen !== null && chosen.length === 0)}
          onClick={() => void answer(true)}
          className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
        >
          {t('connect.allow')}
        </button>
      </div>
    </AuthFrame>
  )
}
