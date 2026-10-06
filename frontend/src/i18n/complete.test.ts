/**
 * The shipped languages have exactly the same keys. English is the fallback for languages the operator adds, but
 * for the two shipped ones the fallback must never show: a German page with one English line is a bug.
 */

import { SHIPPED } from './index'
import whatsNewDe from './whatsnew/de.json'
import whatsNewEn from './whatsnew/en.json'

const files = import.meta.glob('./*.json', { eager: true, import: 'default' }) as Record<string, Record<string, unknown>>

function flatten(tree: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of flatten(value as Record<string, unknown>, path)) result.set(inner, innerValue)
    } else {
      result.set(path, value)
    }
  }
  return result
}

describe('shipped translations', () => {
  const names = Object.keys(files).sort()
  const languages = names.map((name) => flatten(files[name]))
  const english = flatten(files['./en.json'])

  it('exist for every shipped language, and only for those', () => {
    const codes = names.map((name) => name.replace(/^\.\//, '').replace(/\.json$/, '')).sort()
    expect(codes).toEqual(Object.keys(SHIPPED).sort())
  })

  it('have the same keys in every language', () => {
    for (const [index, language] of languages.entries()) {
      expect([...english.keys()].filter((key) => !language.has(key)), `missing in ${names[index]}`).toEqual([])
      expect([...language.keys()].filter((key) => !english.has(key)), `extra in ${names[index]}`).toEqual([])
    }
    // Floor: an empty or truncated file must not pass quietly.
    expect(english.size).toBeGreaterThan(120)
  })

  it('have no empty texts and nothing but text', () => {
    const bad = languages.flatMap((language) => [...language]).filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    expect(bad).toEqual([])
  })

  it('use no dashes as punctuation', () => {
    // House rule for everything nexlore shows.
    const dashed = languages.flatMap((language) => [...language]).filter(([, value]) => /\s[–—]\s|—/.test(String(value)))
    expect(dashed).toEqual([])
  })

  it('carry no markup, because texts are never put into the page as HTML', () => {
    const marked = languages.flatMap((language) => [...language]).filter(([, value]) => /<\/?[a-z][^>]*>/i.test(String(value).replace('<code>', '')))
    expect(marked).toEqual([])
  })

  it('say trash in English, never bin (decided 06.10.2026)', () => {
    const said = [...english].map(([key, value]) => [key, String(value)] as const)
    expect(said.filter(([, text]) => /\bbins?\b/i.test(text)).map(([key, text]) => `${key}: ${text}`)).toEqual([])
    // Floor: the trash is still spoken of, so the check above has something to look at.
    expect(said.filter(([, text]) => /\btrash\b/i.test(text)).length).toBeGreaterThan(5)
  })

  it('call the program version Version in German; Fassung is left for the versions of a note (decided 06.10.2026)', () => {
    const german = flatten(files['./de.json'])
    const about = [...german].filter(([key]) => key.startsWith('about.') || key === 'notify.occasionHint.operator')
    expect(about.filter(([, text]) => /Fassung/.test(String(text))).map(([key, text]) => `${key}: ${String(text)}`)).toEqual([])
    expect(german.get('about.version')).toBe('Version')
    expect(german.get('about.updates.current')).toBe('Das ist die neueste Version.')
  })

  it('keep the same placeholders in every language', () => {
    const placeholders = (text: unknown) => [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
    for (const key of english.keys()) {
      const expected = placeholders(english.get(key))
      for (const [index, language] of languages.entries()) {
        expect(placeholders(language.get(key)), `${key} in ${names[index]}`).toEqual(expected)
      }
    }
  })
})

/** Every text in a tree of entries, however deep, arrays included. */
function strings(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (tree && typeof tree === 'object') return Object.values(tree).flatMap(strings)
  return []
}

/**
 * The program version in German, as a phrase: "Fassung 1.2", "Fassung von nexcanvas", "eine neue Fassung", "die erste
 * Fassung", "je Fassung", "Alle Fassungen und was sich geändert hat". What belongs to content may keep the word: "eine
 * neue Fassung einer Notiz", "Welche Fassung bleibt".
 */
const PROGRAM_FASSUNG =
  /Fassung\s+(?:\d|von\s+nex)|\b(?:neue|neuen|neuere|neueren|neueste|neuesten|erste|ersten|diese|dieser|jede|jeder|je|nächste|nächsten)\s+Fassung(?!en)(?!\s+(?:einer|eines|der|des|deiner|deines)\b)|Fassungen\s+und\s+was/

describe('what is new', () => {
  const german = strings(whatsNewDe)
  const english = strings(whatsNewEn)

  it('call the program version Version in German, in released entries too (decided 06.10.2026)', () => {
    expect(german.filter((text) => PROGRAM_FASSUNG.test(text))).toEqual([])
    // Floor: the entries are read at all.
    expect(german.length).toBeGreaterThan(20)
  })

  it('say trash in English (decided 06.10.2026)', () => {
    expect(english.filter((text) => /\bbins?\b/i.test(text))).toEqual([])
    expect(english.length).toBeGreaterThan(20)
  })

  it('know the program version when they see it, and leave the versions of content alone', () => {
    for (const text of ['Fassung 1.4.0 ist da.', 'eine neuere Fassung von nexlore', 'Die erste Fassung von nexcanvas:', 'kommt einmal je Fassung', 'Vor dieser Fassung ging es', 'Alle Fassungen und was sich geändert hat']) {
      expect(PROGRAM_FASSUNG.test(text), text).toBe(true)
    }
    for (const text of ['Jede gespeicherte Fassung einer Notiz', 'eine neue Fassung einer Notiz', 'Welche Fassung bleibt', 'bekommen eine WebP-Fassung']) {
      expect(PROGRAM_FASSUNG.test(text), text).toBe(false)
    }
  })
})
