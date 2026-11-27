/**
 * nexlore's own places in the operator's account list of the shared account module: no password set by the operator
 * (a link instead), no bringing back (deleting is for good), and deleting says what goes, with the spaces the account
 * was alone in; the spaces and what it uploaded as facts.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from '../../state/auth'
import { AccountsCard } from './AccountsList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values?.spaces ? `${key}:${String(values.spaces)}` : values?.used ? `${key}:${String(values.used)}` : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}))

const ME = { id: 1, name: 'robin', display_name: 'Robin', role: 'operator', sign_in: 'password', email: '', language: '', two_factor: false, avatar: null }
const ACCOUNTS = [
  { ...ME, two_factor_recovery_left: 0, created_at: '2026-11-01T10:00:00Z', last_seen_at: null, spaces: 1, locked: false, providers: [], has_password: true, storage_used: 0 },
  {
    id: 2, name: 'kim', display_name: 'Kim', role: 'member', sign_in: 'password', email: 'kim@example.com', email_confirmed: true, language: '',
    two_factor: false, avatar: null, created_at: '2026-11-02T10:00:00Z', last_seen_at: null, spaces: 2, locked: false, providers: [],
    has_password: true, storage_used: 2048,
  },
  {
    id: 3, name: 'lea', display_name: 'Lea', role: 'member', sign_in: 'password', email: '', language: '', two_factor: false, avatar: null,
    created_at: '2026-11-03T10:00:00Z', last_seen_at: null, spaces: 0, locked: false, providers: [], has_password: true, storage_used: 0,
    deleted: true, deleted_at: '2026-11-20T10:00:00Z', purge_at: '2099-12-20T10:00:00Z', storage_limit: null, ai_allowed: true,
  },
]

let shown: { root: HTMLDivElement; done: () => void } | null = null

async function settle() {
  for (let i = 0; i < 12; i++) await act(async () => await Promise.resolve())
}

async function show() {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const asked = String(input)
      const body =
        asked === '/api/setup' ? { needs_setup: false, signed_in: true, version: '1.16.0', min_password: 12 }
        : asked === '/api/auth/me' ? ME
        : asked === '/api/accounts' ? ACCOUNTS
        : asked === '/api/accounts/2/impact' ? { spaces: 2, alone: ['Garten'] }
        : []
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  const root = document.createElement('div')
  document.body.append(root)
  const react = createRoot(root)
  await act(async () => react.render(createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(AccountsCard)))))
  await settle()
  shown = { root, done: () => act(() => react.unmount()) }
  return root
}

afterEach(() => {
  shown?.done()
  shown?.root.remove()
  shown = null
  vi.unstubAllGlobals()
})

const buttons = (root: ParentNode) => [...root.querySelectorAll('button')]
const named = (root: ParentNode, text: string) => buttons(root).find((button) => button.textContent?.includes(text))

describe("nexlore's account list", () => {
  it('offers a link for a new password, never a password, and nothing to bring back while the account is there', async () => {
    const root = await show()
    const manage = root.querySelector('[data-testid="account-kim"] [data-testid="account-manage"]') as HTMLButtonElement
    await act(async () => manage.click())
    const dialog = document.querySelector('[data-testid="manage-dialog"]')!
    const words = buttons(dialog).map((button) => button.textContent)
    expect(words).toContain('account.resetLink')
    expect(words).not.toContain('account.restore')
    expect(words.some((word) => /password/i.test(word ?? '') && word !== 'account.resetLink')).toBe(false)
    expect(dialog.querySelector('[data-testid="fact-spaces"]')?.textContent).toContain('2')
    expect(dialog.querySelector('[data-testid="fact-storage"]')?.textContent).toContain('2 KB')
  })

  it('says on deleting what goes, the spaces it was alone in, and the 30 days to bring it back', async () => {
    const root = await show()
    await act(async () => (root.querySelector('[data-testid="account-kim"] [data-testid="account-manage"]') as HTMLButtonElement).click())
    await act(async () => named(document.querySelector('[data-testid="manage-dialog"]')!, 'account.remove')!.click())
    await settle()
    const text = document.body.textContent ?? ''
    expect(text).toContain('account.askRemove')
    expect(text).toContain('admin.accounts.removeWhat')
    expect(text).toContain('admin.accounts.removeAlone:Garten')
    // Since konten 1.1.0 deleting keeps the account 30 days to bring back, in nexlore too.
    expect(text).toContain('account.askRemoveDays')
    expect(text).not.toContain('account.askRemoveFinal')
  })

  it('brings a deleted account back and offers nothing else for it; storage limit and AI are per account', async () => {
    const root = await show()
    await act(async () => (root.querySelector('[data-testid="account-lea"] [data-testid="account-manage"]') as HTMLButtonElement).click())
    const gone = buttons(document.querySelector('[data-testid="manage-dialog"]')!).map((button) => button.textContent)
    expect(gone.filter((word) => word?.startsWith('account.') && word !== 'account.restore' && word !== 'common.close')).toEqual([])
    expect(gone).toContain('account.restore')
    await act(async () => (document.querySelector('[data-testid="manage-dialog"] button[aria-label="common.close"]') as HTMLButtonElement | null)?.click())
    shown?.done()
    shown?.root.remove()
    const again = await show()
    await act(async () => (again.querySelector('[data-testid="account-kim"] [data-testid="account-manage"]') as HTMLButtonElement).click())
    const dialog = document.querySelector('[data-testid="manage-dialog"]')!
    expect(buttons(dialog).map((button) => button.textContent)).toContain('account.storageLimit')
    expect(dialog.textContent).toContain('account.rightAi')
  })
})
