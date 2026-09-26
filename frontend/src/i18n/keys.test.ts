/** Every key the code asks for exists in English, the language every other one falls back to. */

import en from './en.json'

const sources = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function exists(path: string): boolean {
  let node: unknown = en
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

/** With plural forms: `graph.links` exists as `_one` and `_other`. */
function existsWithPlural(path: string): boolean {
  return exists(path) || (exists(`${path}_one`) && exists(`${path}_other`))
}

describe('translation keys used in the code', () => {
  it('all exist', () => {
    const used = new Set<string>()
    for (const [file, text] of Object.entries(sources)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(match[1])
    }
    // Floor, so a broken pattern does not silently find nothing.
    expect(used.size).toBeGreaterThan(90)
    expect([...used].filter((key) => !existsWithPlural(key))).toEqual([])
  })

  it('cover the composed keys', () => {
    const composed = [
      ...['nav.graph', 'nav.notes', 'nav.files', 'nav.settings'],
      ...['read', 'drafts', 'write'].flatMap((mode) => [`settings.mcp.mode.${mode}`, `settings.mcp.mode.${mode}Text`]),
      ...['calendar', 'mermaid', 'kanban', 'templates', 'readingTime'].flatMap((id) => [`settings.plugins.${id}.name`, `settings.plugins.${id}.text`]),
      ...['readNotes', 'readOpen', 'writeOpen', 'writeNew'].map((right) => `settings.plugins.right.${right}`),
      // The server's error codes, which the UI turns into sentences.
      ...['not_found', 'invalid_input', 'sign_in_required', 'locale_unusable', 'internal_error'].map((code) => `errors.byCode.${code}`),
    ]
    expect(composed.filter((key) => !existsWithPlural(key))).toEqual([])
  })
})
