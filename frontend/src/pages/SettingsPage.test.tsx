/**
 * The settings in areas, as in nexnotes: the app's sidebar with the spaces stays on the left, the navigation of the
 * settings stands in the page beside the content, with "My account" for everybody and "Server" for the operator,
 * "About nexlore" at the end. Every card of before (the tabs
 * of the settings and of the own account, the account menu) has exactly one place, nothing got lost on the way, and
 * the addresses of before lead to the area that holds their cards now.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The props each stand-in got last, by its name (E67: the moved cards keep theirs).
const seen = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>)
const stubs = vi.hoisted(() => (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, (props: Record<string, unknown>) => {
    seen[name] = props
    return { $$typeof: Symbol.for('react.transitional.element'), type: 'section', key: null, props: { 'data-card': name }, _owner: null, _store: {} }
  }])),
)

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../components/settings/AdminCards', async (original) => ({
  ...(await original()),
  ...stubs('AccountsCard', 'AllSpacesCard', 'CssCard', 'FeaturesCard', 'FilesSettingsCard', 'GuideCard', 'SharesCard'),
}))
vi.mock('../components/settings/AppearanceCard', () => stubs('AppearanceCard'))
vi.mock('../components/settings/CalendarFeed', () => stubs('CalendarFeedSwitch', 'CalendarFeed'))
vi.mock('../components/settings/EditorCard', () => stubs('EditorCard'))
vi.mock('../components/settings/InstallCard', () => stubs('InstallCard'))
vi.mock('../components/settings/KeysCard', () => stubs('KeysCard'))
vi.mock('../components/settings/LinkTitleSwitch', () => stubs('LinkTitleSwitch'))
vi.mock('../components/settings/LogCard', () => stubs('LogCard'))
vi.mock('./settings/StorageArea', () => stubs('StorageArea'))
vi.mock('../components/settings/SnippetsCard', () => stubs('SnippetsCard'))
vi.mock('../components/settings/SpacesCard', () => stubs('SpacesCard'))
vi.mock('../components/settings/StartCard', () => stubs('HomeSpaceCard', 'StartCard'))
vi.mock('../components/settings/ThemesCard', () => stubs('ThemesCard'))
// The server settings: loaded, or (``failed``) not, then the cards that need them give way to a message with a retry.
const serverSettings = vi.hoisted(() => ({ failed: false, retries: 0 }))
vi.mock('../components/settings/useServerSettings', () => ({
  useServerSettings: () => [serverSettings.failed ? null : {}, () => undefined, serverSettings.failed, () => { serverSettings.retries += 1 }],
}))
vi.mock('../plugins/PluginSettings', () => stubs('AdminPluginsCard', 'MyPluginsCard'))
// Since the shared module ki 0.1.0: Mein Konto › KI and Server › KI-Anbieter are the module's areas (E61); nexlore's
// Lore and meaning stand inside the provider's area.
vi.mock('../vendor/nexki', () => stubs('AiAccountArea', 'AiProviderArea'))
vi.mock('../components/settings/LoreCard', () => stubs('LoreCard'))
// Since the shared module geraete 0.1.0 the card of devices is the module's (place 1 of Connections).
vi.mock('../vendor/nexgeraete', () => stubs('DevicesCard'))
vi.mock('../connect/connect', () => stubs('AppsArea', 'AppsOperator', 'ConnectConsent', 'ConnectReturn'))
vi.mock('../components/NotifySettings', () => stubs('NotifySettings'))
// The cards of the shared modules: the account module's (profile, security, sign-out, look, what the operator sees,
// the page Sign-in), the key module's, the mail module's.
vi.mock('./settings/AccountCards', () => ({ ...stubs('ProfileCard', 'SecurityCard'), AccountNotices: () => null }))
vi.mock('../vendor/nexkonten/AccountCards', () => stubs('AppearanceCard', 'SignOutCard', 'WhatYouSeeCard'))
vi.mock('../vendor/nexkonten/SignInPage', () => stubs('SignInPage'))
vi.mock('../vendor/nexschluessel', () => stubs('ApiKeysCard', 'ToolsCard', 'InterfacesCard', 'AllKeysCard'))
vi.mock('../vendor/nexpost/MailCard', () => stubs('MailCard'))
// Since the shared module sprachen 1.0.0 the card of languages is the module's.
vi.mock('../vendor/nexsprachen/LanguagesCard', () => stubs('LanguagesCard'))
vi.mock('./AboutPage', () => stubs('AboutArea'))
vi.mock('../components/Sidebar', () => stubs('SpacesSidebar'))
vi.mock('../api/client', async (original) => {
  const real = await original<typeof import('../api/client')>()
  return { ...real, authApi: { ...real.authApi, myProviders: async () => [] }, aboutApi: { ...real.aboutApi, about: async () => ({ repo_url: 'https://example.com/nexlore' }) } }
})

const asked = vi.hoisted(() => ({ role: 'operator' as 'operator' | 'member' }))
vi.mock('../state/auth', () => ({
  useAuth: () => ({
    me: { id: 1, name: 'jule', display_name: 'Jule', role: asked.role, avatar: null, sign_in: 'password', email: '' },
    refresh: async () => undefined,
    signOut: async () => undefined,
  }),
}))

import { areaText, NEXUI_TEXTS } from '../vendor/nexui'
import { AREAS, GENERAL_PARTS } from './settings/areas'
import { FormerAboutAddress, FormerAccountAddress, SettingsPage } from './SettingsPage'

let root: Root
let box: HTMLDivElement

function Where() {
  const location = useLocation()
  return createElement('output', { 'data-testid': 'where' }, location.pathname + location.search + location.hash)
}

async function show(entry: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:area" element={<SettingsPage />} />
          <Route path="/account" element={<FormerAccountAddress />} />
          <Route path="/about" element={<FormerAboutAddress />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await act(async () => new Promise((done) => setTimeout(done, 0)))
}

async function hide(): Promise<void> {
  await act(async () => root.unmount())
  box.remove()
}

const where = () => box.querySelector('[data-testid="where"]')!.textContent
const nav = () => box.querySelector('[data-testid="settings-nav"]')!
const entries = () => [...nav().querySelectorAll('a')].map((link) => link.getAttribute('href'))
const current = () => nav().querySelector('a[aria-current="page"]')?.getAttribute('href')
const cards = () => [...box.querySelectorAll('[data-testid^="settings-area-"] [data-card]')].map((card) => card.getAttribute('data-card'))

beforeEach(() => {
  asked.role = 'operator'
  serverSettings.failed = false
  serverSettings.retries = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the navigation', () => {
  it('stands in the page beside the content, the spaces stay in the sidebar, both groups for the operator, About at the end', async () => {
    await show('/settings')
    const side = box.querySelector('[data-card="SpacesSidebar"]')!
    expect(side).not.toBeNull()
    expect(side.contains(nav())).toBe(false)
    expect(box.querySelector('main')!.contains(nav())).toBe(true)
    expect([...nav().querySelectorAll('[data-group]')].map((group) => group.getAttribute('data-group'))).toEqual(['account', 'server'])
    expect(entries()).toEqual([...AREAS.map((area) => `/settings/${area.slug}`), '/settings/about'])
    // The order of the plan "Einstellungen": Profile, Security, Appearance, nexlore's own, Notifications, Connections;
    // General, Sign-in, Mail, Storage, nexlore's own (AI provider, Plugins, Public pages), Accounts, Log.
    expect(entries()).toEqual([
      '/settings/profile', '/settings/security', '/settings/appearance', '/settings/notes', '/settings/spaces', '/settings/plugins',
      '/settings/ai', '/settings/notifications', '/settings/connections', '/settings/general', '/settings/server-connections', '/settings/sign-in', '/settings/mail', '/settings/storage',
      '/settings/ai-provider', '/settings/server-plugins', '/settings/shares', '/settings/accounts', '/settings/log', '/settings/about',
    ])
    expect(current()).toBe('/settings/profile')
    expect(box.querySelector('h1')?.textContent).toBe('Profile')
    await hide()
  })

  it('shows a member only the own account and About', async () => {
    asked.role = 'member'
    await show('/settings')
    expect(entries()).toEqual([
      '/settings/profile', '/settings/security', '/settings/appearance', '/settings/notes', '/settings/spaces', '/settings/plugins',
      '/settings/ai', '/settings/notifications', '/settings/connections', '/settings/about',
    ])
    await hide()
  })
})

describe('nothing got lost', () => {
  /** Every card of before: the four tabs of the settings with the nine parts of the server, the five tabs of the own
   * account, the language of the account menu and About. Since the shared account module the profile card holds the
   * name, the address and the language (the template of a language moved to "Languages" of the server), the
   * security card the password, the second factor and the sessions, and signing out has a card of its own. */
  const BEFORE = [
    // Settings: General, Look, Spaces
    'StartCard', 'EditorCard', 'HomeSpaceCard', 'KeysCard', 'ThemesCard', 'AppearanceCard', 'SnippetsCard', 'SpacesCard',
    // Settings: Server (the switches of API tokens, the iPhone app and MCP are in "Schnittstellen" now, the calendar
    // feed's in "Funktionen für alle Konten", every token of every account in "API-Schlüssel aller Konten")
    'AccountsCard', 'AllSpacesCard', 'SignInPage', 'MailCard', 'SharesCard', 'InterfacesCard', 'FeaturesCard', 'AllKeysCard',
    'LinkTitleSwitch', 'AiProviderArea', 'CssCard', 'AdminPluginsCard', 'LogCard', 'FilesSettingsCard', 'GuideCard', 'StorageArea', 'LanguagesCard',
    // My account (the own API tokens and MCP keys are the key module's two cards now)
    'ProfileCard', 'SignOutCard', 'SecurityCard', 'DevicesCard', 'NotifySettings', 'ApiKeysCard', 'ToolsCard', 'AiAccountArea', 'CalendarFeed', 'MyPluginsCard',
    // Installing moved from About to Connections; About
    'InstallCard', 'AboutArea',
    // New in the settings pass: "Aussehen" first under Appearance, "What you see" under Accounts
    'AppearanceCard', 'WhatYouSeeCard',
    // New with the shared module verbinden: the other nex apps under Connections, "Andere nex-Apps" under General
    'AppsArea', 'AppsOperator',
  ]

  it('gives every card of before exactly one place', async () => {
    const seen: Record<string, string[]> = {}
    for (const slug of [...AREAS.map((area) => area.slug), 'about']) {
      await show(`/settings/${slug}`)
      expect(where(), slug).toBe(`/settings/${slug}`)
      seen[slug] = cards() as string[]
      await hide()
    }
    expect(Object.values(seen).flat().sort()).toEqual([...BEFORE].sort())
    expect(seen).toEqual({
      profile: ['ProfileCard', 'SignOutCard'],
      security: ['SecurityCard'],
      appearance: ['AppearanceCard', 'ThemesCard', 'AppearanceCard', 'SnippetsCard'],
      notes: ['StartCard', 'EditorCard', 'HomeSpaceCard', 'KeysCard'],
      spaces: ['SpacesCard'],
      plugins: ['MyPluginsCard'],
      ai: ['AiAccountArea'],
      notifications: ['NotifySettings'],
      connections: ['DevicesCard', 'InstallCard', 'AppsArea', 'CalendarFeed', 'ApiKeysCard', 'ToolsCard'],
      general: ['FilesSettingsCard', 'FeaturesCard', 'LanguagesCard', 'LinkTitleSwitch', 'CssCard', 'GuideCard'],
      // E67: "Andere nex-Apps", then "Schnittstellen", under Server › Connections.
      'server-connections': ['AppsOperator', 'InterfacesCard'],
      'sign-in': ['SignInPage'],
      mail: ['MailCard'],
      storage: ['StorageArea'],
      'ai-provider': ['AiProviderArea'],
      'server-plugins': ['AdminPluginsCard'],
      shares: ['SharesCard'],
      accounts: ['AccountsCard', 'WhatYouSeeCard', 'AllKeysCard', 'AllSpacesCard'],
      log: ['LogCard'],
      about: ['AboutArea'],
    })
  })

  it('keeps the parts of the account page itself: profile, password, signing out everywhere, and signing out from the menu', async () => {
    await show('/settings/profile')
    expect(cards()).toEqual(['ProfileCard', 'SignOutCard'])
    await hide()
    await show('/settings/security')
    expect(cards()).toEqual(['SecurityCard'])
    await hide()
  })
})

