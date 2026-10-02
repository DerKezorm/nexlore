/**
 * The operator's part of the settings: accounts and invitations, every space (rights only, never contents),
 * sign-in and the provider, public pages, mail, files, backups, languages.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import {
  adminApi,
  apiTokensApi,
  authApi,
  mcpApi,
  type AdminAccount,
  type AdminSpace,
  type AnyApiToken,
  type AuthentikResult,
  type Backup,
  type BackupCheck,
  type FileSettings,
  type Invite,
  type McpTools,
  type NewInvite,
  type OidcConfig,
  type ServerSettings,
  type ShareInfo,
  shareApi,
} from '../../api/client'
import { resetAddedLanguages, languageOptions, type LanguageOption } from '../../i18n'
import { formatDate, formatDay } from '../../lib/markdown'
import { useAuth } from '../../state/auth'
import { useStore } from '../../state/store'
import { noteUrl } from '../../lib/vault'
import { ConfirmDialog } from '../ConfirmDialog'
import { MembersDialog } from '../MembersDialog'
import { Button, Card, CopyLink, Feedback, Input, Select, Toggle } from './ui'
import { useAction } from './useAction'

const DAYS = ['1', '7', '30'] as const

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// --- Accounts and invitations ---------------------------------------------------------------------------------------

export function AccountsCard() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [days, setDays] = useState<(typeof DAYS)[number]>('7')
  const [email, setEmail] = useState('')
  const [send, setSend] = useState(false)
  const [made, setMade] = useState<NewInvite | null>(null)
  const [password, setPassword] = useState<{ id: number; value: string } | null>(null)
  const [removing, setRemoving] = useState<AdminAccount | null>(null)
  const [resetting, setResetting] = useState<AdminAccount | null>(null)
  const [promoting, setPromoting] = useState<AdminAccount | null>(null)
  // Acting on another account asks for the operator's own password once more; one signing in through the provider
  // has none here and is not asked.
  const [own, setOwn] = useState('')
  const asks = me?.sign_in === 'password'
  const ownField = asks && (
    <Input label={t('admin.accounts.yourPassword')} value={own} onChange={setOwn} type="password" autoComplete="current-password" className="mt-3" />
  )
  const { busy, problem, done, run } = useAction()

  const load = useCallback(async () => {
    setAccounts(await adminApi.accounts())
    setInvites(await authApi.invites())
  }, [])
  const ask = (open: () => void) => {
    setOwn('')
    open()
  }

  useEffect(() => {
    void run(load)
  }, [run, load])

  return (
    <Card id="accounts" symbol="users" title={t('admin.accounts.title')} text={t('admin.accounts.text')}>
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
        {accounts.map((account) => (
          <li key={account.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                {account.display_name || account.name}
                {account.display_name && <span className="ml-1 text-xs font-normal text-mist-500">@{account.name}</span>}
              </span>
              <span className="ml-2 text-xs text-mist-500">
                {t(`account.role.${account.role}`)} · {t(`admin.accounts.signIn.${account.sign_in}`)} ·{' '}
                {account.last_seen_at ? formatDate(account.last_seen_at) : t('admin.accounts.never')}
                {account.two_factor && ` · ${t('admin.accounts.twoFactor')}`}
                {account.locked && ` · ${t('admin.accounts.locked')}`}
              </span>
            </span>
            {account.id !== me?.id && (
              <span className="flex flex-wrap gap-1.5">
                <Button small onClick={() => ask(() => setPromoting(account))}>
                  {account.role === 'operator' ? t('admin.accounts.makeMember') : t('admin.accounts.makeOperator')}
                </Button>
                <Button small onClick={() => ask(() => setPassword({ id: account.id, value: '' }))}>
                  {t('admin.accounts.newPassword')}
                </Button>
                <Button small busy={busy} onClick={() => void run(() => adminApi.signOutAccount(account.id), t('admin.accounts.signedOut'))}>
                  {t('admin.accounts.signOut')}
                </Button>
                {account.two_factor && (
                  <Button small onClick={() => ask(() => setResetting(account))}>
                    {t('admin.accounts.resetFactor')}
                  </Button>
                )}
                <Button small danger onClick={() => ask(() => setRemoving(account))}>
                  {t('admin.accounts.delete')}
                </Button>
              </span>
            )}
            {password?.id === account.id && (
              <form
                className="flex w-full flex-wrap items-end gap-2 pt-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(async () => {
                    await adminApi.setPassword(account.id, password.value, own)
                    setPassword(null)
                    setOwn('')
                  }, t('admin.accounts.passwordSet'))
                }}
              >
                <Input label={t('admin.accounts.newPassword')} value={password.value} onChange={(value) => setPassword({ id: account.id, value })} type="password" autoComplete="new-password" className="flex-1" />
                {asks && (
                  <Input label={t('admin.accounts.yourPassword')} value={own} onChange={setOwn} type="password" autoComplete="current-password" className="flex-1" />
                )}
                <Button type="submit" primary busy={busy}>
                  {t('common.save')}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <h3 className="mt-5 text-sm font-semibold">{t('admin.accounts.inviteTitle')}</h3>
      <p className="text-xs text-mist-500">{t('admin.accounts.inviteText')}</p>
      <form
        className="mt-2 grid gap-2 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            setMade(await authApi.invite(Number(days), email.trim(), send))
            await load()
          })
        }}
      >
        <Select
          label={t('members.invite.valid')}
          value={days}
          options={DAYS.map((value) => ({ value, label: t('members.invite.days', { count: Number(value) }) }))}
          onChange={setDays}
        />
        <Input label={t('members.invite.email')} value={email} onChange={setEmail} type="email" className="sm:col-span-2" hint={me?.mail ? undefined : t('members.invite.noMail')} />
        {me?.mail && (
          <label className="flex items-center gap-2 text-xs text-mist-400 sm:col-span-3">
            <input type="checkbox" checked={send} onChange={(event) => setSend(event.target.checked)} className="accent-accent-500" />
            {t('members.invite.send')}
          </label>
        )}
        <div className="sm:col-span-3">
          <Button type="submit" primary busy={busy}>
            {t('members.invite.create')}
          </Button>
        </div>
      </form>
      {made && (
        <div className="mt-3 space-y-1">
          <CopyLink link={made.link} label={t('members.invite.copy')} />
          <p className="text-xs text-mist-500">{made.sent ? t('members.invite.sent', { email: made.email }) : t('members.invite.once')}</p>
        </div>
      )}
      {invites.length > 0 && (
        <ul className="mt-3 divide-y divide-ink-700 rounded-xl border border-ink-700 text-xs">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1">
                {invite.email || t('admin.accounts.noEmail')} · {t('members.invite.until', { when: formatDay(invite.expires_at) })}
              </span>
              <Button small danger busy={busy} onClick={() => void run(async () => {
                await authApi.withdrawInvite(invite.id)
                await load()
              })}>
                {t('members.invite.withdraw')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Feedback problem={problem} done={done} />
      <ConfirmDialog
        open={removing !== null}
        title={t('admin.accounts.deleteTitle', { name: removing?.name ?? '' })}
        confirm={t('admin.accounts.delete')}
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void run(async () => {
          await adminApi.deleteAccount(removing!.id, own)
          setRemoving(null)
          await load()
        })}
      >
        {t('admin.accounts.deleteText')}
        {ownField}
      </ConfirmDialog>
      <ConfirmDialog
        open={resetting !== null}
        title={t('admin.accounts.resetTitle', { name: resetting?.name ?? '' })}
        confirm={t('admin.accounts.resetFactor')}
        danger
        busy={busy}
        onCancel={() => setResetting(null)}
        onConfirm={() => void run(async () => {
          await adminApi.resetSecondFactor(resetting!.id, own)
          setResetting(null)
          await load()
        }, t('admin.accounts.resetDone'))}
      >
        {t('admin.accounts.resetText')}
        {ownField}
      </ConfirmDialog>
      <ConfirmDialog
        open={promoting !== null}
        title={t(promoting?.role === 'operator' ? 'admin.accounts.memberTitle' : 'admin.accounts.operatorTitle', { name: promoting?.name ?? '' })}
        confirm={promoting?.role === 'operator' ? t('admin.accounts.makeMember') : t('admin.accounts.makeOperator')}
        busy={busy}
        onCancel={() => setPromoting(null)}
        onConfirm={() => void run(async () => {
          await adminApi.setRole(promoting!.id, promoting!.role === 'operator' ? 'member' : 'operator', own)
          setPromoting(null)
          await load()
        })}
      >
        {t(promoting?.role === 'operator' ? 'admin.accounts.memberText' : 'admin.accounts.operatorText')}
        {ownField}
      </ConfirmDialog>
    </Card>
  )
}

// --- Every space ----------------------------------------------------------------------------------------------------

export function AllSpacesCard() {
  const { t } = useTranslation()
  const [spaces, setSpaces] = useState<AdminSpace[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const { problem, run } = useAction()

  const load = useCallback(async () => setSpaces(await adminApi.spaces()), [])
  useEffect(() => {
    void run(load)
  }, [run, load])

  return (
    <Card id="all-spaces" symbol="space" title={t('admin.spaces.title')} text={t('admin.spaces.text')}>
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700">
        {spaces.map((space) => (
          <li key={space.name} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="font-medium">{space.name}</span>
            <span className="text-xs text-mist-500">
              {space.members === 0
                ? t('admin.spaces.yours')
                : t('admin.spaces.members', { count: space.members, managers: space.managers.join(', ') || '–' })}
            </span>
            <span className="ml-auto">
              <Button small onClick={() => setOpen(space.name)}>
                {t('admin.spaces.rights')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <Feedback problem={problem} />
      {open && (
        <MembersDialog
          space={open}
          onClose={() => {
            setOpen(null)
            void run(load)
          }}
        />
      )}
    </Card>
  )
}

// --- Sign-in and the provider ---------------------------------------------------------------------------------------

export function SignInCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const [address, setAddress] = useState(settings.public_url)
  const [oidc, setOidc] = useState<OidcConfig | null>(null)
  const [form, setForm] = useState({ issuer: '', client_id: '', client_secret: '', provider_name: '', auto_create: false })
  const [authentik, setAuthentik] = useState({ url: '', token: '' })
  const [steps, setSteps] = useState<AuthentikResult | null>(null)
  const { busy, problem, done, run } = useAction()

  const loadOidc = useCallback(async () => {
    const config = await adminApi.oidc()
    setOidc(config)
    setForm({ issuer: config.issuer, client_id: config.client_id, client_secret: '', provider_name: config.provider_name, auto_create: config.auto_create })
  }, [])
  useEffect(() => {
    void run(loadOidc)
  }, [run, loadOidc])

  // The switch moves at once; the server's answer confirms it, a refusal puts it back.
  const save = (change: Partial<ServerSettings>) => {
    onChange({ ...settings, ...change })
    void run(async () => onChange(await adminApi.saveSettings(change)), t('common.saved')).then((ok) => ok || onChange(settings))
  }

  return (
    <Card id="sign-in" symbol="shield" title={t('admin.signIn.title')} text={t('admin.signIn.text')}>
      <div className="space-y-3">
        <Toggle label={t('admin.signIn.password')} hint={t('admin.signIn.passwordHint')} checked={settings.password_login} onChange={(value) => save({ password_login: value })} />
        <Toggle
          label={t('admin.signIn.twoFactor')}
          hint={t('admin.signIn.twoFactorHint')}
          checked={settings.two_factor_required}
          onChange={(value) => save({ two_factor_required: value })}
        />
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            save({ public_url: address })
          }}
        >
          <Input label={t('admin.signIn.address')} value={address} onChange={setAddress} placeholder="https://notes.example.com" hint={t('admin.signIn.addressHint')} className="min-w-60 flex-1" />
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold">{t('admin.oidc.title')}</h3>
      <p className="text-xs text-mist-500">
        {oidc?.configured ? t('admin.oidc.on', { issuer: oidc.issuer }) : t('admin.oidc.off')} · {t('admin.oidc.redirect')}{' '}
        <code className="font-mono">{oidc?.redirect_uri}</code>
      </p>
      <form
        className="mt-3 grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            setOidc(await adminApi.saveOidc(form))
            setForm((current) => ({ ...current, client_secret: '' }))
          }, t('common.saved'))
        }}
      >
        <Input label={t('admin.oidc.issuer')} value={form.issuer} onChange={(issuer) => setForm({ ...form, issuer })} placeholder="https://auth.example.com/application/o/nexlore/" className="sm:col-span-2" />
        <Input label={t('admin.oidc.clientId')} value={form.client_id} onChange={(client_id) => setForm({ ...form, client_id })} />
        <Input
          label={t('admin.oidc.secret')}
          value={form.client_secret}
          onChange={(client_secret) => setForm({ ...form, client_secret })}
          type="password"
          placeholder={oidc?.configured ? t('admin.oidc.secretKept') : ''}
        />
        <Input label={t('admin.oidc.name')} value={form.provider_name} onChange={(provider_name) => setForm({ ...form, provider_name })} placeholder="authentik" />
        <div className="sm:col-span-2">
          <Toggle label={t('admin.oidc.autoCreate')} hint={t('admin.oidc.autoCreateHint')} checked={form.auto_create} onChange={(auto_create) => setForm({ ...form, auto_create })} />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
          {oidc?.configured && (
            <Button danger busy={busy} onClick={() => void run(async () => {
              await adminApi.removeOidc()
              await loadOidc()
            })}>
              {t('admin.oidc.remove')}
            </Button>
          )}
        </div>
      </form>

      <h3 className="mt-6 text-sm font-semibold">{t('admin.authentik.title')}</h3>
      <p className="text-xs text-mist-500">{t('admin.authentik.text')}</p>
      <form
        className="mt-3 grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            setSteps(await adminApi.authentik(authentik.url, authentik.token))
            setAuthentik({ ...authentik, token: '' })
            await loadOidc()
          })
        }}
      >
        <Input label={t('admin.authentik.url')} value={authentik.url} onChange={(url) => setAuthentik({ ...authentik, url })} placeholder="https://auth.example.com" />
        <Input label={t('admin.authentik.token')} value={authentik.token} onChange={(token) => setAuthentik({ ...authentik, token })} type="password" />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" busy={busy}>
            {t('admin.authentik.run')}
          </Button>
          <a href="/api/oidc/authentik/blueprint" className="inline-flex items-center rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
            {t('admin.authentik.blueprint')}
          </a>
        </div>
      </form>
      {steps && (
        <ol className="mt-3 space-y-1 text-xs">
          {steps.steps.map((step) => (
            <li key={step.key} className={step.ok ? 'text-ok-500' : 'text-bad-500'}>
              {step.ok ? '✓' : '✗'} {step.detail}
            </li>
          ))}
        </ol>
      )}
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

// --- AI from outside (MCP, M7) ----------------------------------------------------------------------------------------

export function McpCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { problem, run } = useAction()
  const save = (change: Partial<ServerSettings>) => {
    onChange({ ...settings, ...change })
    void run(async () => onChange(await adminApi.saveSettings(change))).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="mcp" symbol="key" title={t('admin.mcp.title')} text={t('admin.mcp.text')}>
      <Toggle label={t('admin.mcp.allow')} hint={t('admin.mcp.allowHint')} checked={settings.mcp_allowed} onChange={(value) => save({ mcp_allowed: value })} />
      <Select
        label={t('admin.mcp.maxLevel')}
        value={settings.mcp_max_level}
        options={(['read', 'draft', 'write'] as const).map((value) => ({ value, label: t(`mcp.level.${value}`) }))}
        onChange={(value) => save({ mcp_max_level: value })}
        className="mt-3"
      />
      <div className="mt-3">
        <Toggle label={t('admin.mcp.oauth')} hint={t('admin.mcp.oauthHint')} checked={settings.mcp_oauth_allowed} onChange={(value) => save({ mcp_oauth_allowed: value })} />
      </div>
      <BlockedTools />
      {/* Where it goes on: the keys belong to the accounts, not to this card. */}
      <p className="mt-3 text-sm text-mist-400" data-testid="mcp-where-keys">
        {settings.mcp_allowed ? t('admin.mcp.keysWhere') : t('admin.mcp.keysLater')}{' '}
        <Link to="/account#mcp" className="text-accent-400 hover:underline">
          {t('admin.mcp.keysLink')}
        </Link>
      </p>
      <Feedback problem={problem} />
    </Card>
  )
}

