/**
 * The operator's part of the settings: accounts and invitations, every space (rights only, never contents),
 * sign-in and the provider, public pages, mail, files, languages.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import {
  adminApi,
  aiApi,
  apiTokensApi,
  mcpApi,
  type AdminSpace,
  type AiMode,
  type AiModel,
  type AiShared,
  type AnyApiToken,
  type FileSettings,
  type McpTools,
  type ServerSettings,
  type ShareInfo,
  shareApi,
} from '../../api/client'
import { pastedExample } from '../../lib/pastedName'
import { downloadTemplate, resetAddedLanguages, languageOptions, type LanguageOption } from '../../i18n'
import { AI_PROVIDERS } from '../../lib/aiProviders'
import { errorText } from '../../lib/errors'
import { formatDate, formatDay } from '../../lib/markdown'
import { useAuth } from '../../state/auth'
import { useStore } from '../../state/store'
import { noteUrl } from '../../lib/vault'
import { ConfirmDialog } from '../ConfirmDialog'
import { Symbol } from '../Symbol'
import { MembersDialog } from '../MembersDialog'
import { Button, Card, Feedback, Input, Select, Toggle } from './ui'
import { useAction } from './useAction'

// --- Accounts and invitations ---------------------------------------------------------------------------------------

/** The operator's list of accounts: the shared account module's (konten 0.3.9/0.3.10), in its own file. */
export { AccountsCard } from '../../pages/settings/AccountsList'

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
        <Link to="/settings/connections#mcp" className="text-accent-400 hover:underline">
          {t('admin.mcp.keysLink')}
        </Link>
      </p>
      <Feedback problem={problem} />
    </Card>
  )
}

