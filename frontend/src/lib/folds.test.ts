import { beforeEach, describe, expect, it, vi } from 'vitest'

import { headingKind, itemKind, namer, readFolds, setFolds, toggleFold } from './folds'

beforeEach(() => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  })
})

describe('folds', () => {
  it('names a fold by what it folds, the same one twice by its place', () => {
    const name = namer()
    expect(name(headingKind(2, '  Set   up '))).toBe('h2:Set up#0')
    expect(name(headingKind(2, 'Set up'))).toBe('h2:Set up#1')
    expect(name(headingKind(3, 'Set up'))).toBe('h3:Set up#0')
    expect(name(itemKind('Groceries'))).toBe('l:Groceries#0')
  })

  it('keeps the folds per note, toggled one by one or set as a whole', () => {
    const heard: string[] = []
    window.addEventListener('nexlore:folds', (event) => heard.push((event as CustomEvent<string>).detail))
    toggleFold('A/one.md', 'h2:Setup#0')
    toggleFold('A/one.md', 'l:Groceries#0')
    expect([...readFolds('A/one.md')]).toEqual(['h2:Setup#0', 'l:Groceries#0'])
    expect(readFolds('A/two.md').size).toBe(0)
    toggleFold('A/one.md', 'h2:Setup#0')
    expect([...readFolds('A/one.md')]).toEqual(['l:Groceries#0'])
    setFolds('A/one.md', [])
    expect(readFolds('A/one.md').size).toBe(0)
    // Nothing left folded: the note is not remembered at all.
    expect(localStorage.getItem('nexlore.folds')).toBe('{}')
    expect(heard).toEqual(['A/one.md', 'A/one.md', 'A/one.md', 'A/one.md'])
  })

  it('forgets the notes folded longest ago when there are too many', () => {
    for (let n = 0; n < 305; n++) setFolds(`A/note-${n}.md`, ['h1:Top#0'])
    expect(readFolds('A/note-0.md').size).toBe(0)
    expect(readFolds('A/note-4.md').size).toBe(0)
    expect(readFolds('A/note-5.md').size).toBe(1)
    expect(readFolds('A/note-304.md').size).toBe(1)
  })
})
