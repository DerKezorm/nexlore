import { describe, expect, it } from 'vitest'

import { GREY, PALETTE, fnv1a, folderColor, slotColor } from './palette'

describe('colours', () => {
  it('hashes like the server (graphstore._colour), bytes of UTF-8', () => {
    // Worked out with the server's function.
    expect(fnv1a('f:Beds')).toBe(1159755185)
    expect(fnv1a('f:K\u00fcche')).toBe(4178850469)
    expect(fnv1a('f:\u65e5\u672c')).toBe(2889994021)
    expect(fnv1a('')).toBe(2166136261)
  })

  it('gives a note the colour of its top folder, grey at the top of a space', () => {
    expect(folderColor('Garden/Beds/Tomatoes.md')).toBe(PALETTE[5])
    expect(folderColor('Garden/Beds/Deeper/Tomatoes.md')).toBe(PALETTE[5])
    expect(folderColor('Garden/Beds', true)).toBe(PALETTE[5])
    expect(folderColor('Garden/Plan.md')).toBe(GREY)
    expect(folderColor('Garden', true)).toBe(GREY)
    expect(folderColor('Home/K\u00fcche/Brot.md')).toBe(PALETTE[9])
    expect(slotColor(-1)).toBe(GREY)
    expect(slotColor(12)).toBe(PALETTE[2])
  })
})
