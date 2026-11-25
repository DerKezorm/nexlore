/**
 * Settings in areas, as in nexnotes: "My account" (Profile, Security, Appearance, Notes, Spaces, Notifications, Plugins,
 * Connections) for every account, "Server" (General, Sign-in, Mail, Storage and backups, Public pages, AI, API and
 * plugins, Accounts, Log) for the operator, "About nexlore" for everyone at the end. The areas stand in the sidebar,
 * between "New note" and the way to the settings; each has its own address (`/settings/<slug>`, `settings/areas.ts`),
 * `/settings` is the profile. An area someone may not open, or an address of before (`/account?tab=…`,
 * `/settings?tab=…&sub=…`, `/about`), leads on with the address replaced, so the navigation always marks where one is.
 * The cards themselves stay in their files; an area only picks them.
 */
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useParams } from 'react-router-dom'

import {
  AccountsCard,
  AiCard,
  AllSpacesCard,
  ApiTokensCard,
  BackupsCard,
  CssCard,
  FilesSettingsCard,
  GuideCard,
  LanguagesCard,
  MailCard,
  McpCard,
  SharesCard,
} from '../components/settings/AdminCards'
import { AppearanceCard } from '../components/settings/AppearanceCard'
import { AppPairingSwitch } from '../components/settings/AppPairingSwitch'
import { CalendarFeedSwitch } from '../components/settings/CalendarFeed'
import { EditorCard } from '../components/settings/EditorCard'
import { KeysCard } from '../components/settings/KeysCard'
import { LinkTitleSwitch } from '../components/settings/LinkTitleSwitch'
import { LogCard } from '../components/settings/LogCard'
import { SignInPart } from '../components/settings/SignInCards'
import { SnippetsCard } from '../components/settings/SnippetsCard'
import { SpacesCard } from '../components/settings/SpacesCard'
import { HomeSpaceCard, StartCard } from '../components/settings/StartCard'
import { ThemesCard } from '../components/settings/ThemesCard'
import { useServerSettings } from '../components/settings/useServerSettings'
import { SideFrame } from '../components/SideFrame'
import { useNarrow } from '../lib/useNarrow'
import { AdminPluginsCard } from '../plugins/PluginSettings'
import { useAuth } from '../state/auth'
import { AboutArea } from './AboutPage'
import { AccountArea } from './AccountPage'
import { areaPath, findArea, formerAccountAddress, resolveArea, type AreaSlug, type ServerSlug } from './settings/areas'
import { SettingsJump, SettingsNav } from './settings/SettingsNav'

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const { area: asked } = useParams()
  const { search, hash } = useLocation()
  const small = useNarrow()
  if (!me) return null
  const where = resolveArea(asked, me.role, search, hash)
  if ('redirect' in where) return <Navigate to={where.redirect} replace />
  const area = findArea(where.area)
  if (!area) return null
  return (
    <>
      <SideFrame label={t('nav.settings')} testId="settings-side">
        <SettingsNav me={me} current={area.slug} />
      </SideFrame>
      <main className="nn-scroll flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6 sm:py-8" data-testid={`settings-area-${area.slug}`}>
          {small && <SettingsJump me={me} current={area.slug} />}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t(`settings.areas.${area.key}.title`)}</h1>
            <p className="mt-1 text-sm text-mist-400">{t(`settings.areas.${area.key}.text`)}</p>
          </div>
          <div className="space-y-6">
            <AreaContent key={area.slug} area={area.slug} />
          </div>
        </div>
      </main>
    </>
  )
}

function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
    case 'security':
    case 'notifications':
    case 'plugins':
    case 'connections':
      return <AccountArea part={area} />
    case 'appearance':
      return (
        <>
          {/* The themes first: the fonts and sizes below them fill a screen, and the themes were lost under them. */}
          <ThemesCard />
          <AppearanceCard />
          <SnippetsCard />
        </>
      )
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
    case 'about':
      return <AboutArea />
    default:
      return <ServerArea area={area} />
  }
}

/** One area of the server, for the operator. */
function ServerArea({ area }: { area: ServerSlug }) {
  const [settings, setSettings] = useServerSettings()
  switch (area) {
    case 'general':
      return (
        <>
          <FilesSettingsCard />
          {settings && <LinkTitleSwitch settings={settings} onChange={setSettings} />}
          {settings && <CssCard settings={settings} onChange={setSettings} />}
          <LanguagesCard />
          <GuideCard />
        </>
      )
    case 'sign-in':
      return settings && <SignInPart settings={settings} onChange={setSettings} />
    case 'mail':
      // Its own area since issue #13: it carries invitations, notifications and the links confirming an address.
      return settings && <MailCard settings={settings} onChange={setSettings} />
    case 'storage':
      return settings && <BackupsCard settings={settings} onChange={setSettings} />
    case 'shares':
      return settings && <SharesCard settings={settings} onChange={setSettings} />
    case 'extensions':
      return (
        settings && (
          <>
            <AiCard settings={settings} onChange={setSettings} />
            <ApiTokensCard settings={settings} onChange={setSettings} />
            <AppPairingSwitch settings={settings} onChange={setSettings} />
            <McpCard settings={settings} onChange={setSettings} />
            <CalendarFeedSwitch settings={settings} onChange={setSettings} />
            <AdminPluginsCard settings={settings} onChange={setSettings} />
          </>
        )
      )
    case 'accounts':
      return (
        <>
          <AccountsCard />
          <AllSpacesCard />
        </>
      )
    case 'log':
      return <LogCard />
  }
}

/** `/account` of before: the server still sends people there (notifications, the way back from a provider). */
export function FormerAccountAddress() {
  const { search, hash } = useLocation()
  return <Navigate to={formerAccountAddress(search, hash)} replace />
}

/** `/about` of before: "About nexlore" is an area of the settings now. */
export function FormerAboutAddress() {
  return <Navigate to={areaPath('about')} replace />
}
