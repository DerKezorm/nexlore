import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ACCOUNT_KEYS, forgetSharedKeys, setStorageOwner } from './accountStorage'
import { readFolds, toggleFold } from './folds'
import { openInTab, pinTab, readPinned, readTabs } from './tabs'

describe('what the browser remembers belongs to the account', () => {
  let memory: Map<string, string>
  beforeEach(() => {
    memory = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    })
  })
  afterEach(() => setStorageOwner(null))

  it('shows the next account on the same browser nothing of the one before', () => {
    const go = vi.fn()
    setStorageOwner(1)
    openInTab('Private/Epsilon.md', go)
    pinTab('Private/Epsilon.md', true)
    toggleFold('Private/Epsilon.md', 'h2:Secret plan#0')

    setStorageOwner(2)
    expect(readTabs().paths).toEqual([])
    expect(readPinned()).toEqual([])
    expect(readFolds('Private/Epsilon.md').size).toBe(0)
    // No stored value anywhere names the other account's note, except under its own keys.
    const shared = [...memory.keys()].filter((key) => !key.endsWith('.1'))
    expect(shared.filter((key) => (localStorage.getItem(key) ?? '').includes('Epsilon'))).toEqual([])

    setStorageOwner(1)
    expect(readTabs().paths).toEqual(['Private/Epsilon.md'])
  })

  it('drops the values from before, when every account of the browser shared them', () => {
    for (const key of ACCOUNT_KEYS) localStorage.setItem(key, '"Private/Epsilon.md"')
    localStorage.setItem('nexlore.theme', 'dark')
    forgetSharedKeys()
    for (const key of ACCOUNT_KEYS) expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem('nexlore.theme')).toBe('dark')
  })
})
