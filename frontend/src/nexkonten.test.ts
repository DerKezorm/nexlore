/**
 * Every text of the konten module is in the app, in German and English, through the app's own i18n, and the screens
 * show the module's fields in the module's order. Copied once by the module's `tools/sync.py` to
 * `frontend/src/nexkonten.test.ts`; then the app's file. Fill in the places marked APP.
 *
 * The module's own tests check the wording files word for word against the blueprint; this test checks that the
 * app really loads them (merged into its resources, `{{app}}`, `{{setupTokenEnv}}` and `{{minimum}}` filled in
 * through kontenVariables) and that nothing in the app overrides them. Since 0.3.7 it shows the app's screens
 * (APP_RENDER) and checks that every field is found by exactly its label and that the profile saves with one button;
 * this needs `@testing-library/dom` among the app's devDependencies and vitest's `environment: 'jsdom'`.
 */
import { fireEvent, getAllByRole, getByLabelText, queryByRole } from '@testing-library/dom'
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { AccountArea, type AccountPart } from './pages/AccountPage'
import { APP_CAPS as SHOWN_CAPS, APP_OWN_ACTIONS } from './pages/settings/accountList'
import { AccountsCard } from './pages/settings/AccountsList'
import { APP_PAGES as SHOWN_PAGES } from './pages/settings/accountPages'
import { AuthProvider } from './state/auth'
import {
  ACCOUNT_NAMESPACE,
  accountActions,
  BUTTONS,
  FIELDS,
  kontenVariables,
  MANAGE_DIALOG,
  MANAGE_GROUPS,
  NOT_ON_SELF,
  PAGES,
  pageOrder,
  PASSWORD_MIN,
  passwordChanged,
  SCREENS,
  screenFields,
  suggestUsername,
} from './vendor/nexkonten/konten'
import type { AccountCaps, AccountField, ListedAccount, OwnAction } from './vendor/nexkonten/konten'
import de from './vendor/nexkonten/konten.de.json'
import en from './vendor/nexkonten/konten.en.json'
// nexlore's i18n after its set-up (the module's files merged into the resources, interpolation.defaultVariables:
// kontenVariables(APP_NAME)); German loads on the way (`changeLanguage`), as in the app.
import i18n, { changeLanguage, startI18n } from './i18n'

beforeAll(async () => {
  // No server in a unit test: no languages added by an operator.
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  await startI18n()
  await changeLanguage('de')
  vi.unstubAllGlobals()
})

// APP: the app's name as its container is called.
const APP_NAME = 'nexlore'
// APP: the fields each screen of the app shows, top to bottom, by the module's field names (screenFields).
const APP_SCREENS: Partial<Record<keyof typeof SCREENS, readonly string[]>> = {
  setup: SCREENS.setup,
  invite: SCREENS.invite,
  login: SCREENS.login,
  forgot: SCREENS.forgot,
  reset: SCREENS.reset,
  profile: SCREENS.profile,
}

// APP (since 0.3.6): the parts of the app's pages "Profile" and "Security", top to bottom, by the module's part names
// (PAGES), then the app's own parts (e.g. nexmail 'googleMicrosoft', nexlore 'signOut', 'providers'), which always
// come after the module's.
const APP_PAGES: Record<keyof typeof PAGES, readonly string[]> = SHOWN_PAGES

/** A screen of the app shown in the document: the element that holds it, and how to take it away again. */
type Shown = { root: HTMLElement; unmount: () => void }