/** Tools no account may use, whatever its keys say (block Y, design answer Y2). Saved at once. */
function BlockedTools() {
  const { t, i18n } = useTranslation()
  const [catalog, setCatalog] = useState<McpTools | null>(null)
  const { problem, run } = useAction()
  useEffect(() => {
    void mcpApi.tools().then(setCatalog, () => setCatalog(null))
  }, [])
  if (!catalog) return null
  const blocked = new Set(catalog.blocked)
  const flip = (name: string, on: boolean) => {
    const next = on ? [...blocked, name] : [...blocked].filter((other) => other !== name)
    const before = catalog
    setCatalog({ ...catalog, blocked: next })
    void run(async () => setCatalog(await mcpApi.setBlocked(next))).then((ok) => ok || setCatalog(before))
  }
  const what = (name: string, fallback: string) => (i18n.exists(`mcp.tools.${name}`) ? t(`mcp.tools.${name}`) : fallback)
  return (
    <details className="mt-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm" data-testid="mcp-blocked">
      <summary className="cursor-pointer font-medium">
        {t('admin.mcp.blocked')} <span className="ml-1 text-xs text-mist-500">{t('admin.mcp.blockedCount', { count: blocked.size })}</span>
      </summary>
      <p className="mt-1 text-xs text-mist-500">{t('admin.mcp.blockedHint')}</p>
      {(['read', 'draft', 'change', 'risky'] as const).map((group) => (
        <fieldset key={group} className="mt-3">
          <legend className="text-xs font-medium tracking-wide text-mist-400 uppercase">{t(`mcp.rights.group.${group}`)}</legend>
          {catalog.tools
            .filter((tool) => tool.group === group)
            .map((tool) => (
              <label key={tool.name} className="flex items-start gap-2 border-t border-ink-700 py-1.5">
                <input type="checkbox" checked={blocked.has(tool.name)} onChange={(event) => flip(tool.name, event.target.checked)} aria-label={tool.name} className="mt-0.5" />
                <span>
                  <code className="font-mono text-xs text-mist-100">{tool.name}</code>
                  <span className="block text-xs text-mist-500">{what(tool.name, tool.description)}</span>
                </span>
              </label>
            ))}
        </fieldset>
      ))}
      <Feedback problem={problem} />
    </details>
  )
}

