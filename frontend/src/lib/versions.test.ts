import type { TFunction } from 'i18next'

import { versionSource } from './versions'

const t = ((key: string, options?: Record<string, unknown>) =>
  `${key}${options?.name ? `:${options.name}` : ''}`) as unknown as TFunction

describe('where a version came from', () => {
  it('names who renamed, for links rewritten by a rename', () => {
    expect(versionSource({ source: 'rename', author: 'anna' }, t)).toBe('note.source.renameBy:anna')
  })

  it('says only the kind otherwise', () => {
    expect(versionSource({ source: 'rename', author: null }, t)).toBe('note.source.rename')
    expect(versionSource({ source: 'app', author: 'anna' }, t)).toBe('note.source.app')
  })
})
