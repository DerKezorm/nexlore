import { describe, expect, it } from 'vitest'

import { comboOf, commandFor, refusal, shownCombo, withKey } from './shortcuts'

const press = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
})

describe('own keys', () => {
  it('names a press by the place of the key, modifiers in a fixed order', () => {
    expect(comboOf(press('KeyJ', 'j', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+J')
    // Alt with a letter on a Mac gives another character; the place stays.
    expect(comboOf(press('KeyJ', '∆', { altKey: true, metaKey: true, shiftKey: true }))).toBe('Alt+Shift+Meta+J')
    expect(comboOf(press('Digit1', '!', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1')
    expect(comboOf(press('F8', 'F8'))).toBe('F8')
    expect(comboOf(press('Period', '.', { ctrlKey: true }))).toBe('Ctrl+Period')
    // A modifier alone, or a key nexlore does not name, is no combination.
    expect(comboOf(press('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull()
    expect(comboOf(press('Escape', 'Escape', { ctrlKey: true }))).toBeNull()
  })

  it('refuses keys that would take typing, the browser\'s and nexlore\'s own', () => {
    expect(refusal('J')).toBe('modifier')
    expect(refusal('Shift+J')).toBe('modifier')
    expect(refusal('F8')).toBeNull()
    expect(refusal('Ctrl+Alt+J')).toBeNull()
    expect(refusal('Meta+J')).toBeNull()
    expect(refusal('Ctrl+W')).toBe('browser')
    expect(refusal('Ctrl+K')).toBe('taken')
    expect(refusal('Alt+T')).toBe('taken')
  })

  it('gives a combination to one command only, and takes it away again', () => {
    const one = withKey({}, 'go.tasks', 'Tasks', 'Ctrl+Alt+J')
    expect(one).toEqual({ 'go.tasks': { combo: 'Ctrl+Alt+J', label: 'Tasks' } })
    // The same keys for another command: the first loses them.
    const two = withKey(one, 'go.files', 'Files', 'Ctrl+Alt+J')
    expect(two).toEqual({ 'go.files': { combo: 'Ctrl+Alt+J', label: 'Files' } })
    expect(commandFor(two, 'Ctrl+Alt+J')).toBe('go.files')
    expect(commandFor(two, 'Ctrl+Alt+K')).toBeNull()
    // New keys for a command replace its old ones.
    const moved = withKey({ ...two, 'go.tasks': { combo: 'F8', label: 'Tasks' } }, 'go.tasks', 'Tasks', 'F9')
    expect(moved['go.tasks']).toEqual({ combo: 'F9', label: 'Tasks' })
    expect(withKey(moved, 'go.tasks', 'Tasks', null)).toEqual({ 'go.files': { combo: 'Ctrl+Alt+J', label: 'Files' } })
  })

  it('shows Meta as the Mac and Windows call it', () => {
    expect(shownCombo('Ctrl+Meta+J', true)).toBe('Ctrl + ⌘ + J')
    expect(shownCombo('Ctrl+Meta+J', false)).toBe('Ctrl + Win + J')
    // German keys as German keyboards name them, whichever way they were written (P5.25).
    expect(shownCombo('Ctrl+Shift+K', false, 'de')).toBe('Strg + Umschalt + K')
    expect(shownCombo('Strg+F', false, 'en')).toBe('Ctrl + F')
    expect(shownCombo('Alt+Shift+N', false, 'de')).toBe('Alt + Umschalt + N')
  })
})

describe('keys shown in the interface', () => {
  // Every component's source, to find keys written out by hand: "Ctrl P" in the account menu stayed English in the
  // German interface, where the family writes "Strg P".
  const sources = import.meta.glob('../**/*.tsx', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

  it('reads the components at all', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
  })

  it('writes no Ctrl by hand into a kbd, it goes through shownCombo or the language files', () => {
    const fixed = Object.entries(sources)
      .filter(([file]) => !file.includes('.test.'))
      .flatMap(([file, text]) => [...text.matchAll(/<kbd\b[^>]*>\s*(Ctrl|Strg|Control)\b/g)].map(() => file))
    expect(fixed).toEqual([])
  })

  it('writes Ctrl as Strg in German and keeps the rest of the combination', () => {
    expect(shownCombo('Ctrl P', false, 'de')).toBe('Strg P')
    expect(shownCombo('Ctrl P', false, 'en')).toBe('Ctrl P')
    expect(shownCombo('Ctrl Shift F', false, 'de')).toBe('Strg Umschalt F')
  })
})