// --- API tokens for programs (n8n, nexdeck) ------------------------------------------------------------------------

/** The switch for API tokens, and every token there is: who made it, its level, when it was used; blocked for good
 * on request (design answer: every way out needs a latch). Never the token itself. */
export function ApiTokensCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { busy, problem, run } = useAction()
  const [tokens, setTokens] = useState<AnyApiToken[] | null>(null)
  const [blocking, setBlocking] = useState<AnyApiToken | null>(null)
  const load = useCallback(() => apiTokensApi.every().then(setTokens, () => setTokens(null)), [])
  useEffect(() => {
    void load()
  }, [load])
  const save = (change: Partial<ServerSettings>) => {
    onChange({ ...settings, ...change })
    void run(async () => onChange(await adminApi.saveSettings(change))).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="api-tokens" symbol="key" title={t('admin.apiTokens.title')} text={t('admin.apiTokens.text')}>
      <Toggle
        label={t('admin.apiTokens.allow')}
        hint={t('admin.apiTokens.allowHint')}
        checked={settings.api_tokens_allowed}
        onChange={(value) => save({ api_tokens_allowed: value })}
      />
      {tokens && tokens.length > 0 && (
        <div className="nn-scroll mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="admin-api-tokens">
            <thead className="text-xs text-mist-500">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{t('admin.apiTokens.account')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('admin.apiTokens.token')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('admin.apiTokens.level')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('admin.apiTokens.spaces')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('admin.apiTokens.used')}</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id} className="border-t border-ink-700">
                  <td className="py-1.5 pr-3">{token.account}</td>
                  <td className="py-1.5 pr-3">
                    {token.name} <code className="font-mono text-xs text-mist-500">{token.prefix}…</code>
                  </td>
                  <td className="py-1.5 pr-3">{t(`apiTokens.level.${token.level}`)}</td>
                  <td className="py-1.5 pr-3">
                    {token.spaces === null ? t('admin.apiTokens.allSpaces') : t('admin.apiTokens.someSpaces', { count: token.spaces })}
                  </td>
                  <td className="py-1.5 pr-3 text-mist-400">{token.last_used_at ? formatDate(token.last_used_at) : t('mcp.unused')}</td>
                  <td className="py-1.5 text-right">
                    {token.blocked ? (
                      <span className="text-xs text-bad-500">{t('admin.apiTokens.blocked')}</span>
                    ) : (
                      <Button small danger onClick={() => setBlocking(token)} label={t('admin.apiTokens.blockNamed', { name: token.name, account: token.account })}>
                        {t('admin.apiTokens.block')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-mist-500">{t('admin.apiTokens.offHint')}</p>
      <Feedback problem={problem} />
      <ConfirmDialog
        open={blocking !== null}
        title={t('admin.apiTokens.blockTitle', { name: blocking?.name ?? '', account: blocking?.account ?? '' })}
        confirm={t('admin.apiTokens.block')}
        danger
        busy={busy}
        onCancel={() => setBlocking(null)}
        onConfirm={() =>
          void run(async () => {
            await apiTokensApi.block(blocking!.id)
            setBlocking(null)
            await load()
          })
        }
      >
        {t('admin.apiTokens.blockText')}
      </ConfirmDialog>
    </Card>
  )
}

// --- The guide (the space "nexlore") ------------------------------------------------------------------------------------

/** The guide's start note in each language (`backend/app/guide`). */
const GUIDE_START: Record<string, string> = { de: '00 Willkommen.md', en: '00 Welcome.md' }

export function GuideCard() {
  const { t, i18n } = useTranslation()
  const { reload } = useStore()
  const [language, setLanguage] = useState(i18n.language.startsWith('de') ? 'de' : 'en')
  const [made, setMade] = useState<{ space: string; language: string } | null>(null)
  const { busy, problem, run } = useAction()
  return (
    <Card id="guide" symbol="book" title={t('admin.guide.title')} text={t('admin.guide.text')}>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('admin.guide.language')}
          value={language}
          options={[{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }]}
          onChange={setLanguage}
        />
        <Button
          primary
          busy={busy}
          onClick={() =>
            void run(async () => {
              const answer = await adminApi.makeGuide(language)
              setMade({ space: answer.space, language })
              await reload()
            })
          }
        >
          {t('admin.guide.make')}
        </Button>
      </div>
      {made && (
        <p role="status" className="mt-3 text-sm text-accent-400">
          {t('admin.guide.made', { space: made.space })}{' '}
          <Link to={noteUrl(`${made.space}/${GUIDE_START[made.language]}`)} className="underline">
            {t('admin.guide.open')}
          </Link>
        </p>
      )}
      <Feedback problem={problem} />
    </Card>
  )
}

// --- AI in notes, with each account's own service ---------------------------------------------------------------------

export function AiCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, ai_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ ai_allowed: value }))
      // The editor reads it from the own account.
      await refresh()
    }).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="ai" symbol="sparkle" title={t('admin.ai.title')} text={t('admin.ai.text')}>
      <Toggle label={t('admin.ai.allow')} hint={t('admin.ai.allowHint')} checked={settings.ai_allowed} onChange={save} />
      <p className="mt-3 text-sm text-mist-400" data-testid="ai-where-access">
        {t('admin.ai.where')}{' '}
        <Link to="/account#ai" className="text-accent-400 hover:underline">
          {t('admin.ai.whereLink')}
        </Link>
      </p>
      <Feedback problem={problem} />
    </Card>
  )
}