describe('the addresses of before', () => {
  it.each([
    ['/account', '/settings/profile'],
    ['/account?tab=profile', '/settings/profile'],
    ['/account?tab=security', '/settings/security'],
    ['/account?tab=notify', '/settings/notifications'],
    ['/account?tab=ai', '/settings/ai'],
    ['/account?tab=ai#ai', '/settings/ai#ai'],
    ['/account?tab=plugins', '/settings/plugins'],
    ['/account#mcp', '/settings/connections#mcp'],
    ['/account#api-tokens', '/settings/connections#api-tokens'],
    ['/account#calendar', '/settings/connections#calendar'],
    ['/account#plugins', '/settings/plugins#plugins'],
    ['/account#mail', '/settings/profile#mail'],
    ['/account?linked=entra', '/settings/security?linked=entra'],
    ['/account?error=oidc_subject_taken', '/settings/security?error=oidc_subject_taken'],
    ['/settings?tab=general', '/settings/notes'],
    ['/settings?tab=looks', '/settings/appearance'],
    ['/settings?tab=spaces', '/settings/spaces'],
    ['/settings?tab=server', '/settings/accounts'],
    ['/settings?tab=server&sub=accounts', '/settings/accounts'],
    ['/settings?tab=server&sub=signin', '/settings/sign-in'],
    ['/settings?tab=server&sub=mail', '/settings/mail'],
    ['/settings?tab=server&sub=shares', '/settings/shares'],
    ['/settings?tab=server&sub=extensions', '/settings/ai-provider'],
    ['/settings?tab=server&sub=extensions#ai', '/settings/ai-provider#ai'],
    ['/settings?tab=server&sub=extensions#mcp', '/settings/server-connections#mcp'],
    ['/settings?tab=server&sub=extensions#plugins', '/settings/server-plugins#plugins'],
    ['/settings/extensions', '/settings/ai-provider'],
    ['/settings/extensions#api-tokens', '/settings/server-connections#api-tokens'],
    ['/settings/extensions#app-pairing', '/settings/server-connections#app-pairing'],
    // E67: the cards that left General, by the address of before (the cards' "Einrichten", saved links).
    ['/settings/general#nex-apps', '/settings/server-connections#nex-apps'],
    ['/settings/general#interfaces', '/settings/server-connections#interfaces'],
    ['/settings/general#mcp', '/settings/server-connections#mcp'],
    ['/settings/general#api-tokens', '/settings/server-connections#api-tokens'],
    ['/settings/general#app-pairing', '/settings/server-connections#app-pairing'],
    ['/settings/general#languages', '/settings/general#languages'],
    ['/settings/extensions#calendar', '/settings/general#calendar'],
    ['/settings?tab=server&sub=files', '/settings/general'],
    ['/settings?tab=server&sub=backups', '/settings/storage'],
    ['/settings?tab=server&sub=languages', '/settings/general'],
    ['/settings?tab=server&sub=log', '/settings/log'],
    ['/settings?tab=nonsense', '/settings/profile'],
    ['/settings/nonsense', '/settings/profile'],
    ['/about', '/settings/about'],
  ])('%s leads to %s', async (from, to) => {
    await show(from)
    expect(where()).toBe(to)
    await hide()
  })

  it('sends a member who asks for an area of the server to the profile', async () => {
    asked.role = 'member'
    await show('/settings/accounts')
    expect(where()).toBe('/settings/profile')
    await hide()
    await show('/settings?tab=server&sub=backups')
    expect(where()).toBe('/settings/profile')
    await hide()
  })
})

