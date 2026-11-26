/**
 * Which cards each area of the settings shows, in the order of the plan "Einstellungen": the shared ones from the
 * modules first (or at their fixed places), nexlore's own after them. Every area holds only cards.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { aboutApi, api, ApiError, tabId, type ServerSettings } from '../../api/client'
import { LoreCard } from '../../components/settings/LoreCard'
import { AppDevices } from '../../components/AppDevices'
import { NotifySettings } from '../../components/NotifySettings'
import {
  AccountsCard,
  AllSpacesCard,
  CssCard,
  FeaturesCard,
  FilesSettingsCard,
  GuideCard,
  SharesCard,
} from '../../components/settings/AdminCards'
import { LanguagesCard } from '../../vendor/nexsprachen/LanguagesCard'
import type { Fetcher } from '../../vendor/nexsprachen/sprachen'
import { en, resetAddedLanguages } from '../../i18n'
import { AppearanceCard as LookCard } from '../../components/settings/AppearanceCard'
import { CalendarFeed } from '../../components/settings/CalendarFeed'
import { EditorCard } from '../../components/settings/EditorCard'
import { InstallCard } from '../../components/settings/InstallCard'
import { KeysCard } from '../../components/settings/KeysCard'
import { LinkTitleSwitch } from '../../components/settings/LinkTitleSwitch'
import { LogCard } from '../../components/settings/LogCard'
import { McpRecipes } from '../../components/settings/McpRecipes'
import { mcpRequest, requestHref, useMcpWords } from '../../lib/mcpModule'
import { AiAccountArea, AiProviderArea, type AiRequest } from '../../vendor/nexki'
import { refreshNews } from '../../lib/news'
import { McpOperatorSettings, PendingRequests, ToolRights } from '../../vendor/nexmcp'
import { SnippetsCard } from '../../components/settings/SnippetsCard'
import { SpacesCard } from '../../components/settings/SpacesCard'
import { HomeSpaceCard, StartCard } from '../../components/settings/StartCard'
import { ThemesCard } from '../../components/settings/ThemesCard'
import { useServerSettings } from '../../components/settings/useServerSettings'
import { errorText } from '../../lib/errors'
import { AdminPluginsCard, MyPluginsCard } from '../../plugins/PluginSettings'
import { useAuth } from '../../state/auth'
import { AppearanceCard, SignOutCard, WhatYouSeeCard } from '../../vendor/nexkonten/AccountCards'
import { SignInPage, type AddressQuestion, type SignInChange, type SignInView } from '../../vendor/nexkonten/SignInPage'
import type { Readiness } from '../../vendor/nexkonten/konten'
import { SignInProviders, type OidcAdminCalls } from '../../vendor/nexoidc/SignInProviders'
import { MailCard } from '../../vendor/nexpost/MailCard'
import { AllKeysCard, ApiKeysCard, InterfacesCard, ToolsCard } from '../../vendor/nexschluessel'
import type { KeyRequest } from '../../vendor/nexschluessel/schluessel'
import { adminApi } from '../../api/client'
import { AboutArea } from '../AboutPage'
import { AccountNotices, ProfileCard, SecurityCard } from './AccountCards'
import type { AreaSlug } from './areas'
import { StorageArea } from './StorageArea'

/** nexlore's client for the cards of the modules: the tab in every request, its error with `code` and values. */
const request: KeyRequest = <T,>(path: string, init: Parameters<KeyRequest>[1] = {}) =>
  api<T>(path, { method: init.method, query: init.query, body: init.body } as Parameters<typeof api>[1])

/** The same client for the shared module ki 0.1.0. */
const aiRequest: AiRequest = <T,>(path: string, init: Parameters<AiRequest>[1] = {}) =>
  api<T>(path, { method: init.method, body: init.body } as Parameters<typeof api>[1])

function failure(error: unknown): string {
  return error instanceof ApiError ? errorText(error.code, error.values) : errorText('internal_error')
}

export function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
      return <ProfileArea />
    case 'security':
      return <SecurityArea />
    case 'appearance':
      return <AppearanceArea />
    case 'notes':
      return (
        <>
          <StartCard />
          <EditorCard />
          <HomeSpaceCard />
          <KeysCard />
        </>
      )
    case 'spaces':
      return <SpacesCard />
    case 'plugins':
      return <MyPluginsCard />
    case 'ai':
      return <AiArea />
    case 'notifications':
      return <NotifySettings />
    case 'connections':
      return <ConnectionsArea />
    case 'about':
      return <AboutArea />
    default:
      return <ServerArea area={area} />
  }
}