// --- Own CSS of the accounts --------------------------------------------------------------------------------------

export function CssCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, custom_css_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ custom_css_allowed: value }))
      await refresh()
    }).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="css" symbol="code" title={t('admin.css.title')} text={t('admin.css.text')}>
      <Toggle label={t('admin.css.allow')} hint={t('admin.css.allowHint')} checked={settings.custom_css_allowed} onChange={save} />
      <Feedback problem={problem} />
    </Card>
  )
}

// --- Public pages ---------------------------------------------------------------------------------------------------

export function SharesCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [shares, setShares] = useState<ShareInfo[]>([])
  const { busy, problem, run } = useAction()
  const load = useCallback(async () => setShares(await adminApi.shares()), [])
  useEffect(() => {
    void run(load)
  }, [run, load])

  return (
    <Card id="shares" symbol="globe" title={t('admin.shares.title')} text={t('admin.shares.text')}>
      <Toggle
        label={t('admin.shares.allow')}
        hint={t('admin.shares.allowHint')}
        checked={settings.shares_allowed}
        onChange={(value) => {
          onChange({ ...settings, shares_allowed: value })
          void run(async () => {
            onChange(await adminApi.saveSettings({ shares_allowed: value }))
            // The share buttons read it from the own account.
            await refresh()
          }).then((ok) => ok || onChange(settings))
        }}
      />
      <ul className="mt-3 divide-y divide-ink-700 rounded-xl border border-ink-700 text-sm">
        {shares.map((share) => (
          <li key={share.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{share.path}</span>
              <span className="ml-2 text-xs text-mist-500">
                {share.by ?? '–'}
                {share.expires_at ? ` · ${t('members.invite.until', { when: formatDay(share.expires_at) })}` : ''}
                {share.password ? ` · ${t('share.withPassword')}` : ''}
              </span>
            </span>
            <a href={share.link} target="_blank" rel="noreferrer" className="text-xs text-accent-400 hover:underline">
              {t('share.open')}
            </a>
            <Button small danger busy={busy} onClick={() => void run(async () => {
              await shareApi.withdraw(share.id)
              await load()
            })}>
              {t('share.withdraw')}
            </Button>
          </li>
        ))}
        {shares.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('admin.shares.none')}</li>}
      </ul>
      <Feedback problem={problem} />
    </Card>
  )
}

