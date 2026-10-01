/**
 * The own account, in tabs like the settings (design answer 29.09.2026): Profile (name, picture), Security (password,
 * second factor, the link to the provider, signing out everywhere), AI (AI in notes, keys for AI from outside) and
 * Plugins. The tab stands in the address (`?tab=`); the old anchors (`#ai`, `#mcp`, `#plugins`) still lead there.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useSearchParams } from 'react-router-dom'

import { ApiError, authApi, type Methods } from '../api/client'
import { Field, Problem } from '../components/AuthFrame'
import { AiAccess } from '../components/AiAccess'
import { Avatar } from '../components/Avatar'
import { McpKeys } from '../components/McpKeys'
import { CalendarFeed } from '../components/settings/CalendarFeed'
import { SecondFactor } from '../components/SecondFactor'
import { MyPluginsCard } from '../plugins/PluginSettings'
import { Symbol, type SymbolName } from '../components/Symbol'
import { TabRow, type Tab } from '../components/TabRow'
import { errorText } from '../lib/errors'
import { rememberName } from '../lib/people'
import { useAuth } from '../state/auth'
import { MIN_PASSWORD } from './SetupPage'

type Part = 'profile' | 'security' | 'ai' | 'plugins'
const PARTS: Part[] = ['profile', 'security', 'ai', 'plugins']
const ANCHORS: Record<string, Part> = { '#ai': 'ai', '#mcp': 'ai', '#calendar': 'ai', '#plugins': 'plugins' }

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function AccountPage() {
  const { t } = useTranslation()
  const { me, refresh } = useAuth()
  const [shownAs, setShownAs] = useState(me?.display_name ?? '')
  // Whether a sign-in provider is set up at all: without one there is nothing to link (P7.14).
  const [methods, setMethods] = useState<Methods | null>(null)
  useEffect(() => {
    void authApi.methods().then(setMethods, () => setMethods(null))
  }, [])
  const [params, setParams] = useSearchParams()
  const { hash } = useLocation()
  const asked = params.get('tab') as Part | null
  // Back from the provider (linking the account): its answer stands on the security tab.
  const part: Part =
    asked && PARTS.includes(asked) ? asked : (ANCHORS[hash] ?? (params.get('linked') || params.get('error') ? 'security' : 'profile'))
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [linkPassword, setLinkPassword] = useState('')
  const [done, setDone] = useState<string | null>(params.get('linked') ? t('account.linked') : null)
  const [problem, setProblem] = useState<string | null>(params.get('error') ? errorText(params.get('error')!) : null)
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  if (!me) return null

  const tabs: Tab<Part>[] = [
    { value: 'profile', label: t('account.tabs.profile'), symbol: 'users' },
    { value: 'security', label: t('account.tabs.security'), symbol: 'shield' },
    { value: 'ai', label: t('account.tabs.ai'), symbol: 'plug' },
    { value: 'plugins', label: t('account.tabs.plugins'), symbol: 'plug' },
  ]

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
        </div>
        <TabRow
          tabs={tabs}
          active={part}
          onChange={(value) => {
            setDone(null)
            setProblem(null)
            setParams(value === 'profile' ? {} : { tab: value }, { replace: true })
          }}
          label={t('account.title')}
        />
        <div aria-live="polite">
          <Problem text={problem} />
          {done && <p className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">{done}</p>}
        </div>

        {part === 'profile' && (
          <Section symbol="users" title={t('account.tabs.profile')}>
            <div className="mb-5 flex flex-wrap items-center gap-4">
              <Avatar account={me} className="h-20 w-20 text-3xl" />
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => picker.current?.click()}
                    className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
                  >
                    {me.avatar ? t('account.profile.change') : t('account.profile.upload')}
                  </button>
                  {me.avatar && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => authApi.removeAvatar(), t('account.profile.removed'))}
                      className="rounded-full border border-ink-700 px-4 py-1.5 text-sm hover:bg-ink-850 disabled:opacity-50"
                    >
                      {t('account.profile.remove')}
                    </button>
                  )}
                </div>
                <p className="text-xs text-mist-500">{t('account.profile.hint')}</p>
              </div>
              <input
                ref={picker}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif,image/avif,.heic,.heif"
                aria-label={t('account.profile.upload')}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void run(() => authApi.setAvatar(file), t('account.profile.saved'))
                }}
              />
            </div>
            {/* How others see this account (X1); the name below stays what one signs in with and writes after @. */}
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void run(async () => {
                  const saved = await authApi.setProfile(shownAs)
                  setShownAs(saved.display_name)
                  rememberName(saved.name, saved.display_name)
                }, t('account.profile.displaySaved'))
              }}
            >
              <div className="min-w-0 flex-1">
                <Field
                  label={t('account.profile.displayName')}
                  value={shownAs}
                  onChange={setShownAs}
                  autoComplete="name"
                  hint={t('account.profile.displayHint', { name: me.name })}
                />
              </div>
              <button
                type="submit"
                disabled={busy || shownAs.trim() === (me.display_name ?? '')}
                className="h-10 rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-40"
              >
                {t('account.profile.displaySave')}
              </button>
            </form>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-mist-500">{t('account.profile.name')}</dt>
              <dd className="text-mist-100">{me.name}</dd>
              <dt className="text-mist-500">{t('account.profile.role')}</dt>
              <dd className="text-mist-100">{t(`account.role.${me.role}`)}</dd>
              {me.email && (
                <>
                  <dt className="text-mist-500">{t('account.profile.email')}</dt>
                  <dd className="text-mist-100">{me.email}</dd>
                </>
              )}
            </dl>
          </Section>
        )}

        {part === 'security' && (
          <>
            {me.sign_in === 'password' && (
              <Section symbol="key" title={t('account.password.title')}>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!current) return setProblem(errorText('current_password_missing'))
                    if (!next) return setProblem(errorText('password_missing'))
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

            {(methods?.oidc || me.sign_in === 'oidc' || me.oidc_linked) && (
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
            )}

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
          </>
        )}

        {part === 'ai' && (
          <>
            <AiAccess />
            <McpKeys />
            <CalendarFeed />
          </>
        )}
        {part === 'plugins' && <MyPluginsCard />}
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
