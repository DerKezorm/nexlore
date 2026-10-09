/**
 * The own account, in tabs like the settings (design answer 29.09.2026): Profile (name, picture), Security (password,
 * second factor, the link to the provider, signing out everywhere), AI (AI in notes, keys for AI from outside) and
 * Plugins. The tab stands in the address (`?tab=`); the old anchors (`#ai`, `#mcp`, `#plugins`) still lead there.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useSearchParams } from 'react-router-dom'

import { ApiError, authApi, type MyProvider } from '../api/client'
import { Field, Problem } from '../components/AuthFrame'
import { AiAccess } from '../components/AiAccess'
import { ApiTokens } from '../components/ApiTokens'
import { Avatar } from '../components/Avatar'
import { MailAddress } from '../components/MailAddress'
import { McpKeys } from '../components/McpKeys'
import { NotifySettings } from '../components/NotifySettings'
import { CalendarFeed } from '../components/settings/CalendarFeed'
import { SecondFactor } from '../components/SecondFactor'
import { MyPluginsCard } from '../plugins/PluginSettings'
import { Symbol, type SymbolName } from '../components/Symbol'
import { TabRow, type Tab } from '../components/TabRow'
import { errorText } from '../lib/errors'
import { rememberName } from '../lib/people'
import { useAuth } from '../state/auth'
import { oidcErrorKey } from '../vendor/nexoidc/oidc'
import { MIN_PASSWORD } from './SetupPage'

type Part = 'profile' | 'security' | 'notify' | 'ai' | 'plugins'
const PARTS: Part[] = ['profile', 'security', 'notify', 'ai', 'plugins']
const ANCHORS: Record<string, Part> = { '#ai': 'ai', '#mcp': 'ai', '#api-tokens': 'ai', '#calendar': 'ai', '#plugins': 'plugins' }

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function AccountPage() {
  const { t } = useTranslation()
  const { me, refresh } = useAuth()
  const [shownAs, setShownAs] = useState(me?.display_name ?? '')
  // The active sign-in providers and whether this account is linked to each: without one there is nothing to link.
  const [providers, setProviders] = useState<MyProvider[]>([])
  const loadProviders = () => authApi.myProviders().then(setProviders, () => setProviders([]))
  useEffect(() => {
    void loadProviders()
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
  // The provider whose "Link" was pressed: its row asks for the password.
  const [linking, setLinking] = useState<string | null>(null)
  const linkedSlug = params.get('linked')
  // Back from linking: the provider by the name on its button, once the list is there (the address has its slug).
  const [linkedShown, setLinkedShown] = useState(!!linkedSlug)
  const linkedLabel = providers.find((entry) => entry.slug === linkedSlug)?.label
  const [done, setDone] = useState<string | null>(null)
  // Back from the provider with a refusal: only a known sign-in code becomes a sentence.
  const addressError = params.get('error')
  const [problem, setProblem] = useState<string | null>(
    addressError ? (oidcErrorKey(addressError) ? t(oidcErrorKey(addressError)!) : errorText(addressError)) : null,
  )
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  if (!me) return null

  const tabs: Tab<Part>[] = [
    { value: 'profile', label: t('account.tabs.profile'), symbol: 'users' },
    { value: 'security', label: t('account.tabs.security'), symbol: 'shield' },
    { value: 'notify', label: t('account.tabs.notify'), symbol: 'info' },
    { value: 'ai', label: t('account.tabs.ai'), symbol: 'plug' },
    { value: 'plugins', label: t('account.tabs.plugins'), symbol: 'plug' },
  ]

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    setLinkedShown(false)
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
          {(done ?? (linkedShown && linkedLabel ? t('account.linked', { name: linkedLabel }) : null)) && (
            <p className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">
              {done ?? t('account.linked', { name: linkedLabel })}
            </p>
          )}
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
            <div id="mail" className="mt-6">
              <MailAddress
                me={me}
                run={run}
                busy={busy}
                provider={providers.filter((entry) => entry.linked).map((entry) => entry.label).join(', ')}
              />
            </div>
            <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-mist-500">{t('account.profile.name')}</dt>
              <dd className="text-mist-100">{me.name}</dd>
              <dt className="text-mist-500">{t('account.profile.role')}</dt>
              <dd className="text-mist-100">{t(`account.role.${me.role}`)}</dd>
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

            {(providers.length > 0 || me.sign_in === 'oidc') && (
              <Section symbol="shield" title={t('oidc.account.title')}>
                <p className="mb-3 text-sm text-mist-400">{t('oidc.account.text')}</p>
                <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800" data-testid="my-providers">
                  {providers.map((provider) => {
                    const lastLink = me.sign_in === 'oidc' && provider.linked && providers.filter((entry) => entry.linked).length === 1
                    return (
                      <li key={provider.slug} className="px-3 py-2.5 text-sm">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="min-w-0 flex-1 truncate font-medium">{provider.label}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${provider.linked ? 'bg-ok-500/10 text-ok-500' : 'border border-ink-700 text-mist-400'}`}
                          >
                            {provider.linked ? t('oidc.account.linked') : t('oidc.account.notLinked')}
                          </span>
                          {provider.linked && !lastLink && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await authApi.unlink(provider.slug)
                                  await loadProviders()
                                }, t('account.unlinked', { name: provider.label }))
                              }
                              className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50"
                            >
                              {t('oidc.account.unlink')}
                            </button>
                          )}
                          {!provider.linked && me.sign_in === 'password' && linking !== provider.slug && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setLinking(provider.slug)
                                setLinkPassword('')
                              }}
                              className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50"
                            >
                              {t('oidc.account.link')}
                            </button>
                          )}
                        </div>
                        {lastLink && <p className="mt-1 text-xs text-mist-500">{t('oidc.account.only', { name: provider.label })}</p>}
                        {linking === provider.slug && (
                          <form
                            className="mt-3 flex flex-wrap items-end gap-2"
                            onSubmit={(event) => {
                              event.preventDefault()
                              setBusy(true)
                              setProblem(null)
                              authApi.linkStart(provider.slug, linkPassword).then(
                                ({ url }) => window.location.assign(url),
                                (error) => {
                                  setProblem(errorText(code(error)))
                                  setBusy(false)
                                },
                              )
                            }}
                          >
                            <div className="min-w-48 flex-1">
                              <Field label={t('auth.password')} value={linkPassword} onChange={setLinkPassword} type="password" autoComplete="current-password" autoFocus />
                            </div>
                            <button type="submit" disabled={busy} className="h-10 rounded-full bg-accent-500 px-4 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50">
                              {t('oidc.account.link')}
                            </button>
                          </form>
                        )}
                      </li>
                    )
                  })}
                </ul>
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
            <ApiTokens />
            <AiAccess />
            <McpKeys />
            <CalendarFeed />
          </>
        )}
        {part === 'notify' && <NotifySettings />}
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
