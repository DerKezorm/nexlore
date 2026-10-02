/**
 * Settings in tabs, as in Nexview and nextrmnl: General (the language), Spaces (one's own, with members), and for the
 * operator Server, with a second row for its parts. The tab is in the address (`?tab=server&sub=backups`), so a link
 * can point at one; a tab someone may not see falls back to General.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import {
  AccountsCard,
  AllSpacesCard,
  BackupsCard,
  FilesSettingsCard,
  LanguagesCard,
  MailCard,
  AiCard,
  GuideCard,
  McpCard,
  ApiTokensCard,
  SharesCard,
  SignInCard,
  CssCard,
} from '../components/settings/AdminCards'
import { AdminPluginsCard } from '../plugins/PluginSettings'
import { useServerSettings } from '../components/settings/useServerSettings'
import { AppearanceCard } from '../components/settings/AppearanceCard'
import { HomeSpaceCard, StartCard } from '../components/settings/StartCard'
import { KeysCard } from '../components/settings/KeysCard'
import { SnippetsCard } from '../components/settings/SnippetsCard'
import { ThemesCard } from '../components/settings/ThemesCard'
import { SpacesCard } from '../components/settings/SpacesCard'
import { CalendarFeedSwitch } from '../components/settings/CalendarFeed'
import { LinkTitleSwitch } from '../components/settings/LinkTitleSwitch'
import { LogCard } from '../components/settings/LogCard'
import { Symbol, type SymbolName } from '../components/Symbol'
import { TabRow, type Tab } from '../components/TabRow'
import { downloadTemplate, languageOptions, type LanguageOption } from '../i18n'
import { useAuth } from '../state/auth'

type Top = 'general' | 'looks' | 'spaces' | 'server'
type Part = 'accounts' | 'signin' | 'shares' | 'extensions' | 'files' | 'backups' | 'languages' | 'log'
const TOPS: Top[] = ['general', 'looks', 'spaces', 'server']
const PARTS: Part[] = ['accounts', 'signin', 'shares', 'extensions', 'files', 'backups', 'languages', 'log']
const TOP_SYMBOL: Record<Top, SymbolName> = { general: 'globe', looks: 'eye', spaces: 'space', server: 'shield' }
const PART_SYMBOL: Record<Part, SymbolName> = {
  accounts: 'users', signin: 'key', shares: 'globe', extensions: 'plug', files: 'files', backups: 'history', languages: 'globe', log: 'info',
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const operator = me?.role === 'operator'
  const asked = params.get('tab') as Top | null
  const top: Top = asked && TOPS.includes(asked) && (asked !== 'server' || operator) ? asked : 'general'
  const askedPart = params.get('sub') as Part | null
  const part: Part = askedPart && PARTS.includes(askedPart) ? askedPart : 'accounts'
  const go = (next: Top, sub?: Part) => setParams(next === 'general' ? {} : sub ? { tab: next, sub } : { tab: next }, { replace: true })

  const tops: Tab<Top>[] = TOPS.filter((value) => value !== 'server' || operator).map((value) => ({
    value, label: t(`settings.tabs.${value}`), symbol: TOP_SYMBOL[value],
  }))
  const parts: Tab<Part>[] = PARTS.map((value) => ({ value, label: t(`settings.parts.${value}`), symbol: PART_SYMBOL[value] }))

  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
        <TabRow tabs={tops} active={top} onChange={(value) => go(value)} label={t('settings.title')} />
        {top === 'server' && <TabRow under tabs={parts} active={part} onChange={(value) => go('server', value)} label={t('settings.tabs.server')} />}
        <div className="space-y-6 pt-1">
          {top === 'general' && <LanguageCard />}
          {top === 'general' && <StartCard />}
          {top === 'general' && <HomeSpaceCard />}
          {top === 'general' && <KeysCard />}
          {top === 'looks' && (
            <>
              {/* The themes first: the fonts and sizes below them fill a screen, and the themes were lost under them. */}
              <ThemesCard />
              <AppearanceCard />
              <SnippetsCard />
            </>
          )}
          {top === 'spaces' && <SpacesCard />}
          {top === 'server' && <ServerPart part={part} />}
        </div>
      </div>
    </main>
  )
}

/** One part of the server, for the operator. */
function ServerPart({ part }: { part: Part }) {
  const [settings, setSettings] = useServerSettings()
  switch (part) {
    case 'accounts':
      return (
        <>
          <AccountsCard />
          <AllSpacesCard />
          {settings && <MailCard settings={settings} onChange={setSettings} />}
        </>
      )
    case 'signin':
      return settings && <SignInCard settings={settings} onChange={setSettings} />
    case 'shares':
      return settings && <SharesCard settings={settings} onChange={setSettings} />
    case 'extensions':
      return (
        settings && (
          <>
            <ApiTokensCard settings={settings} onChange={setSettings} />
            <McpCard settings={settings} onChange={setSettings} />
            <CalendarFeedSwitch settings={settings} onChange={setSettings} />
            <LinkTitleSwitch settings={settings} onChange={setSettings} />
            <AiCard settings={settings} onChange={setSettings} />
            <CssCard settings={settings} onChange={setSettings} />
            <AdminPluginsCard settings={settings} onChange={setSettings} />
          </>
        )
      )
    case 'log':
      return <LogCard />
    case 'files':
      return (
        <>
          <FilesSettingsCard />
          <GuideCard />
        </>
      )
    case 'backups':
      return settings && <BackupsCard settings={settings} onChange={setSettings} />
    case 'languages':
      return <LanguagesCard />
  }
}

function LanguageCard() {
  const { t, i18n } = useTranslation()
  const { setLanguage, me } = useAuth()
  const operator = me?.role === 'operator'
  const [options, setOptions] = useState<LanguageOption[]>([])

  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setOptions(list))
    return () => {
      alive = false
    }
  }, [])

  return (
    <Card symbol="globe" title={t('settings.language.title')} text={operator ? t('settings.language.text') : t('settings.language.textMember')}>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
        <label htmlFor="language" className="font-medium">
          {t('settings.language.choose')}
        </label>
        <select
          id="language"
          value={i18n.language}
          onChange={(e) => void setLanguage(e.target.value)}
          className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-mist-100"
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
              {option.added ? ` (${t('settings.language.added')})` : ''}
            </option>
          ))}
        </select>
        {operator && (
        <button
          type="button"
          onClick={downloadTemplate}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800"
          title={t('settings.language.templateHint')}
        >
          <Symbol name="download" /> {t('settings.language.template')}
        </button>
        )}
      </div>
      {operator && <p className="mt-2 text-xs text-mist-500">{t('settings.language.templateHint')}</p>}
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
