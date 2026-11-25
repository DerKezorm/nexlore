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

const stubs = vi.hoisted(() => (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, () => ({ $$typeof: Symbol.for('react.transitional.element'), type: 'section', key: null, props: { 'data-card': name }, _owner: null, _store: {} })])),
)

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../components/settings/AdminCards', async (original) => ({
  ...(await original()),
  ...stubs('AccountsCard', 'AiCard', 'AllSpacesCard', 'ApiTokensCard', 'CssCard', 'FilesSettingsCard', 'GuideCard', 'LanguagesCard', 'MailCard', 'McpCard', 'SharesCard'),
}))
vi.mock('../components/settings/AppearanceCard', () => stubs('AppearanceCard'))
vi.mock('../components/settings/AppPairingSwitch', () => stubs('AppPairingSwitch'))
vi.mock('../components/settings/CalendarFeed', () => stubs('CalendarFeedSwitch', 'CalendarFeed'))
vi.mock('../components/settings/EditorCard', () => stubs('EditorCard'))
vi.mock('../components/settings/KeysCard', () => stubs('KeysCard'))
vi.mock('../components/settings/LinkTitleSwitch', () => stubs('LinkTitleSwitch'))
vi.mock('../components/settings/LogCard', () => stubs('LogCard'))
vi.mock('./settings/StorageArea', () => stubs('StorageArea'))
vi.mock('../components/settings/SignInCards', () => stubs('SignInPart'))
vi.mock('../components/settings/SnippetsCard', () => stubs('SnippetsCard'))
vi.mock('../components/settings/SpacesCard', () => stubs('SpacesCard'))
vi.mock('../components/settings/StartCard', () => stubs('HomeSpaceCard', 'StartCard'))
vi.mock('../components/settings/ThemesCard', () => stubs('ThemesCard'))
vi.mock('../components/settings/useServerSettings', () => ({ useServerSettings: () => [{}, () => undefined] }))
vi.mock('../plugins/PluginSettings', () => stubs('AdminPluginsCard', 'MyPluginsCard'))
vi.mock('../components/AiAccess', () => stubs('AiAccess'))
vi.mock('../components/AppDevices', () => stubs('AppDevices'))
vi.mock('../components/ApiTokens', () => stubs('ApiTokens'))
vi.mock('../components/McpKeys', () => stubs('McpKeys'))
vi.mock('../components/NotifySettings', () => stubs('NotifySettings'))
// Profile and security as the shared account module lays them out (the cards of the profile and of the password, the
// second factor and the sessions, and signing out); the notices above them show nothing here.
vi.mock('./settings/AccountCards', () => ({ ...stubs('ProfileCard', 'SecurityCard', 'SignOutCard'), AccountNotices: () => null }))
vi.mock('./AboutPage', () => stubs('AboutArea'))
vi.mock('../components/Sidebar', () => stubs('SpacesSidebar'))
vi.mock('../api/client', async (original) => {
  const real = await original<typeof import('../api/client')>()
  return { ...real, authApi: { ...real.authApi, myProviders: async () => [] } }
})

const asked = vi.hoisted(() => ({ role: 'operator' as 'operator' | 'member' }))
vi.mock('../state/auth', () => ({
  useAuth: () => ({
    me: { id: 1, name: 'jule', display_name: 'Jule', role: asked.role, avatar: null, sign_in: 'password', email: '' },
    refresh: async () => undefined,
    signOut: async () => undefined,
  }),
}))

import { AREAS } from './settings/areas'
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
    expect(box.querySelector('main')!.querySelector('[data-testid="settings-jump"]')).not.toBeNull()
    expect([...nav().querySelectorAll('p[id^="settings-group-"]')].map((group) => group.textContent)).toEqual(['settings.groups.account', 'settings.groups.server'])
    expect(entries()).toEqual([...AREAS.map((area) => `/settings/${area.slug}`), '/settings/about'])
    expect(entries()).toEqual([
      '/settings/profile', '/settings/security', '/settings/appearance', '/settings/notes', '/settings/spaces', '/settings/notifications',
      '/settings/plugins', '/settings/connections', '/settings/general', '/settings/sign-in', '/settings/mail', '/settings/storage',
      '/settings/shares', '/settings/extensions', '/settings/accounts', '/settings/log', '/settings/about',
    ])
    expect(current()).toBe('/settings/profile')
    expect(box.querySelector('h1')?.textContent).toBe('settings.areas.profile.title')
    await hide()
  })

  it('shows a member only the own account and About', async () => {
    asked.role = 'member'
    await show('/settings')
    expect(entries()).toEqual([
      '/settings/profile', '/settings/security', '/settings/appearance', '/settings/notes', '/settings/spaces', '/settings/notifications',
      '/settings/plugins', '/settings/connections', '/settings/about',
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
    // Settings: Server
    'AccountsCard', 'AllSpacesCard', 'SignInPart', 'MailCard', 'SharesCard', 'ApiTokensCard', 'AppPairingSwitch', 'McpCard', 'CalendarFeedSwitch',
    'LinkTitleSwitch', 'AiCard', 'CssCard', 'AdminPluginsCard', 'LogCard', 'FilesSettingsCard', 'GuideCard', 'StorageArea', 'LanguagesCard',
    // My account
    'ProfileCard', 'SignOutCard', 'SecurityCard', 'AppDevices', 'NotifySettings', 'ApiTokens', 'AiAccess', 'McpKeys', 'CalendarFeed', 'MyPluginsCard',
    // About
    'AboutArea',
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
      appearance: ['ThemesCard', 'AppearanceCard', 'SnippetsCard'],
      notes: ['StartCard', 'EditorCard', 'HomeSpaceCard', 'KeysCard'],
      spaces: ['SpacesCard'],
      notifications: ['NotifySettings'],
      plugins: ['MyPluginsCard'],
      connections: ['AppDevices', 'ApiTokens', 'AiAccess', 'McpKeys', 'CalendarFeed'],
      general: ['FilesSettingsCard', 'LinkTitleSwitch', 'CssCard', 'LanguagesCard', 'GuideCard'],
      'sign-in': ['SignInPart'],
      mail: ['MailCard'],
      storage: ['StorageArea'],
      shares: ['SharesCard'],
      extensions: ['AiCard', 'ApiTokensCard', 'AppPairingSwitch', 'McpCard', 'CalendarFeedSwitch', 'AdminPluginsCard'],
      accounts: ['AccountsCard', 'AllSpacesCard'],
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
    ['/account?tab=ai', '/settings/connections'],
    ['/account?tab=ai#ai', '/settings/connections#ai'],
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
    ['/settings?tab=server&sub=extensions', '/settings/extensions'],
    ['/settings?tab=server&sub=extensions#ai', '/settings/extensions#ai'],
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
