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
      ...['folders', 'tags', 'topics'].map((cloud) => `graph.cloud.${cloud}`),
      ...['pending', 'saving', 'saved', 'failed', 'refreshed'].map((state) => `note.save.${state}`),
      // The editor's slash menu, the kinds of a property, the choices in the comparison.
      ...[
        'text', 'h1', 'h2', 'h3', 'quote', 'divider', 'bulletList', 'orderedList', 'taskList', 'code', 'table', 'math',
        'groupText', 'groupList', 'groupAdvanced', 'groupObsidian', 'callout', 'wikiLink', 'embed',
      ].map((key) => `editor.slash.${key}`),
      ...['text', 'list', 'number', 'checkbox', 'date', 'datetime'].map((kind) => `properties.kinds.${kind}`),
      ...['left', 'right', 'both'].map((choice) => `compare.take.${choice}`),
      // How a version came about, as the server names it.
      ...['initial', 'app', 'external', 'rename', 'restore', 'import'].map((source) => `note.source.${source}`),
      // The server's error codes, which the UI turns into sentences.
      ...[
        'not_found', 'invalid_input', 'sign_in_required', 'locale_unusable', 'internal_error', 'path_invalid',
        'path_too_long', 'name_invalid', 'exists', 'locked', 'not_a_note', 'move_across_spaces', 'too_large_for_trash',
        'archive_invalid', 'archive_unsafe', 'archive_too_large', 'archive_too_many_files', 'client_required', 'too_large',
        'changed_meanwhile',
      ].map((code) => `errors.byCode.${code}`),
    ]
    expect(composed.filter((key) => !existsWithPlural(key))).toEqual([])
  })
})
