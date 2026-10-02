import { describe, expect, it } from 'vitest'

import { decodedOrNull, notePathOf, noteUrl } from './vault'

describe('notePathOf', () => {
  it('reads back the note of an address, whatever its name holds', () => {
    for (const path of ['Zoo/Menu.md', 'Work/100% sure #1?.md', 'Küche/Ä ö/Brot & Butter.md']) {
      expect(notePathOf(noteUrl(path))).toBe(path)
    }
  })

  it('is null on any other page and for a broken address', () => {
    expect(notePathOf('/')).toBeNull()
    expect(notePathOf('/note/')).toBeNull()
    expect(notePathOf('/notes/Zoo/Menu.md')).toBeNull()
    expect(notePathOf('/note/Zoo/%E0%A4%A.md')).toBeNull()
  })
})

describe('decodedOrNull', () => {
  it('decodes escapes and gives null for a broken one instead of throwing', () => {
    expect(decodedOrNull('far%20DOWN')).toBe('far DOWN')
    expect(decodedOrNull('Zoo/Na%C3%AFve.md')).toBe('Zoo/Naïve.md')
    expect(decodedOrNull('%zz')).toBeNull()
    expect(decodedOrNull('100%')).toBeNull()
    expect(decodedOrNull('%E0%A4%A')).toBeNull()
  })
})
