import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotifyView } from '../api/client'

const VIEW: NotifyView = {
  choices: { email: false, mention: true, invite: true, approval: true, tokens: true, tasks: false, tasks_time: '08:00', operator: false },
  webhook: { set: false, host: '' },
  email: { possible: false, server: false, address: '' },
  operator: false,
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { role: 'member', email_proven: true } }) }))
vi.mock('../api/client', async (original) => {
  const real = await original<typeof import('../api/client')>()
  return { ...real, notifyApi: { get: () => Promise.resolve(VIEW), save: () => Promise.resolve(VIEW), test: () => Promise.resolve({}) } }
})

import { NotifySettings } from './NotifySettings'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('Which way', () => {
  it('has the row "iPhone and iPad", which says the app gets nothing and leads to its card under Connections', async () => {
    host = document.createElement('div')
    document.body.append(host)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      root = createRoot(host!)
      root.render(<NotifySettings />)
    })
    const ways = host.querySelector('#notify-ways')
    const box = ways?.querySelector('[data-testid="notify-devices-box"]')
    expect(box?.textContent).toContain('notify.devicesNote')
    expect(box?.querySelector('[data-testid="notify-devices"]')?.getAttribute('href')).toBe('/settings/connections#devices')
  })
})
