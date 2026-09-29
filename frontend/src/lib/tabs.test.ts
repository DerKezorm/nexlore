/** Tabs for notes: which tab a note goes into, which one comes to the front when one closes, and what is forgotten. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { closeTab, followTab, forgetTabs, MAX_TABS, openInTab, readTabs } from './tabs'

beforeEach(() => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  })
})

describe('tabs', () => {
  it('shows a note in the tab in front, and a tab that holds it already comes to the front', () => {
    followTab('A/one.md')
    followTab('A/two.md')
    expect(readTabs()).toEqual({ paths: ['A/two.md'], active: 0 })
    const go = vi.fn()
    openInTab('A/three.md', go)
    expect(go).toHaveBeenCalledWith('/note/A/three.md')
    expect(readTabs()).toEqual({ paths: ['A/two.md', 'A/three.md'], active: 1 })
    followTab('A/two.md')
    expect(readTabs().active).toBe(0)
    // A new one goes right after the tab in front.
    openInTab('A/four.md', go)
    expect(readTabs()).toEqual({ paths: ['A/two.md', 'A/four.md', 'A/three.md'], active: 1 })
  })

  it('closing the tab in front shows the one to its right, else to its left; another one changes nothing shown', () => {
    const go = vi.fn()
    for (const path of ['a.md', 'b.md', 'c.md']) openInTab(path, go)
    followTab('b.md')
    expect(closeTab('b.md')).toEqual({ front: true, next: 'c.md' })
    expect(readTabs()).toEqual({ paths: ['a.md', 'c.md'], active: 1 })
    expect(closeTab('c.md')).toEqual({ front: true, next: 'a.md' })
    openInTab('d.md', go)
    expect(closeTab('a.md')).toEqual({ front: false, next: null })
    expect(readTabs()).toEqual({ paths: ['d.md'], active: 0 })
    expect(closeTab('d.md')).toEqual({ front: true, next: null })
  })

  it('the note on the screen is in front, even before the mark has followed it', () => {
    const go = vi.fn()
    for (const path of ['a.md', 'b.md', 'c.md']) openInTab(path, go)
    followTab('a.md')
    // b.md is shown already (its tab was clicked), the mark still says a.md.
    expect(closeTab('b.md', 'b.md')).toEqual({ front: true, next: 'c.md' })
    expect(readTabs()).toEqual({ paths: ['a.md', 'c.md'], active: 1 })
    // Another one closed: what is shown stays in front.
    followTab('a.md')
    expect(closeTab('a.md', 'c.md')).toEqual({ front: false, next: null })
    expect(readTabs()).toEqual({ paths: ['c.md'], active: 0 })
  })

  it('forgets the tabs of a note or folder that went, but not the one in front, nor a neighbour with a like name', () => {
    const go = vi.fn()
    for (const path of ['S/Beds/x.md', 'S/Bedside.md', 'S/Beds.md', 'S/y.md']) openInTab(path, go)
    forgetTabs('S/Beds', 'S/y.md')
    expect(readTabs()).toEqual({ paths: ['S/Bedside.md', 'S/Beds.md', 'S/y.md'], active: 2 })
    // The note in front stays even when its folder went: the page follows it on its own.
    openInTab('S/Old/z.md', vi.fn())
    forgetTabs('S/Old', 'S/Old/z.md')
    expect(readTabs().paths).toContain('S/Old/z.md')
  })

  it('keeps at most so many tabs, the oldest going first', () => {
    const go = vi.fn()
    for (let i = 0; i <= MAX_TABS; i++) openInTab(`n${i}.md`, go)
    const tabs = readTabs()
    expect(tabs.paths).toHaveLength(MAX_TABS)
    expect(tabs.paths[0]).toBe('n1.md')
    expect(tabs.paths[tabs.active]).toBe(`n${MAX_TABS}.md`)
  })

  it('reads nothing broken from the storage', () => {
    localStorage.setItem('nexlore.tabs', '{"paths": [3, "", "ok.md"], "active": 9}')
    expect(readTabs()).toEqual({ paths: ['ok.md'], active: 0 })
    localStorage.setItem('nexlore.tabs', 'not json')
    expect(readTabs()).toEqual({ paths: [], active: 0 })
  })
})
