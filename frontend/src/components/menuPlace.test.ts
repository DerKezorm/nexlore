import { describe, expect, it } from 'vitest'

import { MENU_EDGE, MENU_MAX_HEIGHT, menuPlace } from './menuPlace'

/** A window of 800 × 600, a menu 220 px wide. */
const at = (x: number, y: number, height: number, sub = false) =>
  menuPlace({ x, y, width: 220, height, viewWidth: 800, viewHeight: 600, sub })

describe('where a menu at the pointer stands', () => {
  it('opens at the pointer where it fits', () => {
    expect(at(100, 100, 200)).toEqual({ left: 100, top: 100 })
  })

  it('opens upwards near the bottom and to the left near the right edge', () => {
    expect(at(100, 500, 200)).toEqual({ left: 100, top: 300 })
    expect(at(700, 100, 200)).toEqual({ left: 800 - 220 - 4, top: 100 })
  })

  it('never stands above 8 px from the top, and stays 8 px off the bottom', () => {
    // Fits neither below nor above the pointer: from the top.
    expect(at(100, 250, 400).top).toBe(MENU_EDGE)
    // Upwards it would leave the window at the top: 8 px from it.
    expect(at(100, 590, 585).top).toBe(MENU_EDGE)
    const placed = at(100, 560, 300)
    expect(placed.top).toBeGreaterThanOrEqual(MENU_EDGE)
    expect(placed.top + 300).toBeLessThanOrEqual(600 - MENU_EDGE)
  })

  it('a menu higher than the window stands at the top and scrolls (25 entries in 800 × 600)', () => {
    const height = 25 * 32 + 8
    for (const y of [0, 100, 300, 590]) expect(at(100, y, height).top).toBe(MENU_EDGE)
    expect(MENU_MAX_HEIGHT).toBe('calc(100dvh - 16px)')
  })

  it('a submenu does the same, and opens to the other side of its parent near the right edge', () => {
    expect(at(700, 400, 900, true)).toEqual({ left: 700 - 440, top: MENU_EDGE })
    expect(at(300, 500, 150, true)).toEqual({ left: 300, top: 350 })
  })
})
