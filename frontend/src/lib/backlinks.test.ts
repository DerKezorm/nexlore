import { describe, expect, it } from 'vitest'

import { backlinkNotes } from './backlinks'

describe('backlinks once per note', () => {
  it('counts the links of a note, keeps the order and the first line with text', () => {
    const notes = backlinkNotes([
      { path: 'A/One.md', title: 'One', line: 3, kind: 'wiki', context: null },
      { path: 'A/One.md', title: 'One', line: 9, kind: 'wiki', context: 'the second place' },
      { path: 'A/Two.md', title: 'Two', line: 1, kind: 'embed', context: 'only here' },
      { path: 'A/One.md', title: 'One', line: 12, kind: 'wiki', context: 'a third' },
    ])
    expect(notes).toEqual([
      { path: 'A/One.md', title: 'One', count: 3, line: 3, context: 'the second place' },
      { path: 'A/Two.md', title: 'Two', count: 1, line: 1, context: 'only here' },
    ])
  })

  it('has no text where the server sent none', () => {
    expect(backlinkNotes([{ path: 'B.md', title: 'B', line: 2, kind: 'wiki' }])).toEqual([
      { path: 'B.md', title: 'B', count: 1, line: 2, context: null },
    ])
  })
})
