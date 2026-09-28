/**
 * Settings: the language, the own spaces, and for the operator the server (accounts, sign-in, public pages, mail,
 * files, backups, languages). AI access over MCP and plugins are still sketches (M7).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  AccountsCard,
  AllSpacesCard,
  BackupsCard,
  FilesSettingsCard,
  LanguagesCard,
  MailCard,
  McpCard,
  SharesCard,
  SignInCard,
} from '../components/settings/AdminCards'
import { AdminPluginsCard } from '../plugins/PluginSettings'
import { useServerSettings } from '../components/settings/useServerSettings'
import { SpacesCard } from '../components/settings/SpacesCard'
import { Symbol, type SymbolName } from '../components/Symbol'
import { downloadTemplate, languageOptions, type LanguageOption } from '../i18n'
import { useAuth } from '../state/auth'

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()

  return (
    <main className="nn-scroll flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
        </div>

        <LanguageCard />
        <SpacesCard />
        {me?.role === 'operator' && <OperatorPart />}

      </div>
    </main>
  )
}

/** The server, for the operator. */
function OperatorPart() {
  const { t } = useTranslation()
  const [settings, setSettings] = useServerSettings()
  return (
    <>
      <h2 className="pt-4 text-lg font-semibold">{t('admin.title')}</h2>
      <p className="-mt-4 text-sm text-mist-500">{t('admin.text')}</p>
      <AccountsCard />
      <AllSpacesCard />
      {settings && (
        <>
          <SignInCard settings={settings} onChange={setSettings} />
          <SharesCard settings={settings} onChange={setSettings} />
          <McpCard settings={settings} onChange={setSettings} />
          <AdminPluginsCard settings={settings} onChange={setSettings} />
          <MailCard settings={settings} onChange={setSettings} />
          <BackupsCard settings={settings} onChange={setSettings} />
        </>
      )}
      <FilesSettingsCard />
      <LanguagesCard />
    </>
  )
}

function LanguageCard() {
  const { t, i18n } = useTranslation()
  const { setLanguage } = useAuth()
  const [options, setOptions] = useState<LanguageOption[]>([])

  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setOptions(list))
    return () => {
      alive = false
    }
  }, [])

  return (
    <Card symbol="globe" title={t('settings.language.title')} text={t('settings.language.text')}>
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
        <button
          type="button"
          onClick={downloadTemplate}
          className="ml-auto inline-flex items-center gap-2 rounded-full border border-ink-700 px-3.5 py-1.5 text-sm text-mist-300 hover:bg-ink-800"
          title={t('settings.language.templateHint')}
        >
          <Symbol name="download" /> {t('settings.language.template')}
        </button>
      </div>
      <p className="mt-2 text-xs text-mist-500">{t('settings.language.templateHint')}</p>
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
