import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import de from '../i18n/de.json'
import en from '../i18n/en.json'

let me: { keys_need_second_factor?: boolean } | null = null

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

import { KeyFactorHint } from './KeyFactorHint'

let root: Root | null = null
let host: HTMLDivElement | null = null

function show(element: React.ReactElement): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    root = createRoot(host!)
    root.render(<MemoryRouter>{element}</MemoryRouter>)
  })
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  me = null
})

describe('the hint beside keys that wait for a second factor', () => {
  it('shows the sentence and the way to the setup while the account must still set one up', () => {
    me = { keys_need_second_factor: true }
    const shown = show(<KeyFactorHint />)
    const note = shown.querySelector('[data-testid="key-needs-factor"]')
    expect(note?.textContent).toContain('keyFactor.text')
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('/account?tab=security')
  })

  it('is small beside a key and says the same', () => {
    me = { keys_need_second_factor: true }
    const shown = show(<KeyFactorHint compact />)
    expect(shown.querySelector('[data-testid="key-needs-factor"]')?.className).toContain('text-xs')
  })

  it('says nothing to an account that needs nothing, or before the account is known', () => {
    me = { keys_need_second_factor: false }
    expect(show(<KeyFactorHint />).querySelector('[data-testid="key-needs-factor"]')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    me = null
    expect(show(<KeyFactorHint />).querySelector('[data-testid="key-needs-factor"]')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    me = {}
    expect(show(<KeyFactorHint />).querySelector('[data-testid="key-needs-factor"]')).toBeNull()
  })

  it('has the words of the order in both languages', () => {
    expect(en.keyFactor.text).toBe('Works only once you set up a second factor.')
    expect(de.keyFactor.text).toBe('Wirkt erst, wenn du einen zweiten Faktor einrichtest.')
  })
})
