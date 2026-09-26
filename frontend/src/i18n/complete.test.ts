/**
 * The shipped languages have exactly the same keys. English is the fallback for languages the operator adds, but
 * for the two shipped ones the fallback must never show: a German page with one English line is a bug.
 */

import { SHIPPED } from './index'

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