// --- Mail -----------------------------------------------------------------------------------------------------------

export function MailCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [form, setForm] = useState({
    smtp_host: settings.smtp_host,
    smtp_port: String(settings.smtp_port),
    smtp_security: settings.smtp_security,
    smtp_user: settings.smtp_user,
    smtp_password: '',
    smtp_from: settings.smtp_from,
  })
  const [to, setTo] = useState('')
  const { busy, problem, done, run } = useAction()

  return (
    <Card id="mail" symbol="link" title={t('admin.mail.title')} text={t('admin.mail.text')}>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          const { smtp_password, smtp_port, ...rest } = form
          void run(async () => {
            onChange(await adminApi.saveSettings({ ...rest, smtp_port: Number(smtp_port) || 587, ...(smtp_password ? { smtp_password } : {}) }))
            setForm((current) => ({ ...current, smtp_password: '' }))
            await refresh()
          }, t('common.saved'))
        }}
      >
        <Input label={t('admin.mail.host')} value={form.smtp_host} onChange={(smtp_host) => setForm({ ...form, smtp_host })} placeholder="mail.example.com" />
        <div className="grid grid-cols-2 gap-2">
          <Input label={t('admin.mail.port')} value={form.smtp_port} onChange={(smtp_port) => setForm({ ...form, smtp_port })} type="number" />
          <Select
            label={t('admin.mail.security')}
            value={form.smtp_security}
            options={[
              { value: 'starttls', label: 'STARTTLS' },
              { value: 'tls', label: 'TLS' },
              { value: 'none', label: t('admin.mail.none') },
            ]}
            onChange={(smtp_security) => setForm({ ...form, smtp_security })}
          />
        </div>
        <Input label={t('admin.mail.user')} value={form.smtp_user} onChange={(smtp_user) => setForm({ ...form, smtp_user })} />
        <Input
          label={t('admin.mail.password')}
          value={form.smtp_password}
          onChange={(smtp_password) => setForm({ ...form, smtp_password })}
          type="password"
          placeholder={settings.smtp_password_set ? t('admin.oidc.secretKept') : ''}
        />
        <Input label={t('admin.mail.from')} value={form.smtp_from} onChange={(smtp_from) => setForm({ ...form, smtp_from })} placeholder="notes@example.com" className="sm:col-span-2" />
        <div className="sm:col-span-2">
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => adminApi.mailTest(to.trim()), t('admin.mail.testSent'))
        }}
      >
        <Input label={t('admin.mail.testTo')} value={to} onChange={setTo} type="email" className="min-w-60 flex-1" />
        <Button type="submit" busy={busy}>
          {t('admin.mail.test')}
        </Button>
      </form>
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

