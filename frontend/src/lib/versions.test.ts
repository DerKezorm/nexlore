import type { TFunction } from 'i18next'

import { versionSource } from './versions'

const t = ((key: string, options?: Record<string, unknown>) =>
  `${key}${options?.name ? `:${options.name}` : ''}${options?.key ? `:${options.key}` : ''}`) as unknown as TFunction

describe('where a version came from', () => {
  it('names who renamed, for links rewritten by a rename', () => {
    expect(versionSource({ source: 'rename', author: 'anna' }, t)).toBe('note.source.renameBy:anna')
  })

  it('says only the kind otherwise', () => {
    expect(versionSource({ source: 'rename', author: null }, t)).toBe('note.source.rename')
    expect(versionSource({ source: 'app', author: 'anna' }, t)).toBe('note.source.app')
  })

  it('names the key of an AI program, as nexnotes does; a version from before says only the kind (MCP 15)', () => {
    expect(versionSource({ source: 'mcp', author: 'anna', key_name: 'Agent' }, t)).toBe('note.source.mcpKey:Agent')
    expect(versionSource({ source: 'mcp', author: 'anna', key_name: null }, t)).toBe('note.source.mcp')
    expect(versionSource({ source: 'mcp', author: 'anna' }, t)).toBe('note.source.mcp')
    // Only an AI program's version names a key.
    expect(versionSource({ source: 'app', author: 'anna', key_name: 'Agent' }, t)).toBe('note.source.app')
  })
})
