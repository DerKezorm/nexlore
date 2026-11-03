import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppDevice, AppPairing, AppPairingState } from '../api/client'
import { deviceName, minutesLeft } from '../lib/appPairing'

const calls = vi.hoisted(() => ({
  pair: vi.fn<(address: string) => Promise<AppPairing>>(),
  state: vi.fn<(id: string) => Promise<AppPairingState>>(),
  withdraw: vi.fn<(id: string) => Promise<void>>(),
  devices: vi.fn<() => Promise<AppDevice[]>>(),
  disconnect: vi.fn<(id: number) => Promise<void>>(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}))
vi.mock('../lib/errors', () => ({ errorText: (code: string) => `error:${code}` }))
vi.mock('../api/client', async (original) => {
  const real = await original<typeof import('../api/client')>()
  return { ...real, appApi: calls }
})

import { ApiError } from '../api/client'
import { AppDevices, POLL_MS } from './AppDevices'

const PAIRING: AppPairing = {
  id: 'p1',
  code: 'ABCD-EFGH',
  expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
  address: 'https://notes.example.com',
  link: 'nexlore://connect?address=x&pairing=p1&secret=s',
  qr_svg: '<svg viewBox="0 0 10 10" data-testid="qr"></svg>',
}
const POCKET: AppDevice = { id: 7, name: 'Pocket', created_at: '2026-11-01T10:00:00Z', last_seen_at: null }

let root: Root | null = null
let host: HTMLDivElement | null = null

async function show(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => {
    root = createRoot(host!)
    root.render(<AppDevices />)
  })
  return host
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => (element as HTMLElement).click())
}

function button(shown: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...shown.querySelectorAll('button')].find((candidate) => candidate.textContent === text)
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  for (const mock of Object.values(calls)) mock.mockReset()
  calls.devices.mockResolvedValue([])
  calls.withdraw.mockResolvedValue()
  calls.pair.mockResolvedValue(PAIRING)
  calls.state.mockResolvedValue({ state: 'waiting', device: '' })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.useRealTimers()
})

describe('the iPhone app on the account page', () => {
  it('lists the paired devices and disconnects one', async () => {
    calls.devices.mockResolvedValueOnce([POCKET, { ...POCKET, id: 8, name: 'Tablet', last_seen_at: '2026-11-02T08:00:00Z' }])
    calls.disconnect.mockResolvedValue()
    const shown = await show()
    const rows = shown.querySelectorAll('[data-testid="app-device"]')
    expect([...rows].map((row) => row.querySelector('.font-medium')?.textContent)).toEqual(['Pocket', 'Tablet'])
    expect(rows[0].textContent).toContain('account.app.never')
    expect(rows[1].textContent).toContain('account.app.seen')
    calls.devices.mockResolvedValueOnce([])
    await click(rows[0].querySelector('button'))
    expect(calls.disconnect).toHaveBeenCalledWith(7)
    expect(calls.devices).toHaveBeenCalledTimes(2)
    expect(shown.querySelector('[data-testid="app-devices"]')).toBeNull()
  })

  it('shows the code, the address and the QR code, and says when the app came', async () => {
    const shown = await show()
    await click(button(shown, 'account.app.connect'))
    expect(calls.pair).toHaveBeenCalledWith(window.location.origin)
    const card = shown.querySelector('[data-testid="app-pairing"]')!
    expect(card.getAttribute('data-state')).toBe('waiting')
    expect(shown.querySelector('[data-testid="app-pairing-code"]')?.textContent).toBe('ABCD-EFGH')
    expect(shown.querySelector('[data-testid="app-pairing-address"]')?.textContent).toBe('https://notes.example.com')
    expect(card.querySelector('svg[data-testid="qr"]')).not.toBeNull()
    expect(card.textContent).toContain('account.app.left {"count":10}')
    // Asked at its pace, not before.
    await tick(POLL_MS - 10)
    expect(calls.state).not.toHaveBeenCalled()
    await tick(10)
    expect(calls.state).toHaveBeenCalledWith('p1')
    calls.state.mockResolvedValue({ state: 'connected', device: 'Anna’s iPhone' })
    calls.devices.mockResolvedValue([POCKET])
    await tick(POLL_MS)
    expect(shown.querySelector('[data-testid="app-pairing"]')?.getAttribute('data-state')).toBe('connected')
    expect(shown.textContent).toContain('account.app.connected {"name":"Anna’s iPhone"}')
    expect(shown.querySelector('[data-testid="app-pairing-code"]')).toBeNull()
    expect(shown.querySelectorAll('[data-testid="app-device"]')).toHaveLength(1)
    // Connected, it stops asking, and closing withdraws nothing.
    const asked = calls.state.mock.calls.length
    await tick(POLL_MS * 3)
    expect(calls.state.mock.calls.length).toBe(asked)
    await click(button(shown, 'account.app.close'))
    expect(calls.withdraw).not.toHaveBeenCalled()
  })

  it('withdraws a pairing closed before the app came, and one left open when the page goes', async () => {
    const shown = await show()
    await click(button(shown, 'account.app.connect'))
    await click(button(shown, 'account.app.cancel'))
    expect(calls.withdraw).toHaveBeenCalledWith('p1')
    expect(shown.querySelector('[data-testid="app-pairing"]')).toBeNull()
    calls.withdraw.mockClear()
    await click(button(shown, 'account.app.connect'))
    act(() => root?.unmount())
    root = null
    expect(calls.withdraw).toHaveBeenCalledWith('p1')
  })

  it('offers a new code when the old one ran out', async () => {
    const shown = await show()
    await click(button(shown, 'account.app.connect'))
    calls.state.mockResolvedValue({ state: 'expired', device: '' })
    await tick(POLL_MS)
    expect(shown.textContent).toContain('account.app.expired')
    calls.pair.mockResolvedValue({ ...PAIRING, id: 'p2', code: 'JKLM-NPQR' })
    await click(button(shown, 'account.app.again'))
    expect(calls.withdraw).toHaveBeenCalledWith('p1')
    expect(shown.querySelector('[data-testid="app-pairing-code"]')?.textContent).toBe('JKLM-NPQR')
  })

  it('says why there is no pairing', async () => {
    calls.pair.mockRejectedValue(new ApiError(422, 'app_address_missing'))
    const shown = await show()
    await click(button(shown, 'account.app.connect'))
    expect(shown.querySelector('[role="alert"]')?.textContent).toBe('error:app_address_missing')
    expect(shown.querySelector('[data-testid="app-pairing"]')).toBeNull()
  })
})

describe('the small rules of pairing', () => {
  it('keeps a device name printable and short, iPhone when there is none', () => {
    expect(deviceName('  Anna’s iPhone ')).toBe('Anna’s iPhone')
    expect(deviceName('a\u0000b\u007fc')).toBe('abc')
    expect(deviceName('x'.repeat(100))).toHaveLength(80)
    expect(deviceName(null)).toBe('iPhone')
    expect(deviceName(' \n ')).toBe('iPhone')
  })

  it('counts whole minutes down to zero', () => {
    const now = Date.parse('2026-11-02T10:00:00Z')
    expect(minutesLeft('2026-11-02T10:10:00Z', now)).toBe(10)
    expect(minutesLeft('2026-11-02T10:00:01Z', now)).toBe(1)
    expect(minutesLeft('2026-11-02T09:59:00Z', now)).toBe(0)
  })
})