// --- Files ----------------------------------------------------------------------------------------------------------

export function FilesSettingsCard() {
  const { t } = useTranslation()
  const [values, setValues] = useState<FileSettings | null>(null)
  const { busy, problem, done, run } = useAction()
  useEffect(() => {
    void run(async () => setValues(await adminApi.fileSettings()))
  }, [run])
  if (!values) return null
  return (
    <Card id="files" symbol="clip" title={t('admin.files.title')} text={t('admin.files.text')}>
      <form
        className="grid gap-2 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => setValues(await adminApi.saveFileSettings(values)), t('common.saved'))
        }}
      >
        <Input label={t('admin.files.folder')} value={values.attachment_folder} onChange={(attachment_folder) => setValues({ ...values, attachment_folder })} />
        <Input label={t('admin.files.perFile')} value={String(values.upload_max_mb)} onChange={(value) => setValues({ ...values, upload_max_mb: Number(value) || 1 })} type="number" />
        <Input label={t('admin.files.quota')} value={String(values.quota_mb)} onChange={(value) => setValues({ ...values, quota_mb: Number(value) || 0 })} type="number" hint={t('admin.files.quotaHint')} />
        <div className="sm:col-span-3">
          <Toggle label={t('admin.files.strip')} hint={t('admin.files.stripHint')} checked={values.strip_location} onChange={(strip_location) => setValues({ ...values, strip_location })} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