// APP (since 0.3.7): for every screen of APP_SCREENS, show it in the document as the app does (its own components,
// the server answered by the app's test helpers, e.g. a stubbed fetch), wait until it has loaded, and give its root.
// `profile` is the page "Profile" of an account with a password. In German: the tests below switch to 'de' first.
const APP_RENDER: Partial<Record<keyof typeof SCREENS, () => Promise<Shown>>> = {
  setup: () => show('/setup', '/setup', 'SetupPage', { setup: { needs_setup: true, signed_in: false } }),
  invite: () => show('/invite/:token', '/invite/abc', 'InvitePage', {
    invite: { space: null, role: null, by: 'Robin', email: '', display_name: '', min_password: PASSWORD_MIN, password: true, signed_in_as: null },
  }),
  login: () => show('/login', '/login', 'LoginPage'),
  forgot: () => show('/forgot', '/forgot', 'ForgotPage'),
  reset: () => show('/reset/:token', '/reset/abcdefghijklmnopqrstuvwxyz', 'ResetPage', {
    reset: { name: 'Anna', min_password: PASSWORD_MIN, expires_at: '2026-12-01T00:00:00Z' },
  }),
  profile: () => show('/settings/profile', '/settings/profile', createElement(AccountArea as ComponentType<{ part: AccountPart }>, { part: 'profile' }), { me: ME }),
}

// nexlore (since 0.3.8): the page "Security" of an account with a password.
const APP_PAGE_RENDER: { security?: () => Promise<Shown> } = {
  security: () => show('/settings/security', '/settings/security', createElement(AccountArea as ComponentType<{ part: AccountPart }>, { part: 'security' }), { me: ME }),
}

// nexlore (since 0.3.8): the text keys of the buttons nexlore words itself, by their role in BUTTONS.
const APP_BUTTON_WORDS: Partial<Record<keyof typeof BUTTONS, string>> = {
  signIn: 'auth.login.submit',
  setupSubmit: 'auth.setup.submit',
  inviteSubmit: 'auth.invite.create',
  resetSubmit: 'auth.reset.submit',
  signOut: 'me.signOut',
}

/** An account with a password, as the server gives it (`/api/auth/me`). */
const ME = {
  id: 1, name: 'anna', display_name: 'Anna', email: 'anna@example.com', role: 'member', sign_in: 'password', language: '',
  two_factor: false, two_factor_recovery_left: 0, version: '0.1.0', whats_new_seen: '0.1.0', min_password: PASSWORD_MIN,
}

/** The server's answers to the pages above; reading only, anything else an empty list. */
type Answers = { setup?: object; me?: object; invite?: object; reset?: object; accounts?: object[] }

/** Shows a page (one of AuthPages by name, or an element) at an address, with the server answered by a stubbed fetch,
 * and waits until it has loaded. */
