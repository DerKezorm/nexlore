import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_OPTIONS, fileName, storedOptions, storeOptions } from './exportPdf'

describe('the options of the print dialog', () => {
  beforeEach(() => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    })
  })

  it('start from the defaults', () => {
    expect(storedOptions()).toEqual(DEFAULT_OPTIONS)
  })

  it('come back as chosen in this browser', () => {
    storeOptions({ ...DEFAULT_OPTIONS, paper: 'letter', landscape: true, links: 'text', font: 'serif' })
    expect(storedOptions()).toMatchObject({ paper: 'letter', landscape: true, links: 'text', font: 'serif' })
  })

  it('drop what is no option at all', () => {
    localStorage.setItem('nexlore.exportOptions', JSON.stringify({ paper: 'a3', landscape: 'yes', font: '<b>', extra: 1 }))
    expect(storedOptions()).toEqual(DEFAULT_OPTIONS)
    localStorage.setItem('nexlore.exportOptions', '{not json')
    expect(storedOptions()).toEqual(DEFAULT_OPTIONS)
  })
})

describe('the file name of a PDF', () => {
  it('is the name of the note or the folder', () => {
    expect(fileName({ path: 'Wissen/Homelab/Backup-Strategie.md' })).toBe('Backup-Strategie.pdf')
    expect(fileName({ folder: 'Wissen/Homelab' })).toBe('Homelab.pdf')
  })
})
