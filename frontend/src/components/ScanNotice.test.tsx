import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IndexProgress } from '../api/client'
import { ScanNotice } from './ScanNotice'

let scan: IndexProgress = { running: false }
vi.mock('../state/store', () => ({ useStore: () => ({ scan }) }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) }),
}))

let root: Root | null = null
let host: HTMLDivElement | null = null

function shown(): string | null {
  host = document.createElement('div')
  document.body.append(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    root = createRoot(host!)
    root.render(<ScanNotice />)
  })
  return host.querySelector('[role="status"]')?.textContent ?? null
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

describe('the notice while the vault is read', () => {
  it('says nothing when no pass runs', () => {
    scan = { running: false }
    expect(shown()).toBeNull()
  })

  it('shows the counts to the operator', () => {
    scan = { running: true, phase: 'indexing', percent: 25, done: 2500, total: 10000 }
    const text = shown()
    expect(text).toContain('scan.counted')
    expect(text).toContain((2500).toLocaleString())
  })

  it('shows a share to everybody else', () => {
    scan = { running: true, phase: 'indexing', percent: 25 }
    expect(shown()).toContain('scan.share {"percent":25}')
  })

  it('says it in plain words before the count is known', () => {
    scan = { running: true, phase: 'walking', percent: null }
    expect(shown()).toContain('scan.plain')
  })
})
