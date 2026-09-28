/**
 * The own account: password, second factor, the link to the provider, signing out everywhere, keys for AI from
 * outside (MCP).
 */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { ApiError, authApi } from '../api/client'
import { Field, Problem } from '../components/AuthFrame'
import { AiAccess } from '../components/AiAccess'
import { McpKeys } from '../components/McpKeys'
import { SecondFactor } from '../components/SecondFactor'
import { MyPluginsCard } from '../plugins/PluginSettings'
import { Symbol, type SymbolName } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'
import { MIN_PASSWORD } from './SetupPage'

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function AccountPage() {
  const { t } = useTranslation()
  const { me, refresh } = useAuth()
  const [params] = useSearchParams()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [linkPassword, setLinkPassword] = useState('')
  const [done, setDone] = useState<string | null>(params.get('linked') ? t('account.linked') : null)
  const [problem, setProblem] = useState<string | null>(params.get('error') ? errorText(params.get('error')!) : null)
  const [busy, setBusy] = useState(false)

  if (!me) return null

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      await action()
      setDone(success)
      await refresh()
    } catch (error) {
      setProblem(errorText(code(error)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('account.title')}</h1>
          <p className="mt-1 text-sm text-mist-500">
            {me.name} · {t(`account.role.${me.role}`)}
            {me.email ? ` · ${me.email}` : ''}
          </p>
        </div>
        <div aria-live="polite">
          <Problem text={problem} />
          {done && <p className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">{done}</p>}
        </div>

        {me.sign_in === 'password' && (
          <Section symbol="key" title={t('account.password.title')}>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (next !== again) return setProblem(t('auth.mismatch'))
                void run(async () => {
                  await authApi.changePassword(current, next)
                  setCurrent('')
                  setNext('')
                  setAgain('')
                }, t('account.password.done'))
              }}
            >
              <Field label={t('account.password.current')} value={current} onChange={setCurrent} type="password" autoComplete="current-password" />
              <Field
                label={t('account.password.new')}
                value={next}
                onChange={setNext}
                type="password"
                autoComplete="new-password"
                hint={t('auth.passwordHint', { count: MIN_PASSWORD })}
              />
              <Field label={t('auth.passwordAgain')} value={again} onChange={setAgain} type="password" autoComplete="new-password" />
              <button type="submit" disabled={busy} className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50">
                {t('account.password.submit')}
              </button>
            </form>
          </Section>
        )}

        <Section symbol="shield" title={t('twofactor.title')}>
          <SecondFactor me={me} />
        </Section>

        <Section symbol="shield" title={t('account.oidc.title')}>
          {me.sign_in === 'oidc' ? (
            <p className="text-sm text-mist-400">{t('account.oidc.only')}</p>
          ) : me.oidc_linked ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-mist-400">{t('account.oidc.linked')}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => authApi.unlink(), t('account.oidc.unlinked'))}
                className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850"
              >
                {t('account.oidc.unlink')}
              </button>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                setBusy(true)
                setProblem(null)
                authApi.linkStart(linkPassword).then(
                  ({ url }) => window.location.assign(url),
                  (error) => {
                    setProblem(errorText(code(error)))
                    setBusy(false)
                  },
                )
              }}
            >
              <p className="text-sm text-mist-400">{t('account.oidc.text')}</p>
              <Field label={t('auth.password')} value={linkPassword} onChange={setLinkPassword} type="password" autoComplete="current-password" />
              <button type="submit" disabled={busy} className="rounded-full border border-ink-700 px-4 py-1.5 text-sm hover:bg-ink-850 disabled:opacity-50">
                {t('account.oidc.link')}
              </button>
            </form>
          )}
        </Section>

        <Section symbol="lock" title={t('account.sessions.title')}>
          <p className="mb-3 text-sm text-mist-400">{t('account.sessions.text')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => authApi.logoutEverywhere(), t('account.sessions.done'))}
            className="rounded-full border border-ink-700 px-4 py-1.5 text-sm hover:bg-ink-850 disabled:opacity-50"
          >
            {t('account.sessions.submit')}
          </button>
        </Section>

        <AiAccess />
        <McpKeys />
        <MyPluginsCard />
      </div>
    </main>
  )
}

function Section({ symbol, title, children }: { symbol: SymbolName; title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
      <h2 className="mb-4 flex items-center gap-2 font-semibold">
        <Symbol name={symbol} className="h-4 w-4 text-accent-400" /> {title}
      </h2>
      {children}
    </section>
  )
}