describe('Server › Connections (E67)', () => {
  it('holds "Andere nex-Apps", then "Schnittstellen" with the MCP settings, titled by the kit; General no longer has them', async () => {
    await show('/settings/general#nex-apps')
    expect(where()).toBe('/settings/server-connections#nex-apps')
    expect(current()).toBe('/settings/server-connections')
    expect(box.querySelector('h1')?.textContent).toBe(areaText(NEXUI_TEXTS.en, 'server-connections', { app: 'nexlore' })!.title)
    expect(box.querySelector('[data-testid="settings-area-server-connections"] p')!.textContent).toBe(
      areaText(NEXUI_TEXTS.en, 'server-connections', { app: 'nexlore' })!.text,
    )
    expect(cards()).toEqual(['AppsOperator', 'InterfacesCard'])
    // The interfaces keep everything they had: the documentation and the operator's MCP settings after "MCP-Zugang".
    const interfaces = seen.InterfacesCard as { docsHref?: string; after?: { mcp?: unknown } }
    expect(interfaces.docsHref).toBeTruthy()
    expect(interfaces.after?.mcp).toBeTruthy()
    await hide()
    await show('/settings/general#interfaces')
    expect(where()).toBe('/settings/server-connections#interfaces')
    await hide()
    await show('/settings/general')
    expect(cards()).not.toContain('AppsOperator')
    expect(cards()).not.toContain('InterfacesCard')
    await hide()
  })

  it('stays closed to a member, who lands on the profile', async () => {
    asked.role = 'member'
    await show('/settings/general#nex-apps')
    expect(where()).toBe('/settings/profile')
    await hide()
    await show('/settings/server-connections')
    expect(where()).toBe('/settings/profile')
    await hide()
  })
})