async function show(path: string, at: string, page: string | ReactNode, answers: Answers = {}): Promise<Shown> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const setup = { needs_setup: false, code_required: true, signed_in: !!answers.me, version: '0.1.0', min_password: PASSWORD_MIN, ...answers.setup }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const asked = String(input)
      const body =
        asked === '/api/setup' ? setup
        : asked === '/api/auth/me' && answers.me ? answers.me
        : asked === '/api/auth/methods' ? { password: true, providers: [], forgot_mail: true }
        : asked.startsWith('/api/invite/') ? answers.invite
        : asked.startsWith('/api/reset/') ? answers.reset
        : asked === '/api/accounts' ? answers.accounts
        : undefined
      const status = body === undefined && asked === '/api/auth/me' ? 401 : 200
      return new Response(JSON.stringify(body ?? []), { status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  const element = typeof page === 'string' ? createElement((await import('./pages/AuthPages'))[page as 'LoginPage']) : page
  const root = document.createElement('div')
  document.body.append(root)
  const react = createRoot(root)
  await act(async () =>
    react.render(
      createElement(MemoryRouter, { initialEntries: [at] }, createElement(AuthProvider, null, createElement(Routes, null, createElement(Route, { path, element })))),
    ),
  )
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
  return {
    root,
    unmount: () => {
      act(() => react.unmount())
      root.remove()
      vi.unstubAllGlobals()
    },
  }
}

// nexlore (since 0.3.9): what its server can do for the operator in the account list (no own button in the dialog
// "Manage": the rights per space are the card "All spaces"), exactly as the page passes them to accountActions.
const APP_CAPS: AccountCaps = SHOWN_CAPS
const APP_OWN: readonly OwnAction[] = APP_OWN_ACTIONS

// nexlore (since 0.3.9): the operator's account list, signed in as the operator, the own account first and Kim with an
// address, an authenticator and a provider labelled 'Pocket ID' last.
const APP_ACCOUNTS_RENDER: { list?: () => Promise<Shown> } = {
  list: () => show('/settings/accounts', '/settings/accounts', createElement(AccountsCard), { me: operatorMe(), accounts: ACCOUNTS }),
}

/** The operator signed in, and the list the server gives: the operator first, Kim with everything last. */
function operatorMe() {
  return { ...ME, id: 1, name: 'robin', display_name: 'Robin', role: 'operator', mail: false }
}
const ACCOUNTS = [
  { id: 1, name: 'robin', display_name: 'Robin', email: 'robin@example.com', role: 'operator', sign_in: 'password', language: '', two_factor: false,
    created_at: '2026-11-01T10:00:00Z', last_seen_at: '2026-11-25T10:00:00Z', locked: false, blocked: false, blocked_at: null, deleted_at: null,
    purge_at: null, has_password: true, providers: [], storage_used: 1024, spaces: 2 },
  { id: 2, name: 'kim', display_name: 'Kim', email: 'kim@example.com', email_confirmed: true, role: 'member', sign_in: 'password', language: '',
    two_factor: true, passkeys: 1, created_at: '2026-11-02T10:00:00Z', last_seen_at: null, locked: false, blocked: false, blocked_at: null,
    deleted_at: null, purge_at: null, has_password: true, providers: [{ id: 7, slug: 'pocket', label: 'Pocket ID', managed: '' }],
    storage_used: 2048, spaces: 1 },
]

type Tree = { [key: string]: string | Tree }

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name
    return typeof value === 'string' ? [[key, value] as [string, string]] : leaves(value, key)
  })
}

// Every value a text of the module asks for (since 0.3.10 also name, day and providers, the words of 0.3.9).
const values = { username: 'kim', email: 'kim@example.com', provider: 'Pocket ID', name: 'Kim', day: '25.11.2026', providers: 'Pocket ID, Entra' }
const fill: Record<string, string | number> = { ...kontenVariables(APP_NAME), ...values }
/** Plural keys (``days_one``, ``recoveryLeft_other``) are asked by their base with a count that picks them. */
const PLURAL = /_(one|other)$/
const COUNTS: Record<string, number> = { one: 1, other: 5 }

describe('the konten texts', () => {
  for (const [language, tree] of [['de', de], ['en', en]] as const) {
    it(`are all in the app in ${language}, word for word`, async () => {
      await changeLanguage(language)
      for (const [key, text] of leaves(tree as Tree)) {
        const plural = PLURAL.exec(key)
        const count = plural ? COUNTS[plural[1] ?? 'other'] : undefined
        const given: Record<string, string | number> = count === undefined ? { ...fill } : { ...fill, count }
        const expected = text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(given[name] ?? ''))
        const asked = plural ? key.replace(PLURAL, '') : key
        expect(i18n.t(asked, count === undefined ? values : { ...values, count }), key).toBe(expected)
      }
    })

    it(`keep the namespace account to the module in ${language}, no text of the app's own there (since 0.3.10)`, () => {
      const module = new Set(leaves(tree as Tree).map(([key]) => key))
      const data = (i18n.getDataByLanguage(language) ?? {}) as Record<string, Tree>
      for (const [namespace, resources] of Object.entries(data)) {
        const own = namespace === ACCOUNT_NAMESPACE ? resources : resources[ACCOUNT_NAMESPACE]
        if (own === undefined || typeof own === 'string') continue
        const extra = leaves(own, ACCOUNT_NAMESPACE).map(([key]) => key).filter((key) => !module.has(key))
        expect(extra, `${namespace}: the app's own keys under ${ACCOUNT_NAMESPACE}`).toEqual([])
      }
    })
  }
})