function ProfileArea() {
  const { t } = useTranslation()
  const { me, signOut } = useAuth()
  const navigate = useNavigate()
  if (!me) return null
  return (
    <>
      <AccountNotices me={me} />
      <ProfileCard me={me} />
      <SignOutCard
        t={t}
        things={t('settings.things')}
        provider={me.sign_in !== 'password'}
        onSignOut={() => void signOut().then(() => navigate('/login', { replace: true }))}
      />
    </>
  )
}

function SecurityArea() {
  const { me } = useAuth()
  if (!me) return null
  return (
    <>
      <AccountNotices me={me} />
      <SecurityCard me={me} />
    </>
  )
}

/** "Aussehen" first (light, dark or as the system, kept with the account on every device), then nexlore's themes,
 * fonts and width, and own CSS. */
function AppearanceArea() {
  const { me, setAppearance } = useAuth()
  return (
    <>
      <AppearanceCard theme={me?.appearance?.mode} onChange={(mode) => void setAppearance({ mode })} />
      <ThemesCard />
      <LookCard />
      <SnippetsCard />
    </>
  )
}

/** Where the description of the programming interface is: the guide in the source (`docs/api.md`). */
function useDocs(): string | undefined {
  const [docs, setDocs] = useState<string>()
  useEffect(() => {
    void aboutApi.about().then((about) => setDocs(`${about.repo_url}/blob/main/docs/api.md`), () => setDocs(undefined))
  }, [])
  return docs
}

/** Mein Konto › KI (E61, the shared module ki 0.1.0): "KI für mich", the own access where the operator chose it, what
 * went out. */
function AiArea() {
  const { i18n } = useTranslation()
  const when = useCallback((iso: string) => new Date(iso).toLocaleString(i18n.language), [i18n.language])
  return <AiAccountArea request={aiRequest} app="nexlore" language={i18n.language} when={when} />
}

/** Devices, installing, nexlore's calendar feed, then API keys and AI tools (MCP); AI in notes is under "KI" now. */
function ConnectionsArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const docs = useDocs()
  const mcpWords = useMcpWords()
  const words = {
    rights: { read: t('apiTokens.level.read'), write: t('apiTokens.level.write'), draft: t('mcp.level.draft') },
    areas: t('apiTokens.spaces'),
  }
  return (
    <>
      <AppDevices />
      <InstallCard />
      <CalendarFeed />
      <ApiKeysCard request={request} things={t('settings.things')} thingsDative={t('settings.thingsDative')} words={words} docsHref={docs} operator={me?.role === 'operator'} language={i18n.language} />
      {/* The parts of the shared module mcp 1.1.0: "Rechte je Werkzeug" at every MCP key and program, "Wartende
          Rückfragen" below; nexlore's own box how a program connects after them. */}
      <ToolsCard
        request={request}
        words={words}
        language={i18n.language}
        extra={(key) => (key.kind === 'mcp' ? <ToolRights request={mcpRequest} keyId={key.id} words={mcpWords} language={i18n.language} /> : null)}
      >
        <PendingRequests request={mcpRequest} words={mcpWords} language={i18n.language} viewHref={requestHref} onChanged={() => void refreshNews()} />
        <McpRecipes />
      </ToolsCard>
    </>
  )
}