describe('Server › General names its cards', () => {
  it('in the line under the title only the shared cards nexlore has there, in their order (ui 1.1.3, U-3)', async () => {
    await show('/settings/general')
    const line = box.querySelector('[data-testid="settings-area-general"] p')!.textContent
    expect(line).toBe(areaText(NEXUI_TEXTS.en, 'general', { app: 'nexlore', parts: GENERAL_PARTS })!.text)
    // Since E67 the parts are the kit's plain line; the interfaces and the other nex apps are not named any more.
    expect(line).toBe(areaText(NEXUI_TEXTS.en, 'general', { app: 'nexlore' })!.text)
    expect(line).not.toMatch(/interfaces|nex apps/i)
    // The parts are the cards on the page, in the same order.
    const part: Record<string, string> = { FilesSettingsCard: 'limits', FeaturesCard: 'features', LanguagesCard: 'languages' }
    expect(cards().flatMap((card) => (card && part[card] ? [part[card]] : []))).toEqual([...GENERAL_PARTS])
    await hide()
  })
})

describe('server settings that could not be loaded', () => {
  it('say so where their cards would stand, with a retry, instead of the cards silently missing', async () => {
    serverSettings.failed = true
    await show('/settings/general')
    const notice = box.querySelector('[data-testid="server-settings-failed"]')
    expect(notice?.textContent).toContain('admin.settingsFailed')
    expect(cards()).not.toContain('FeaturesCard')
    expect(cards()).toContain('FilesSettingsCard')
    await act(async () => (box.querySelector('[data-testid="server-settings-retry"]') as HTMLButtonElement).click())
    expect(serverSettings.retries).toBe(1)
    await hide()
    for (const area of ['sign-in', 'server-plugins', 'shares']) {
      await show(`/settings/${area}`)
      expect(box.querySelector('[data-testid="server-settings-failed"]'), area).not.toBeNull()
      await hide()
    }
  })

  it('show no message once they are there', async () => {
    await show('/settings/general')
    expect(box.querySelector('[data-testid="server-settings-failed"]')).toBeNull()
    expect(cards()).toContain('FeaturesCard')
    await hide()
  })
})
