import { place, settle, SIDE, trail, typedTo } from './coverflow'

describe('where a card of the cover flow stands', () => {
  it('stands face on in the middle, turned and further back beside it, the same on both sides', () => {
    expect(place(0, 300)).toMatchObject({ x: 0, z: -0, opacity: 1, dim: 0, hidden: false })
    expect(Math.abs(place(0, 300).turn)).toBe(0)
    const right = place(1, 300)
    const left = place(-1, 300)
    expect(right.x).toBeCloseTo(246)
    expect(left.x).toBeCloseTo(-246)
    expect(right.z).toBe(-150)
    // Each turns its face towards the middle.
    expect(right.turn).toBe(-30)
    expect(left.turn).toBe(30)
  })

  it('packs the cards further out closer together than the first beside the middle', () => {
    const steps = [1, 2, 3].map((offset) => place(offset, 300).x)
    expect(steps[1] - steps[0]).toBeLessThan(steps[0])
    expect(steps[2] - steps[1]).toBeCloseTo(steps[1] - steps[0])
    expect(place(3, 300).z).toBeLessThan(place(2, 300).z)
  })

  it('fades the cards beyond the sides out and hides those far away', () => {
    expect(place(SIDE, 300).opacity).toBe(1)
    expect(place(SIDE + 0.5, 300).opacity).toBeCloseTo(0.5)
    expect(place(SIDE + 1.1, 300).opacity).toBe(0)
    expect(place(SIDE + 1.1, 300).hidden).toBe(false)
    expect(place(SIDE + 1.3, 300).hidden).toBe(true)
    expect(place(9, 300).dim).toBe(0.62)
  })
})

describe('letters typed', () => {
  const names = ['Alpha', 'Äpfel', 'beta', 'Berge']
  it('lead to the first card that begins so, case and accents aside', () => {
    expect(typedTo(names, 'b')).toBe(2)
    expect(typedTo(names, 'BE')).toBe(2)
    expect(typedTo(names, 'ber')).toBe(3)
    expect(typedTo(names, 'apf')).toBe(1)
    expect(typedTo(names, 'z')).toBe(-1)
    expect(typedTo(names, '')).toBe(-1)
  })
})

describe('letting go after a drag', () => {
  it('lands on the nearest card, carried on by a fast hand, never outside the row', () => {
    expect(settle(2.4, 0, 5)).toBe(2)
    expect(settle(2.6, 0, 5)).toBe(3)
    // A hand moving left (negative speed) flips forward.
    expect(settle(2.4, -0.2, 5)).toBe(3)
    expect(settle(2.4, -0.5, 5)).toBe(4)
    expect(settle(0.2, 2, 5)).toBe(0)
    expect(settle(4.4, -3, 5)).toBe(4)
  })
})

describe('the line of places', () => {
  it('names every folder on the way with its path', () => {
    expect(trail('')).toEqual([])
    expect(trail('Garden/Beds/Roses')).toEqual([
      { name: 'Garden', path: 'Garden' },
      { name: 'Beds', path: 'Garden/Beds' },
      { name: 'Roses', path: 'Garden/Beds/Roses' },
    ])
  })
})