/** Tools no account may use, whatever its keys say Saved at once. */
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
 * on request (every way out needs a latch). Never the token itself. */
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
  const { busy, problem, done, run } = useAction()
  // Hosts in the own network members may use (Ollama at home); everything else there is refused, link-local always.
  const [hosts, setHosts] = useState(settings.ai_private_hosts.split('\n').filter(Boolean).join(', '))
  const save = (value: boolean) => {
    onChange({ ...settings, ai_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ ai_allowed: value }))
      // The editor reads it from the own account.
      await refresh()
    }).then((ok) => ok || onChange(settings))
  }
  const saveHosts = () => {
    void run(async () => {
      const saved = await adminApi.saveSettings({ ai_private_hosts: hosts })
      onChange(saved)
      setHosts(saved.ai_private_hosts.split('\n').filter(Boolean).join(', '))
    }, t('common.saved'))
  }
  const choose = (mode: AiMode) => {
    onChange({ ...settings, ai_mode: mode })
    void run(async () => {
      onChange(await adminApi.saveSettings({ ai_mode: mode }))
      await refresh()
    }).then((ok) => ok || onChange(settings))
  }
  const saveLore = (value: boolean) => {
    onChange({ ...settings, lore_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ lore_allowed: value }))
      // The header and the corner read it from the own account.
      await refresh()
    }).then((ok) => ok || onChange(settings))
  }
  const pace = (value: string) => {
    void run(async () => onChange(await adminApi.saveSettings({ ai_per_minute: Number(value) })), t('common.saved'))
  }
  const shared = settings.ai_mode === 'shared'
  return (
    <Card id="ai" symbol="sparkle" title={t('admin.ai.title')} text={t('admin.ai.text')}>
      <Toggle label={t('admin.ai.allow')} hint={t('admin.ai.allowHint')} checked={settings.ai_allowed} onChange={save} />
      {settings.ai_allowed && (
        <div className="mt-2">
          <Toggle label={t('admin.ai.loreAllow')} hint={t('admin.ai.loreAllowHint')} checked={settings.lore_allowed} onChange={saveLore} />
        </div>
      )}
      {settings.ai_allowed && (
        <fieldset className="mt-4" data-testid="ai-mode">
          <legend className="text-sm font-medium text-mist-200">{t('admin.ai.mode')}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(['own', 'shared'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={settings.ai_mode === mode}
                onClick={() => settings.ai_mode !== mode && choose(mode)}
                className={'rounded-xl border px-3 py-2.5 text-left ' + (settings.ai_mode === mode ? 'border-accent-500/70 bg-accent-500/10' : 'border-ink-700 bg-ink-850 hover:border-ink-600')}
              >
                <span className={'block text-sm font-semibold ' + (settings.ai_mode === mode ? 'text-accent-400' : 'text-mist-100')}>{t(`admin.ai.modes.${mode}`)}</span>
                <span className="block text-xs text-mist-500">{t(`admin.ai.modes.${mode}Text`)}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {settings.ai_allowed && shared && <SharedService />}
      {settings.ai_allowed && !shared && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            saveHosts()
          }}
        >
          <Input label={t('admin.ai.hosts')} value={hosts} onChange={setHosts} placeholder="192.168.1.20, ollama.lan:11434" hint={t('admin.ai.hostsHint')} className="min-w-60 flex-1" />
          <Button type="submit" busy={busy}>
            {t('common.save')}
          </Button>
        </form>
      )}
      {settings.ai_allowed && (
        <Select
          label={t('admin.ai.perMinute')}
          value={String(settings.ai_per_minute)}
          options={[...new Set([10, 20, 60, settings.ai_per_minute])].sort((a, b) => a - b).map((count) => ({ value: String(count), label: t('admin.ai.perMinuteValue', { count }) }))}
          onChange={pace}
          className="mt-3 max-w-60"
        />
      )}
      {!shared && (
        <p className="mt-3 text-sm text-mist-400" data-testid="ai-where-access">
          {t('admin.ai.where')}{' '}
          <Link to="/settings/connections#ai" className="text-accent-400 hover:underline">
            {t('admin.ai.whereLink')}
          </Link>
        </p>
      )}
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

/** The operator's one service for every account: like an account's own access, the key typed once and never shown
 * again, the model list as the test that address and key are right. Its address may lie in the own network. */
function SharedService() {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const { busy, problem, done, run } = useAction()
  const [saved, setSaved] = useState<AiShared | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [embed, setEmbed] = useState('')
  const take = (next: AiShared) => {
    setSaved(next)
    setUrl(next.url)
    setModel(next.model)
    setEmbed(next.embed_model)
    setKey('')
  }
  useEffect(() => {
    aiApi.shared().then(take, () => setSaved(null))
  }, [])
  if (!saved) return null
  return (
    <form
      className="mt-3 grid gap-3 rounded-xl border border-ink-700 bg-ink-850 p-3 sm:grid-cols-2"
      data-testid="ai-shared"
      onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const change: Parameters<typeof aiApi.saveShared>[0] = { url: url.trim(), model: model.trim(), embed_model: embed.trim() }
          if (key.trim()) change.key = key.trim()
          take(await aiApi.saveShared(change))
          await refresh()
        }, t('common.saved'))
      }}
    >
      {/* The same tiles as an account's own access: they fill in the address, any other is just as good. */}
      <div className="flex flex-wrap gap-2 sm:col-span-2" role="group" aria-label={t('ai.tiles')}>
        {AI_PROVIDERS.map((provider) => (
          <button
            key={provider.name}
            type="button"
            aria-pressed={url === provider.url}
            onClick={() => {
              setUrl(provider.url)
              setModels(null)
            }}
            className={'rounded-full border px-3 py-1 text-sm ' + (url === provider.url ? 'border-accent-500/60 bg-accent-500/10 text-mist-100' : 'border-ink-700 text-mist-300 hover:bg-ink-900')}
          >
            {provider.name}
          </button>
        ))}
      </div>
      {AI_PROVIDERS.filter((provider) => provider.url === url && provider.keys).map((provider) => (
        <p key={provider.name} className="-mt-1 text-xs sm:col-span-2">
          <a href={provider.keys!} target="_blank" rel="noreferrer noopener" className="text-accent-400 hover:underline">
            {t('ai.getKey', { name: provider.name })}
          </a>
        </p>
      ))}
      <Input label={t('ai.address')} value={url} onChange={setUrl} placeholder="http://ollama.lan:11434/v1" hint={t('admin.ai.sharedAddressHint')} className="sm:col-span-2" />
      <Input label={t('ai.key')} type="password" value={key} onChange={setKey} placeholder={saved.key_set ? t('ai.keyKept') : t('ai.keyNone')} />
      <label className="block text-sm">
        <span className="text-xs font-medium text-mist-400">{t('ai.model')}</span>
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          list="ai-shared-models"
          maxLength={200}
          className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm outline-none focus:border-accent-500"
        />
      </label>
      <label className="block text-sm sm:col-span-2">
        <span className="text-xs font-medium text-mist-400">{t('admin.ai.embedModel')}</span>
        <input
          value={embed}
          onChange={(event) => setEmbed(event.target.value)}
          list="ai-shared-models"
          maxLength={200}
          placeholder={t('admin.ai.embedNone')}
          className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 text-sm outline-none focus:border-accent-500"
        />
        <span className="mt-1 block text-xs text-mist-500">{t('admin.ai.embedHint')}</span>
        {AI_PROVIDERS.some((provider) => provider.url === url && !provider.embeddings) && (
          <span className="mt-1 block text-xs text-warn-500" data-testid="ai-embed-none">{t('admin.ai.embedNotHere')}</span>
        )}
        {saved.meaning_on && (
          <span className="mt-1 block text-xs text-accent-400" data-testid="ai-meaning-progress">
            {t('admin.ai.embedProgress', { done: saved.meaning.done, total: saved.meaning.total })}
          </span>
        )}
      </label>
      <datalist id="ai-shared-models">
        {(models ?? []).map((item) => (
          <option key={item.id} value={item.id}>
            {item.name || item.id}
          </option>
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button
          busy={busy}
          onClick={() =>
            void run(async () => {
              const found = await aiApi.sharedModels(url.trim(), key.trim() || undefined)
              setModels(found)
              if (!model.trim() && found[0]) setModel(found[0].id)
            }, null)
          }
        >
          {t('ai.loadModels')}
        </Button>
        <Button primary type="submit" busy={busy}>
          {t('common.save')}
        </Button>
        {models && <span className="text-xs text-mist-500" data-testid="ai-shared-models-count">{t('ai.modelsFound', { count: models.length })}</span>}
        {!saved.complete && <span className="text-xs text-warn-500">{t('admin.ai.sharedIncomplete')}</span>}
      </div>
      <div className="sm:col-span-2">
        <Feedback problem={problem} done={done} />
      </div>
    </form>
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
  const { me, refresh } = useAuth()
  const [form, setForm] = useState({
    smtp_host: settings.smtp_host,
    smtp_port: String(settings.smtp_port),
    smtp_security: settings.smtp_security,
    smtp_user: settings.smtp_user,
    smtp_password: '',
    smtp_from: settings.smtp_from,
    smtp_sender_name: settings.smtp_sender_name ?? '',
  })
  // The own address, when there is one: a test usually goes to oneself.
  const [to, setTo] = useState(me?.email ?? '')
  const { busy, problem, done, run } = useAction()

  return (
    <Card id="mail" symbol="mail" title={t('admin.mail.title')} text={t('admin.mail.text')}>
      {/* What it is for: invitations alone was all it once said, and the notifications and confirmations it also
          carries went unseen (issue #13). */}
      <ul className="mb-4 space-y-1 text-sm text-mist-300" data-testid="mail-uses">
        {(['usesInvites', 'usesNotify', 'usesConfirm'] as const).map((key) => (
          <li key={key} className="flex gap-2">
            <Symbol name="check" className="mt-0.5 h-4 w-4 shrink-0 text-accent-400" />
            {t(`admin.mail.${key}`)}
          </li>
        ))}
      </ul>
      {!settings.public_url && (
        <p className="mb-4 text-xs text-mist-500" data-testid="mail-public-url">
          {t('admin.mail.publicUrlMissing')}{' '}
          <Link to="/settings/sign-in" className="text-accent-400 underline underline-offset-2">
            {t('admin.mail.publicUrlSet')}
          </Link>
        </p>
      )}
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
          placeholder={settings.smtp_password_set ? t('admin.mail.passwordKept') : ''}
        />
        <Input label={t('admin.mail.from')} value={form.smtp_from} onChange={(smtp_from) => setForm({ ...form, smtp_from })} placeholder="notes@example.com" />
        {/* The name system mail goes out under (the shared post module); empty: nexlore. */}
        <Input label={t('mail.senderName')} value={form.smtp_sender_name} onChange={(smtp_sender_name) => setForm({ ...form, smtp_sender_name })} placeholder="nexlore" hint={t('mail.senderNameHint')} />
        {form.smtp_security === 'none' && <p className="text-xs text-warn-500 sm:col-span-2" data-testid="mail-unencrypted">{t('mail.warningUnencrypted')}</p>}
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
      {(settings.mail_last_ok_at || settings.mail_last_error) && (
        <p className="mt-3 text-xs text-mist-500" data-testid="mail-status">
          {settings.mail_last_ok_at && t('mail.lastOk', { when: formatDate(settings.mail_last_ok_at) })}
          {settings.mail_last_ok_at && settings.mail_last_error ? ' · ' : ''}
          {settings.mail_last_error && settings.mail_last_error_at && t('mail.lastError', { when: formatDate(settings.mail_last_error_at), error: errorText(settings.mail_last_error) })}
        </p>
      )}
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

// --- Files ----------------------------------------------------------------------------------------------------------

export function FilesSettingsCard() {
  const { t } = useTranslation()
  const [values, setValues] = useState<FileSettings | null>(null)
  // The folder name as stored: a new one may take the folders already there along.
  const [stored, setStored] = useState('')
  const [renameExisting, setRenameExisting] = useState(true)
  const [report, setReport] = useState<string | null>(null)
  const { busy, problem, done, run } = useAction()
  useEffect(() => {
    void run(async () => {
      const found = await adminApi.fileSettings()
      setValues(found)
      setStored(found.attachment_folder)
    })
  }, [run])
  if (!values) return null
  const renamed = values.attachment_folder.trim() !== stored
  return (
    <Card id="files" symbol="clip" title={t('admin.files.title')} text={t('admin.files.text')}>
      <form
        className="grid gap-2 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault()
          setReport(null)
          void run(async () => {
            const saved = await adminApi.saveFileSettings({ ...values, rename_existing: renamed && renameExisting })
            const { renamed: count, left, ...rest } = saved
            setValues(rest)
            setStored(rest.attachment_folder)
            const lines = [
              ...(count ? [t('admin.files.renamed', { count })] : []),
              ...(left.length ? [t('admin.files.left', { count: left.length, list: left.join(', ') })] : []),
            ]
            setReport(lines.length ? lines.join(' ') : null)
          }, t('common.saved'))
        }}
      >
        <Input label={t('admin.files.folder')} value={values.attachment_folder} onChange={(attachment_folder) => setValues({ ...values, attachment_folder })} />
        <Input label={t('admin.files.perFile')} value={String(values.upload_max_mb)} onChange={(value) => setValues({ ...values, upload_max_mb: Number(value) || 1 })} type="number" />
        <Input label={t('admin.files.quota')} value={String(values.quota_mb)} onChange={(value) => setValues({ ...values, quota_mb: Number(value) || 0 })} type="number" hint={t('admin.files.quotaHint')} />
        {renamed && (
          <div className="sm:col-span-3">
            <Toggle
              label={t('admin.files.renameExisting')}
              hint={t('admin.files.renameExistingHint', { old: stored })}
              checked={renameExisting}
              onChange={setRenameExisting}
            />
          </div>
        )}
        <div className="sm:col-span-3">
          <Input
            label={t('admin.files.pasted')}
            value={values.pasted_name}
            onChange={(pasted_name) => setValues({ ...values, pasted_name })}
            hint={t('admin.files.pastedHint', { example: `${values.attachment_folder.trim()}/${pastedExample(values.pasted_name, t('admin.files.pastedNote'), new Date())}.png` })}
          />
        </div>
        <div className="sm:col-span-3">
          <Input
            label={t('admin.files.uploaded')}
            value={values.uploaded_name}
            onChange={(uploaded_name) => setValues({ ...values, uploaded_name })}
            hint={t('admin.files.uploadedHint', {
              example: `${values.attachment_folder.trim()}/${pastedExample(values.uploaded_name, t('admin.files.pastedNote'), new Date(), t('admin.files.uploadedFile'))}.pdf`,
            })}
          />
        </div>
        <div className="sm:col-span-3">
          <Toggle label={t('admin.files.strip')} hint={t('admin.files.stripHint')} checked={values.strip_location} onChange={(strip_location) => setValues({ ...values, strip_location })} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <Feedback problem={problem} done={done && report ? `${done} ${report}` : done} />
    </Card>
  )
}

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
        {/* The English texts as a file to translate (was beside the own language in the profile). */}
        <Button onClick={downloadTemplate}>
          <Symbol name="download" /> {t('settings.language.template')}
        </Button>
      </form>
      <Feedback problem={problem} done={done} />
    </Card>
  )
}