// --- Backups --------------------------------------------------------------------------------------------------------

export function BackupsCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const [backups, setBackups] = useState<Backup[]>([])
  const [checked, setChecked] = useState<BackupCheck | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  // Restoring restarts the server and ends every session: the page waits for it and goes to the sign-in (P7.5).
  const [restarting, setRestarting] = useState(false)
  useEffect(() => {
    if (!restarting) return
    let away = false
    const started = Date.now()
    const timer = window.setInterval(() => {
      void fetch('/api/setup', { cache: 'no-store' }).then(
        (answer) => {
          if (answer.ok && (away || Date.now() - started > 90_000)) window.location.assign('/login')
          if (!answer.ok) away = true
        },
        () => {
          away = true
        },
      )
    }, 1500)
    return () => window.clearInterval(timer)
  }, [restarting])
  // The archive holds everything, so it is handed out only against the password once more.
  const [fetching, setFetching] = useState<{ name: string; password: string } | null>(null)
  const [note, setNote] = useState('')
  const { me } = useAuth()
  const { busy, problem, done, run } = useAction()
  const load = useCallback(async () => setBackups(await adminApi.backups()), [])
  const download = (name: string, password: string) =>
    void run(async () => {
      const archive = await adminApi.downloadBackup(name, password)
      const url = URL.createObjectURL(archive)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setFetching(null)
    }, t('admin.backups.downloaded'))
  useEffect(() => {
    void run(load)
  }, [run, load])

  return (
    <Card id="backups" symbol="history" title={t('admin.backups.title')} text={t('admin.backups.text')}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          label={t('admin.backups.schedule')}
          value={settings.backup_schedule}
          options={(['off', 'daily', 'weekly'] as const).map((value) => ({ value, label: t(`admin.backups.every.${value}`) }))}
          onChange={(backup_schedule) => void run(async () => onChange(await adminApi.saveSettings({ backup_schedule })))}
        />
        <Select
          label={t('admin.backups.keep')}
          value={String(settings.backup_keep)}
          options={['3', '7', '14', '30'].map((value) => ({ value, label: value }))}
          onChange={(value) => void run(async () => onChange(await adminApi.saveSettings({ backup_keep: Number(value) })))}
        />
      </div>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await adminApi.makeBackup(note.trim())
            setNote('')
            await load()
          }, t('admin.backups.made'))
        }}
      >
        <Input label={t('admin.backups.note')} value={note} onChange={setNote} className="min-w-60 flex-1" />
        <Button type="submit" primary busy={busy}>
          {t('admin.backups.make')}
        </Button>
      </form>
      <ul className="mt-3 divide-y divide-ink-700 rounded-xl border border-ink-700 text-sm">
        {backups.map((backup) => (
          <li key={backup.name} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{formatDate(backup.created)}</span>
              <span className="ml-2 text-xs text-mist-500">
                {t(`admin.backups.kind.${backup.kind}`, { defaultValue: backup.kind })} · {t('admin.backups.notes', { count: backup.notes })} · {size(backup.size)}
                {backup.note && ` · ${backup.note}`}
              </span>
            </span>
            <Button small busy={busy} onClick={() => void run(async () => setChecked(await adminApi.checkBackup(backup.name)))}>
              {t('admin.backups.check')}
            </Button>
            <Button
              small
              busy={busy}
              onClick={() => (me?.sign_in === 'password' ? setFetching({ name: backup.name, password: '' }) : download(backup.name, ''))}
            >
              {t('admin.backups.download')}
            </Button>
            <Button small onClick={() => setRestoring(backup.name)}>
              {t('admin.backups.restore')}
            </Button>
            <Button small danger busy={busy} onClick={() => void run(async () => {
              await adminApi.deleteBackup(backup.name)
              await load()
            })}>
              {t('admin.backups.delete')}
            </Button>
            {fetching?.name === backup.name && (
              <form
                className="flex w-full flex-wrap items-end gap-2 pt-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  download(backup.name, fetching.password)
                }}
              >
                <p className="w-full text-xs text-mist-400">{t('admin.backups.downloadText')}</p>
                <Input
                  label={t('admin.backups.password')}
                  value={fetching.password}
                  onChange={(password) => setFetching({ name: backup.name, password })}
                  type="password"
                  autoComplete="current-password"
                  className="min-w-52 flex-1"
                />
                <Button type="submit" primary busy={busy}>
                  {t('admin.backups.download')}
                </Button>
                <Button onClick={() => setFetching(null)}>{t('common.cancel')}</Button>
                {problem && (
                  <p role="alert" className="w-full text-xs text-bad-500">
                    {problem}
                  </p>
                )}
              </form>
            )}
          </li>
        ))}
        {backups.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('admin.backups.none')}</li>}
      </ul>
      {checked && (
        <div className="mt-3 rounded-xl border border-ink-700 bg-ink-850 p-3 text-xs">
          <p className={checked.usable ? 'text-ok-500' : 'text-bad-500'}>{checked.usable ? t('admin.backups.usable') : t('admin.backups.damaged')}</p>
          <p className="mt-1 text-mist-400">
            {t('admin.backups.would', { add: checked.would_add, change: checked.would_change, remove: checked.would_remove })}
          </p>
        </div>
      )}
      {/* While a download asks for the password, its message stands by the field, not twice. */}
      <Feedback problem={fetching ? null : problem} done={done} />
      {restarting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4" role="alertdialog" aria-labelledby="restarting-title" data-testid="restarting">
          <div className="max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-5 text-sm shadow-2xl">
            <p id="restarting-title" className="font-semibold text-mist-100">
              {t('admin.backups.restarting')}
            </p>
            <p className="mt-1 text-mist-400">{t('admin.backups.restartingWait')}</p>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={restoring !== null}
        title={t('admin.backups.restoreTitle')}
        confirm={t('admin.backups.restore')}
        danger
        busy={busy}
        onCancel={() => setRestoring(null)}
        onConfirm={() => void run(async () => {
          await adminApi.restoreBackup(restoring!)
          setRestoring(null)
          setRestarting(true)
        }, t('admin.backups.restarting'))}
      >
        {t('admin.backups.restoreText')}
      </ConfirmDialog>
    </Card>
  )
}

