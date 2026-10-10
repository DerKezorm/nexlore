import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, type ServerSettings } from '../../api/client'

const save = vi.fn()

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  adminApi: { saveSettings: (...args: unknown[]) => save(...args) },
}))

import { SignInCard } from './SignInCards'

let root: Root | null = null
let host: HTMLDivElement | null = null

const SETTINGS = { public_url: 'https://old.example.org', password_login: true, two_factor_required: false } as ServerSettings

function show(): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    root = createRoot(host!)
    root.render(<SignInCard settings={SETTINGS} onChange={() => undefined} anyActive />)
  })
  return host
}

async function submitAddress(shown: HTMLDivElement): Promise<void> {
  const form = shown.querySelector('form')!
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  // jsdom has no modal dialog; the question inside it is what these tests look at.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  save.mockReset()
})

describe('the question when the public address changes (409 public_url_change)', () => {
  it('names the entries made by hand, and not the authentik ones, when only `hand` is set', async () => {
    save.mockRejectedValueOnce(new ApiError(409, 'public_url_change', { count: 0, address: '', hand: 2 }))
    const shown = show()
    await submitAddress(shown)
    const text = shown.querySelector('[data-testid="address-question"]')?.textContent ?? ''
    expect(text).toContain('oidc.admin.addressChangeHand')
    expect(text).not.toContain('oidc.admin.addressChangeConfirm')
  })

  it('names the authentik entries, and not the ones by hand, when only `count` is set', async () => {
    save.mockRejectedValueOnce(
      new ApiError(409, 'public_url_change', { count: 1, address: 'https://old.example.org/x', hand: 0 }),
    )
    const shown = show()
    await submitAddress(shown)
    const text = shown.querySelector('[data-testid="address-question"]')?.textContent ?? ''
    expect(text).toContain('oidc.admin.addressChangeConfirm')
    expect(text).not.toContain('oidc.admin.addressChangeHand')
  })

  it('names both when both are set', async () => {
    save.mockRejectedValueOnce(new ApiError(409, 'public_url_change', { count: 1, address: 'https://a.example.org', hand: 3 }))
    const shown = show()
    await submitAddress(shown)
    const text = shown.querySelector('[data-testid="address-question"]')?.textContent ?? ''
    expect(text).toContain('oidc.admin.addressChangeConfirm')
    expect(text).toContain('oidc.admin.addressChangeHand')
  })
})