describe('the konten screens', () => {
  it('show the fields of the module in its order', () => {
    for (const [screen, fields] of Object.entries(APP_SCREENS)) {
      expect(fields, screen).toEqual(screenFields(screen as keyof typeof SCREENS).map((entry) => entry.field))
    }
  })

  it('suggest the username the server would', () => {
    expect(suggestUsername('Max Müller')).toBe('max-mueller')
  })
})

describe('the konten pages (since 0.3.6)', () => {
  it("show the module's parts first, in its order, and the app's own after them", () => {
    for (const page of Object.keys(PAGES) as (keyof typeof PAGES)[]) {
      const module = pageOrder(page)
      const shown = APP_PAGES[page]
      expect(shown.slice(0, module.length), page).toEqual(module)
      for (const own of shown.slice(module.length)) expect(module, `${page}: ${own}`).not.toContain(own)
    }
  })

  it("title every part with the module's texts", async () => {
    await changeLanguage('de')
    expect(i18n.t('account.sessions')).toBe('Angemeldete Geräte')
    expect(i18n.t('account.signOutEverywhere')).toBe('Überall sonst abmelden')
    expect(i18n.t('account.stateOff')).toBe('Aus')
    expect(i18n.t('account.pictureUpload')).toBe('Profilbild hochladen')
    for (const page of Object.values(PAGES)) {
      for (const part of page.parts) {
        const rules = 'rules' in part ? [part.rules] : []
        for (const key of [part.title, ...part.buttons, ...rules]) expect(i18n.exists(key), key).toBe(true)
      }
    }
    expect(i18n.t(PAGES.profile.saveButton)).toBe('Speichern')
  })
})

