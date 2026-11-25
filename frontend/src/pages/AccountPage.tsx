/**
 * The areas of "My account" in the settings: Profile (name, picture, mail address, the language, signing out),
 * Security (password, second factor, the link to the provider, signing out everywhere), Notifications, Plugins and
 * Connections (paired iPhones, API tokens, AI in notes, keys for AI from outside, the calendar feed). Which one shows
 * is chosen by the settings page (`SettingsPage.tsx`); the addresses of the tabs before lead there (`areas.ts`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, authApi, type MyProvider } from '../api/client'
import { Field, Problem } from '../components/AuthFrame'
import { AiAccess } from '../components/AiAccess'
import { AppDevices } from '../components/AppDevices'
import { ApiTokens } from '../components/ApiTokens'
import { Avatar } from '../components/Avatar'
import { MailAddress } from '../components/MailAddress'
import { McpKeys } from '../components/McpKeys'
import { NotifySettings } from '../components/NotifySettings'
import { CalendarFeed } from '../components/settings/CalendarFeed'
import { LanguageCard } from '../components/settings/LanguageCard'
import { SecondFactor } from '../components/SecondFactor'
import { MyPluginsCard } from '../plugins/PluginSettings'
import { Symbol, type SymbolName } from '../components/Symbol'
import { errorText } from '../lib/errors'
import { rememberName } from '../lib/people'
import { useAuth } from '../state/auth'
import { oidcErrorKey } from '../vendor/nexoidc/oidc'
import { MIN_PASSWORD } from './SetupPage'
import type { AccountSlug } from './settings/areas'

/** The areas of the own account this page draws; the others ("Appearance", "Notes", "Spaces") are cards of their own. */
export type AccountPart = Extract<AccountSlug, 'profile' | 'security' | 'notifications' | 'plugins' | 'connections'>

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function AccountArea({ part }: { part: AccountPart }) {
  const { t } = useTranslation()
  const { me, refresh } = useAuth()
  const [shownAs, setShownAs] = useState(me?.display_name ?? '')
  // The active sign-in providers and whether this account is linked to each: without one there is nothing to link.
  const [providers, setProviders] = useState<MyProvider[]>([])
  const loadProviders = () => authApi.myProviders().then(setProviders, () => setProviders([]))
  useEffect(() => {
    void loadProviders()
  }, [])
  const [params] = useSearchParams()
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
    <div className="space-y-6">
        <div aria-live="polite">
          <Problem text={problem} />
          {(done ?? (linkedShown && linkedLabel ? t('account.linked', { name: linkedLabel }) : null)) && (
            <p className="rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">
              {done ?? t('account.linked', { name: linkedLabel })}
            </p>
          )}
        </div>

        {part === 'profile' && (
          <Section symbol="users" title={t('settings.areas.profile.title')}>
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
        {part === 'profile' && <LanguageCard />}
        {part === 'profile' && <SignOutCard />}

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

        {part === 'connections' && (
          <>
            <AppDevices />
            <ApiTokens />
            <AiAccess />
            <McpKeys />
            <CalendarFeed />
          </>
        )}
        {part === 'notifications' && <NotifySettings />}
        {part === 'plugins' && <MyPluginsCard />}
    </div>
  )
}

/** Signing out of this browser: in the profile, where the account menu had it before. */
function SignOutCard() {
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  return (
    <Section symbol="logOut" title={t('account.signOut')}>
      <p className="mb-3 text-sm text-mist-400">{t('account.signOutText')}</p>
      <button
        type="button"
        data-testid="sign-out"
        onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}
        className="inline-flex items-center gap-2 rounded-full border border-ink-700 px-4 py-1.5 text-sm hover:bg-ink-850"
      >
        <Symbol name="logOut" /> {t('account.signOut')}
      </button>
    </Section>
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
