/** Tabs for notes: which tab a note goes into, which one comes to the front when one closes, and what is forgotten. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ownKey } from './accountStorage'
import { closeOtherTabs, closeTab, followTab, forgetTabs, MAX_TABS, moveTab, openInTab, pinTab, readPinned, readTabs } from './tabs'

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
    localStorage.setItem(ownKey('nexlore.tabs'), '{"paths": [3, "", "ok.md"], "active": 9}')
    expect(readTabs()).toEqual({ paths: ['ok.md'], active: 0 })
    localStorage.setItem(ownKey('nexlore.tabs'), 'not json')
    expect(readTabs()).toEqual({ paths: [], active: 0 })
  })

  it('keeps a pinned tab: it stands left, and a note opened from it comes in a tab of its own', () => {
    const go = vi.fn()
    followTab('A/one.md')
    openInTab('A/two.md', go)
    openInTab('A/three.md', go)
    pinTab('A/three.md', true)
    expect(readPinned()).toEqual(['A/three.md'])
    expect(readTabs()).toEqual({ paths: ['A/three.md', 'A/one.md', 'A/two.md'], active: 0 })
    // Shown in front and pinned: the next note does not replace it.
    followTab('A/four.md')
    expect(readTabs()).toEqual({ paths: ['A/three.md', 'A/four.md', 'A/one.md', 'A/two.md'], active: 1 })
    // Not pinned: replaced as before.
    followTab('A/five.md')
    expect(readTabs().paths).toEqual(['A/three.md', 'A/five.md', 'A/one.md', 'A/two.md'])
    // Let go again: after the pinned ones (none left, so first stays first), still in front if it was.
    pinTab('A/three.md', false)
    expect(readPinned()).toEqual([])
  })

  it('moves a tab within its part of the row, and closing the others keeps the pinned', () => {
    const go = vi.fn()
    followTab('A/one.md')
    for (const name of ['two', 'three', 'four']) openInTab(`A/${name}.md`, go)
    pinTab('A/four.md', true)
    expect(readTabs().paths).toEqual(['A/four.md', 'A/one.md', 'A/two.md', 'A/three.md'])
    moveTab('A/three.md', 1)
    expect(readTabs().paths).toEqual(['A/four.md', 'A/three.md', 'A/one.md', 'A/two.md'])
    // A tab that is not pinned cannot go before a pinned one, a pinned one not behind the others.
    moveTab('A/two.md', 0)
    expect(readTabs().paths[0]).toBe('A/four.md')
    moveTab('A/four.md', 3)
    expect(readTabs().paths[0]).toBe('A/four.md')
    // The one in front stays in front while the row changes.
    const front = readTabs().paths[readTabs().active]
    moveTab('A/one.md', 3)
    expect(readTabs().paths[readTabs().active]).toBe(front)
    closeOtherTabs('A/one.md')
    expect(readTabs()).toEqual({ paths: ['A/four.md', 'A/one.md'], active: 1 })
    // Closing a pinned tab lets go of it too: opened again, it is an ordinary tab.
    closeTab('A/four.md', 'A/one.md')
    expect(readPinned()).toEqual([])
    openInTab('A/four.md', go)
    expect(readPinned()).toEqual([])
  })
})
