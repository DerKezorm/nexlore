import { describe, expect, it } from 'vitest'

import { GREY, PALETTE, SPACE_COLORS, coloursFor, fnv1a, folderColor, slotColor } from './palette'

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

describe('colours from the theme', () => {
  const OWN_DARK = { accent: '#2dd4bf', bg: '#0b0b0f', muted: '#9a9aa8' }
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return h * 60
  }
  const lightness = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
  }

  it('leaves the palette as it is in nexlore\'s own dark theme', () => {
    expect(coloursFor(OWN_DARK)).toEqual({ slots: PALETTE, spaces: SPACE_COLORS, grey: GREY })
    // Nothing readable (no styles yet): the same.
    expect(coloursFor({ accent: '', bg: '', muted: '' })).toEqual({ slots: PALETTE, spaces: SPACE_COLORS, grey: GREY })
  })

  it('turns every hue by as much as the accent lies from turquoise', () => {
    const plum = coloursFor({ ...OWN_DARK, accent: '#e879f9' })
    const turn = hue('#e879f9') - hue('#2dd4bf')
    for (const [index, colour] of plum.slots.entries()) {
      const want = (hue(PALETTE[index]) + turn + 360) % 360
      const diff = Math.abs(hue(colour) - want)
      expect(Math.min(diff, 360 - diff)).toBeLessThan(2)
      expect(Math.abs(lightness(colour) - lightness(PALETTE[index]))).toBeLessThan(0.01)
    }
    expect(Math.abs(hue(plum.slots[0]) - hue('#e879f9'))).toBeLessThan(2)
    expect(plum.spaces[0]).not.toBe(SPACE_COLORS[0])
    // Folders keep their slot: the colour moves with the theme, the order stays.
    expect(new Set(plum.slots).size).toBe(PALETTE.length)
  })

  it('darkens the colours on a light background and takes the theme\'s grey', () => {
    const light = coloursFor({ accent: '#0d9488', bg: '#f5f5f8', muted: '#61616F' })
    for (const [index, colour] of light.slots.entries()) expect(lightness(colour)).toBeLessThan(lightness(PALETTE[index]) * 0.8)
    expect(light.grey).toBe('#61616f')
  })

  it('does not turn for an accent without colour', () => {
    expect(coloursFor({ ...OWN_DARK, accent: '#a0a0a0' }).slots).toEqual(PALETTE)
  })
})
