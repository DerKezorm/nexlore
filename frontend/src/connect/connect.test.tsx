// @vitest-environment jsdom
/**
 * nexlore's side of the shared module verbinden 0.1.8 (B3, V42, V46): the card of nexnotes under Mein Konto ›
 * Verbindungen knows whether the signed-in account is the operator. Only the operator gets "Einrichten" where nexnotes
 * is not set up on this server; a member reads who does it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PartnerView } from '../vendor/nexverbinden'

let me: { role: string } | null = null
const asked: string[] = []

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de' } }) }))
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))
vi.mock('./request', () => ({
  leave: { to: () => undefined },
  connectRequest: async (path: string) => {
    asked.push(path)
    if (path.split('?')[0] === '/api/connect/partners') return [notSetUp]
    throw new Error(`no answer for ${path}`)
  },
}))

import { AppsArea } from './connect'

const notSetUp: PartnerView = {
  partner: 'nexnotes',
  state: 'none',
  address: '',
  address_from_operator: false,
  set_up: false,
  host: '',
  uses: [],
  grants: ['notes.add'],
  uses_levels: {},
  grants_levels: { 'notes.add': 'write' },
  account: null,
  since: null,
  ok_at: null,
  used_at: null,
  stale_since: null,
  problem: null,
  areas_used: [],
  areas_granted: null,
  legacy: null,
  version: null,
  areas_choice: [],
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let box: HTMLDivElement

beforeEach(() => {
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  asked.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  me = null
})

async function show() {
  await act(async () => {
    root.render(<AppsArea />)
  })
  // The card is closed at first: open it, as a person would.
  const head = box.querySelector('[data-testid="connection-nexnotes"] button, [data-testid^="connection"] button') as HTMLElement | null
  if (!box.querySelector('[data-testid="connection-not-set-up"]') && head) {
    await act(async () => {
      head.click()
    })
  }
}

const byTest = (id: string) => box.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('the card of nexnotes in nexlore (verbinden 0.1.8)', () => {
  it('gives the operator the way to set nexnotes up', async () => {
    me = { role: 'operator' }
    await show()
    expect(asked).toContain('/api/connect/partners')
    expect(byTest('connection-not-set-up')).not.toBeNull()
    expect(byTest('connection-set-up')?.getAttribute('href')).toBe('/settings/server-connections#nex-apps')
  })

  it('tells a member who sets it up, without the way there', async () => {
    me = { role: 'member' }
    await show()
    expect(byTest('connection-not-set-up')?.textContent).toContain('Der Betreiber')
    expect(byTest('connection-set-up')).toBeNull()
  })
})
