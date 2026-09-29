import { describe, expect, it } from 'vitest'

import { notePathOf, noteUrl } from './vault'

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
