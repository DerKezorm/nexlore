/** Every key the code asks for exists in English, the language every other one falls back to. */

import { en } from './index'

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
      // The symbols and colours to choose for a space or folder, as the server lists them (services/looks.py).
      ...['folder', 'book', 'server', 'cooking', 'travel', 'tool', 'star', 'heart', 'home', 'work', 'code', 'music', 'image',
        'calendar', 'idea', 'users', 'money', 'health', 'school', 'archive', 'lock', 'globe', 'leaf', 'template'].map((icon) => `looks.icons.${icon}`),
      ...Array.from({ length: 11 }, (_, index) => `looks.colors.${index}`),
      // The editor's slash menu, the kinds of a property, the choices in the comparison.
      ...[
        'text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'divider', 'bulletList', 'orderedList', 'taskList', 'code', 'table', 'math',
        'groupText', 'groupList', 'groupAdvanced', 'groupObsidian', 'callout', 'wikiLink', 'embed', 'image',
      ].map((key) => `editor.slash.${key}`),
      ...['text', 'list', 'number', 'checkbox', 'date', 'datetime'].map((kind) => `properties.kinds.${kind}`),
      ...['left', 'right', 'both'].map((choice) => `compare.take.${choice}`),
      // How a version came about, as the server names it.
      ...['initial', 'app', 'external', 'rename', 'restore', 'import', 'mcp', 'api', 'plugin'].map((source) => `note.source.${source}`),
      // API tokens: levels, their texts, the lifetimes offered; the occasion of the notification.
      ...['read', 'write'].flatMap((level) => [`apiTokens.level.${level}`, `apiTokens.levelText.${level}`]),
      ...['30', '90', '365'].map((days) => `apiTokens.lifetimeDays.${days}`),
      ...['mention', 'invite', 'approval', 'tokens', 'tasks', 'operator'].flatMap((occasion) => [`notify.occasion.${occasion}`, `notify.occasionHint.${occasion}`]),
      // The notices under "New", as the server names their kinds (services/notices, emailaddr, routers/oidc).
      ...['invite', 'operator_added', 'operator_role', 'operator_removed', 'operator_email', 'operator_email_removed', 'operator_unlinked'].map((kind) => `notices.${kind}`),
      // The server's error codes, which the UI turns into sentences.
      ...[
        'not_found', 'invalid_input', 'sign_in_required', 'locale_unusable', 'internal_error', 'path_invalid',
        'path_too_long', 'name_invalid', 'exists', 'locked', 'not_a_note', 'move_across_spaces', 'too_large_for_trash',
        'archive_invalid', 'archive_unsafe', 'archive_too_large', 'archive_too_many_files', 'client_required', 'too_large',
        'changed_meanwhile', 'api_off', 'too_many_tokens',
      ].map((code) => `errors.byCode.${code}`),
    ]
    expect(composed.filter((key) => !existsWithPlural(key))).toEqual([])
  })
})
