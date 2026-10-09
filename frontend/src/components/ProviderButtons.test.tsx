import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderButtons } from './ProviderButtons'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${values.name}` : key) }),
}))

let root: Root | null = null
let host: HTMLDivElement | null = null

function show(element: React.ReactElement): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    root = createRoot(host!)
    root.render(element)
  })
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

const PROVIDERS = [
  { slug: 'authentik', label: 'authentik' },
  { slug: 'entra id', label: 'Microsoft' },
]

describe('the provider buttons', () => {
  it('stand in the order of the list, under the line "or", and lead to each start', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const shown = show(<ProviderButtons providers={PROVIDERS} />)
    const buttons = [...shown.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['oidc.login.button authentik', 'oidc.login.button Microsoft'])
    expect(shown.textContent).toContain('oidc.login.or')
    act(() => buttons[1].click())
    expect(assign).toHaveBeenCalledWith('/api/oidc/entra%20id/start')
  })

  it('take an invitation along and say "Continue with"', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const shown = show(<ProviderButtons providers={PROVIDERS} invite="key-1" withOr={false} />)
    expect(shown.textContent).not.toContain('oidc.login.or')
    const first = shown.querySelector('button')!
    expect(first.textContent).toBe('oidc.invite.button authentik')
    act(() => first.click())
    expect(assign).toHaveBeenCalledWith('/api/oidc/authentik/start?invite=key-1')
  })

  it('show nothing without a provider', () => {
    expect(show(<ProviderButtons providers={[]} />).textContent).toBe('')
  })
})