/** One area of the server, for the operator. */
function ServerArea({ area }: { area: Exclude<AreaSlug, 'profile' | 'security' | 'appearance' | 'notes' | 'spaces' | 'plugins' | 'ai' | 'notifications' | 'connections' | 'about'> }) {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useServerSettings()
  const docs = useDocs()
  const mcpWords = useMcpWords()
  switch (area) {
    case 'general':
      return (
        <>
          <FilesSettingsCard />
          {settings && <FeaturesCard settings={settings} onChange={setSettings} />}
          <InterfacesCard request={request} docsHref={docs} language={i18n.language} after={{ mcp: <McpOperatorSettings request={mcpRequest} words={mcpWords} language={i18n.language} /> }} />
          {/* Server › General › Languages from the shared module sprachen 1.0.0: the template from the page's English
              texts, a change makes the menus ask the server again. */}
          <LanguagesCard app="nexlore" base="/api/locales" template={en} fetcher={languagesFetch} onChange={resetAddedLanguages} language={i18n.language} />
          {settings && <LinkTitleSwitch settings={settings} onChange={setSettings} />}
          {settings && <CssCard settings={settings} onChange={setSettings} />}
          <GuideCard />
        </>
      )
    case 'sign-in':
      return <ServerSignIn settings={settings} onSettings={setSettings} />
    case 'mail':
      return <MailCard request={request} subtitle={t('admin.mail.text')} senderPlaceholder="lore@example.com" language={i18n.language} />
    case 'storage':
      return <StorageArea />
    case 'ai-provider':
      // Server › KI-Anbieter from the shared module ki 0.1.0, nexlore's Lore and meaning below.
      return (
        <AiProviderArea request={aiRequest} app="nexlore" language={i18n.language}>
          {settings && <LoreCard settings={settings} onChange={setSettings} />}
        </AiProviderArea>
      )
    case 'server-plugins':
      return settings ? <AdminPluginsCard settings={settings} onChange={setSettings} /> : null
    case 'shares':
      return settings ? <SharesCard settings={settings} onChange={setSettings} /> : null
    case 'accounts':
      return (
        <>
          <AccountsCard />
          <WhatYouSeeCard t={t} text={t('admin.accounts.whatYouSee')} />
          <AllKeysCard request={request} language={i18n.language} />
          <AllSpacesCard />
        </>
      )
    case 'log':
      return <LogCard />
  }
}

/** The card of languages asks the server with the session and names the tab, as every change here must. */
const languagesFetch: Fetcher = (path, init) =>
  fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'X-Nexlore-Client': tabId() } })

/** Server › Sign-in: the page of the account module (the emergency notice, "Ready for the internet?", "Sign-in") with
 * the cards of the sign-in module after it ("Sign-in providers", "authentik in one step"). */
function ServerSignIn({ settings, onSettings }: { settings: ServerSettings | null; onSettings: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { me, refresh } = useAuth()
  const [view, setView] = useState<SignInView | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const load = () => {
    void api<SignInView>('/api/server/sign-in').then(setView, () => setView(null))
    void api<Readiness>('/api/server/sign-in/readiness').then(setReadiness, () => setReadiness(null))
  }
  useEffect(load, [])
  const publicUrl = settings?.public_url ?? ''
  const calls: OidcAdminCalls = {
    providers: () => adminApi.providers() as never,
    add: (form) => adminApi.addProvider(form as never),
    save: (id, form) => adminApi.saveProvider(Number(id), form as never),
    remove: (id) => adminApi.removeProvider(Number(id)),
    impact: (id, issuer) => adminApi.providerImpact(Number(id), issuer) as never,
    order: (ids) => adminApi.orderProviders(ids.map(Number)),
    authentik: (url, token, confirm, address) => adminApi.authentik(url, token, confirm, address) as never,
    authentikAddress: () => adminApi.authentikAddress() as never,
    authentikSaveAddress: (address, confirm) => adminApi.saveAuthentikAddress(address, confirm) as never,
  }
  return (
    <SignInPage
      t={t}
      app="nexlore"
      view={view}
      readiness={readiness}
      publicUrl={publicUrl}
      operatorHasPassword={me?.sign_in === 'password'}
      onChange={async (change: SignInChange, password?: string) => {
        setView(await api<SignInView>('/api/server/sign-in', { method: 'PUT', body: { ...change, current_password: password ?? '' } }))
        load()
        await refresh()
      }}
      onSaveAddress={async (url: string, confirm: boolean): Promise<AddressQuestion | null> => {
        try {
          onSettings(await adminApi.saveSettings({ public_url: url, confirm_address: confirm } as never))
          load()
          return null
        } catch (error) {
          if (error instanceof ApiError && error.code === 'public_url_change') return error.values as unknown as AddressQuestion
          throw error
        }
      }}
      errorText={failure}
      saved={t('common.saved')}
      providers={
        <SignInProviders
          t={t}
          app="nexlore"
          apiPrefix="/api"
          calls={calls}
          errorOf={(error) => (error instanceof ApiError ? { code: error.code, values: error.values } : null)}
          publicUrl={publicUrl}
          onAddress={async () => {
            // The authentik card saved the public address: card 1 of the page shows the server's new one.
            onSettings(await adminApi.settings())
            load()
          }}
        />
      }
    />
  )
}
