import { describe, expect, it } from 'vitest'

import { middleOf, pathOf, route, runsThrough, straighten, type Box, type Point } from './route'

const card = (x: number, y: number, width = 100, height = 60): Box => ({ x, y, width, height })

/** Every stretch level or upright, and none through a card. */
function clean(way: Point[], cards: Box[]) {
  way.slice(1).forEach((point, index) => {
    const before = way[index]
    expect(before.x === point.x || before.y === point.y).toBe(true)
  })
  for (const box of cards) expect(runsThrough(way, box)).toBe(false)
}

describe('a line on the canvas', () => {
  it('runs straight between two cards that face each other with nothing between', () => {
    const a = card(0, 0)
    const b = card(300, 0)
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b])).toEqual([
      { x: 100, y: 30 },
      { x: 300, y: 30 },
    ])
  })

  it('goes around a card in its way, out of and into its cards at right angles', () => {
    const a = card(0, 0)
    const b = card(400, 0)
    const wall = card(200, -20, 60, 100)
    const way = route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b, wall])!
    expect(way).not.toBeNull()
    clean(way, [a, b, wall])
    expect(way[0]).toEqual({ x: 100, y: 30 })
    expect(way.at(-1)).toEqual({ x: 400, y: 30 })
    // Out to the right, in from the left.
    expect(way[1].y).toBe(30)
    expect(way[1].x).toBeGreaterThan(100)
    expect(way.at(-2)!.y).toBe(30)
    expect(way.at(-2)!.x).toBeLessThan(400)
    // Keeps its distance from the card it goes around.
    expect(way.every((point) => point.y <= -20 - 24 || point.y >= 80 + 24 || point.y === 30)).toBe(true)
  })

  it('leaves and enters on the sides it was drawn between, even facing away from each other', () => {
    const a = card(0, 0)
    const b = card(-300, 0)
    const way = route({ from: a, fromSide: 'right', to: b, toSide: 'right' }, [a, b])!
    clean(way, [a, b])
    expect(way[0]).toEqual({ x: 100, y: 30 })
    expect(way[1].x).toBeGreaterThan(100) // leaves to the right, away from b
    expect(way.at(-1)).toEqual({ x: -200, y: 30 })
    expect(way.at(-2)!.x).toBeGreaterThan(-200) // comes into b's right side from the right, moving left
    expect(way.at(-2)!.y).toBe(30)
  })

  it('also goes around a card further out that the first way would run through', () => {
    const a = card(0, 0)
    const b = card(600, 0)
    // A tall card in the middle: the way goes over it, where it is shorter ...
    const tall = card(250, -150, 100, 500)
    // ... and there a long card lies, too far from both ends to be thought of at first.
    const above = card(150, -210, 300, 50)
    const way = route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b, tall, above])!
    expect(way).not.toBeNull()
    clean(way, [a, b, tall, above])
  })

  it('takes a tighter margin where two cards stand closer than the usual one', () => {
    const a = card(0, 0)
    const b = card(130, 0) // 30 apart: the usual margins of the two overlap
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b])).toEqual([
      { x: 100, y: 30 },
      { x: 130, y: 30 },
    ])
  })

  it('bends once each way, halfway between two cards at different heights, whichever way round', () => {
    const a = card(0, 0)
    const b = card(300, 100)
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b])).toEqual([
      { x: 100, y: 30 },
      { x: 200, y: 30 },
      { x: 200, y: 130 },
      { x: 300, y: 130 },
    ])
    // Side by side: the upright stretch halfway, at 200; one above the other: the level one halfway, at 180. Without
    // a price on running along a margin, three of these eight bent right beside a card.
    const sideBySide: [Box, Box][] = [
      [card(0, 0), card(300, 100)],
      [card(0, 100), card(300, 0)],
    ]
    for (const [left, right] of sideBySide) {
      for (const [from, fromSide, to, toSide] of [[left, 'right', right, 'left'], [right, 'left', left, 'right']] as const) {
        const way = route({ from, fromSide, to, toSide }, [left, right])!
        expect(way).toHaveLength(4)
        expect([way[1].x, way[2].x]).toEqual([200, 200])
      }
    }
    const stacked: [Box, Box][] = [
      [card(0, 0), card(100, 300)],
      [card(100, 0), card(0, 300)],
    ]
    for (const [upper, lower] of stacked) {
      for (const [from, fromSide, to, toSide] of [[upper, 'bottom', lower, 'top'], [lower, 'top', upper, 'bottom']] as const) {
        const way = route({ from, fromSide, to, toSide }, [upper, lower])!
        expect(way).toHaveLength(4)
        expect([way[1].y, way[2].y]).toEqual([180, 180])
      }
    }
  })

  it('counts a way along the edge of a card as outside it', () => {
    const box = card(0, 0)
    expect(runsThrough([{ x: -10, y: 0 }, { x: 110, y: 0 }], box)).toBe(false)
    expect(runsThrough([{ x: 100, y: -10 }, { x: 100, y: 70 }], box)).toBe(false)
    expect(runsThrough([{ x: 50, y: -10 }, { x: 50, y: 0 }], box)).toBe(false)
    expect(runsThrough([{ x: -10, y: 30 }, { x: 110, y: 30 }], box)).toBe(true)
    expect(runsThrough([{ x: 50, y: -10 }, { x: 50, y: 5 }], box)).toBe(true)
  })

  it('rather goes a little further than bending often', () => {
    const a = card(0, 0)
    const b = card(300, 300)
    // From a's bottom into b's left: down, then across, a single bend; a stair of bends would be no longer.
    const way = route({ from: a, fromSide: 'bottom', to: b, toSide: 'left' }, [a, b])!
    expect(way).toEqual([
      { x: 50, y: 60 },
      { x: 50, y: 330 },
      { x: 300, y: 330 },
    ])
  })

  it('finds no way when an end lies inside another card, and the line is drawn as the curve', () => {
    const a = card(0, 0)
    const b = card(300, 0)
    const over = card(80, -40, 80, 140) // lies over a's right side
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b, over])).toBeNull()
  })

  it('finds no way between two cards lying on each other', () => {
    const a = card(0, 0)
    const b = card(20, 10)
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b])).toBeNull()
  })

  it('leaves a line among very many cards to the curve', () => {
    const a = card(0, 0)
    const b = card(2000, 0)
    // 160 small cards below the straight way: none in it, but too many to search among.
    const crowd = Array.from({ length: 160 }, (_, index) => card(120 + index * 11, 100, 10, 10))
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b, ...crowd])).toBeNull()
    expect(route({ from: a, fromSide: 'right', to: b, toSide: 'left' }, [a, b, ...crowd.slice(0, 100)])).toHaveLength(2)
  })

  it('draws the corners rounded and puts the label halfway', () => {
    const way = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(pathOf(way)).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 100')
    expect(pathOf([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 100 }])).toBe('M 0 0 L 2 0 Q 4 0 4 2 L 4 100')
    expect(middleOf(way)).toEqual({ x: 100, y: 0 })
    expect(middleOf([{ x: 0, y: 0 }, { x: 0, y: 50 }])).toEqual({ x: 0, y: 25 })
  })

  it('keeps only the corners of a way', () => {
    expect(
      straighten([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
        { x: 100, y: 80 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ])
  })
})