// --- Languages ------------------------------------------------------------------------------------------------------

export function LanguagesCard() {
  const { t } = useTranslation()
  const [options, setOptions] = useState<LanguageOption[]>([])
  const [code, setCode] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const { busy, problem, done, run } = useAction()
  const load = useCallback(async () => {
    resetAddedLanguages()
    setOptions((await languageOptions()).filter((option) => option.added))
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card id="languages" symbol="globe" title={t('admin.languages.title')} text={t('admin.languages.text')}>
      <ul className="divide-y divide-ink-700 rounded-xl border border-ink-700 text-sm">
        {options.map((option) => (
          <li key={option.code} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1">
              {option.name} <span className="font-mono text-xs text-mist-500">{option.code}</span>
            </span>
            <Button small danger busy={busy} onClick={() => void run(async () => {
              await adminApi.removeLanguage(option.code)
              await load()
            })}>
              {t('admin.languages.remove')}
            </Button>
          </li>
        ))}
        {options.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">{t('admin.languages.none')}</li>}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!file || !code.trim()) return
          void run(async () => {
            await adminApi.uploadLanguage(code.trim(), file)
            setCode('')
            setFile(null)
            await load()
          }, t('admin.languages.added'))
        }}
      >
        <Input label={t('admin.languages.code')} value={code} onChange={setCode} placeholder="es" className="w-28" />
        <label className="text-sm">
          <span className="text-xs font-medium text-mist-400">{t('admin.languages.file')}</span>
          <input type="file" accept="application/json,.json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="mt-1 block text-xs" />
        </label>
        <Button type="submit" primary busy={busy}>
          {t('admin.languages.upload')}
        </Button>
      </form>
      <Feedback problem={problem} done={done} />
    </Card>
  )
}