/** The texts of the elements ``aria-describedby`` names, one after the other. */
function description(field: HTMLElement): string {
  const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  return ids.map((id) => field.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
}

/** The field of a screen, found by exactly its label (getByLabelText fails on none and on more than one). */
function labelled(root: HTMLElement, field: AccountField): HTMLElement {
  return getByLabelText(root, i18n.t(FIELDS[field].label))
}

async function shown(screen: keyof typeof SCREENS): Promise<Shown> {
  await changeLanguage('de')
  const render = APP_RENDER[screen]
  if (!render) throw new Error(`APP_RENDER.${screen} is missing`)
  return render()
}

describe('the konten fields (since 0.3.7)', () => {
  for (const screen of Object.keys(APP_SCREENS) as (keyof typeof SCREENS)[]) {
    it(`${screen}: every field is found by exactly its label, its hints by aria-describedby`, async () => {
      const { root, unmount } = await shown(screen)
      try {
        for (const spec of screenFields(screen)) {
          const label = i18n.t(spec.label)
          const field = getByLabelText(root, label)
          const own = field.getAttribute('aria-label')
          expect(own === null || own === label, `${screen}.${spec.field}: aria-label`).toBe(true)
          const said = description(field)
          for (const hint of spec.hints) expect(said, `${screen}.${spec.field}: ${hint}`).toContain(i18n.t(hint))
        }
      } finally {
        unmount()
      }
    })
  }
})

describe('the profile saves with one button (since 0.3.7)', () => {
  it('has exactly one "Save" for display name, username and email', async () => {
    const { root, unmount } = await shown('profile')
    try {
      const fields = PAGES.profile.saveFields.map((field) => labelled(root, field))
      // The card: the closest element holding all three fields.
      let card: HTMLElement = fields[0] ?? root
      while (!fields.every((field) => card.contains(field)) && card.parentElement) card = card.parentElement
      expect(getAllByRole(card, 'button', { name: i18n.t(PAGES.profile.saveButton) })).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it('saves nothing when a field is changed and left', async () => {
    const { root, unmount } = await shown('profile')
    const sent = vi.spyOn(globalThis, 'fetch')
    try {
      for (const field of PAGES.profile.saveFields) {
        const input = labelled(root, field)
        fireEvent.focus(input)
        fireEvent.change(input, { target: { value: field === 'email' ? 'neu@example.com' : 'neu' } })
        fireEvent.focusOut(input)
        fireEvent.blur(input)
      }
      await new Promise((done) => setTimeout(done, 50))
      const writes = sent.mock.calls.filter(([input, init]) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        return method.toUpperCase() !== 'GET'
      })
      expect(writes).toEqual([])
    } finally {
      sent.mockRestore()
      unmount()
    }
  })
})

/** What a button says: its text without the symbol (an `svg` has no text). */
function said(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('every button of the account pages has its kind and symbol (since 0.3.8)', () => {
  const screens: [string, (() => Promise<Shown>) | undefined][] = [
    ...(Object.keys(APP_SCREENS) as (keyof typeof SCREENS)[]).map((screen) => [screen, APP_RENDER[screen]] as [string, (() => Promise<Shown>) | undefined]),
    ['security', APP_PAGE_RENDER.security],
  ]
  for (const [screen, render] of screens) {
    it(`${screen}: kind and symbol as BUTTONS says, no button without them`, async () => {
      if (!render) throw new Error(`no render for ${screen}`)
      await changeLanguage('de')
      const { root, unmount } = await render()
      try {
        const words = new Map<string, keyof typeof BUTTONS>()
        for (const name of Object.keys(BUTTONS) as (keyof typeof BUTTONS)[]) {
          const own = APP_BUTTON_WORDS[name]
          const text = name.includes('.') ? i18n.t(name, { name: 'Pocket ID', provider: 'Pocket ID' }) : own && i18n.t(own)
          if (text && !words.has(text)) words.set(text, name)
        }
        let found = 0
        for (const element of Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [data-kind]'))) {
          const name = words.get(said(element))
          if (!name) continue
          found += 1
          const spec = BUTTONS[name]
          expect(element.getAttribute('data-kind'), `${screen}: ${said(element)}`).toBe(spec.kind)
          expect(element.getAttribute('data-icon'), `${screen}: ${said(element)}`).toBe(spec.icon)
        }
        expect(found, `${screen}: no button of BUTTONS found`).toBeGreaterThan(0)
      } finally {
        unmount()
      }
    })
  }
})

/** Every account the tests ask accountActions about: the operator's own, another with everything, blocked, deleted. */
function sample(change: Partial<ListedAccount> = {}): ListedAccount {
  return {
    id: 2,
    username: 'kim',
    displayName: 'Kim',
    email: 'kim@example.com',
    emailConfirmed: true,
    operator: false,
    self: false,
    hasPassword: true,
    authenticator: true,
    passkeys: 1,
    providers: [{ id: 7, label: 'Pocket ID' }],
    blocked: false,
    lastSeenAt: null,
    ...change,
  }
}

/** The words of every button of BUTTONS as the app says them (the provider named 'Pocket ID'), the app's own too. */
function buttonWords(): Map<string, keyof typeof BUTTONS> {
  const words = new Map<string, keyof typeof BUTTONS>()
  for (const name of Object.keys(BUTTONS) as (keyof typeof BUTTONS)[]) {
    const own = APP_BUTTON_WORDS[name]
    const text = name.includes('.') ? i18n.t(name, { name: 'Pocket ID', provider: 'Pocket ID' }) : own && i18n.t(own)
    if (text && !words.has(text)) words.set(text, name)
  }
  for (const entry of APP_OWN) {
    if (entry.group !== 'rights' && !words.has(i18n.t(entry.label))) words.set(i18n.t(entry.label), entry.button)
  }
  return words
}

/** Checks kind and symbol of every button in an element whose words are a button of BUTTONS; gives how many. */
function checkButtons(root: HTMLElement, where: string): number {
  const words = buttonWords()
  let found = 0
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [data-kind]'))) {
    const name = words.get(said(element))
    if (!name) continue
    found += 1
    expect(element.getAttribute('data-kind'), `${where}: ${said(element)}`).toBe(BUTTONS[name].kind)
    expect(element.getAttribute('data-icon'), `${where}: ${said(element)}`).toBe(BUTTONS[name].icon)
  }
  return found
}

describe('the box Password says when it was changed last (since 0.3.10)', () => {
  it('shows "Last changed on …" or that it is not known, on the page "Security"', async () => {
    const render = APP_PAGE_RENDER.security
    if (!render) throw new Error('APP_PAGE_RENDER.security is missing')
    await changeLanguage('de')
    const { root, unmount } = await render()
    try {
      const text = (root.textContent ?? '').replace(/\s+/g, ' ')
      const known = i18n.t(passwordChanged('x').text, { day: '' }).trim()
      const unknown = i18n.t(passwordChanged(null).text)
      expect(text.includes(known) || text.includes(unknown), `"${known}" or "${unknown}"`).toBe(true)
    } finally {
      unmount()
    }
  })
})

describe('the account list and its dialog "Manage" (since 0.3.9)', () => {
  it('never offers on the own account what belongs in the profile', () => {
    for (const row of [sample({ self: true, operator: true }), sample({ self: true, operator: true, blocked: true })]) {
      const names = accountActions(row, APP_CAPS, APP_OWN).map((action) => action.name.split(':')[0])
      for (const forbidden of NOT_ON_SELF) expect(names, forbidden).not.toContain(forbidden)
      for (const entry of APP_OWN) if (entry.notSelf) expect(names, entry.name).not.toContain(entry.name)
    }
  })

  it("takes every button of the dialog, the app's own too, with its kind and symbol from BUTTONS", () => {
    const rows = [sample(), sample({ blocked: true, operator: true }), sample({ deletedAt: '2026-11-25T10:00:00Z', purgeAt: '2026-12-25T10:00:00Z' })]
    for (const row of rows) {
      for (const action of accountActions(row, APP_CAPS, APP_OWN)) {
        if (action.type !== 'button') continue
        expect(action.button in BUTTONS, action.name).toBe(true)
        expect([action.kind, action.icon], action.name).toEqual([BUTTONS[action.button].kind, BUTTONS[action.button].icon])
      }
    }
  })

  it('shows one row per account with "Manage", and the dialog with its groups in order, every button as BUTTONS says', async () => {
    const render = APP_ACCOUNTS_RENDER.list
    if (!render) throw new Error('APP_ACCOUNTS_RENDER.list is missing')
    await changeLanguage('de')
    const { root, unmount } = await render()
    try {
      expect(checkButtons(root, 'list'), 'list: no button of BUTTONS found').toBeGreaterThan(0)
      const manage = Array.from(root.querySelectorAll<HTMLElement>('button')).filter((button) => said(button) === i18n.t('account.manage'))
      expect(manage.length, 'one "Verwalten" per account').toBeGreaterThan(1)
      fireEvent.click(manage[manage.length - 1] as HTMLElement)
      await new Promise((done) => setTimeout(done, 50))
      const title = i18n.t('account.manageTitle', { name: '' }).trim()
      const dialog = getAllByRole(document.body, 'dialog').find((element) => (element.textContent ?? '').includes(title))
      if (!dialog) throw new Error('the dialog "Manage" did not open')
      expect(checkButtons(dialog, 'manage'), 'manage: no button of BUTTONS found').toBeGreaterThan(0)
      const titles = MANAGE_GROUPS.map((group) => i18n.t(MANAGE_DIALOG.groups[group].title))
      const shown = Array.from(dialog.querySelectorAll('h3'))
        .map((heading) => heading.textContent ?? '')
        .filter((text) => titles.includes(text))
      expect(shown.length, 'the dialog shows its groups').toBeGreaterThan(0)
      expect(shown, 'groups in their order').toEqual(titles.filter((text) => shown.includes(text)))
      expect(queryByRole(dialog, 'menu'), 'no menu in the dialog').toBeNull()
    } finally {
      unmount()
    }
  })
})
