import { describe, expect, it } from 'vitest'

import { SNAP_PX, moving, snap } from './snap'

const other = { x: 0, y: 0, width: 200, height: 100 }

describe('snapping', () => {
  it('brings an edge to the nearest line of another card and names it as a guide', () => {
    const box = { x: 205, y: 4, width: 100, height: 50 }
    const result = snap(moving(box), [other], 1)
    expect(result.dy).toBe(-4)
    // Its top meets the other's top, and its bottom (50) the other's middle.
    expect(result.guidesY).toEqual([0, 50])
    // The left edge at 205 is 5 from the right edge at 200: within reach.
    expect(result.dx).toBe(-5)
    expect(result.guidesX).toEqual([200])
  })

  it('takes the nearest of several lines on each axis', () => {
    const box = { x: 98, y: 300, width: 6, height: 6 }
    // Middle of the box at 101, middle of the other at 100: 1 away; its left edge at 98 is 2 from nothing nearer.
    expect(snap(moving(box), [other], 1).dx).toBe(-1)
  })

  it('counts the reach on the screen: far out it reaches further on the canvas', () => {
    const box = { x: 0, y: 112, width: 50, height: 50 }
    expect(snap(moving(box), [other], 1).dy).toBe(0)
    expect(snap(moving(box), [other], 0.5).dy).toBe(-12)
    expect(12 * 0.5).toBeLessThanOrEqual(SNAP_PX)
  })

  it('leaves alone what is not close, and draws no guide then', () => {
    expect(snap(moving({ x: 500, y: 500, width: 10, height: 10 }), [other], 1)).toEqual({ dx: 0, dy: 0, guidesX: [], guidesY: [] })
    expect(snap(moving(other), [], 1)).toEqual({ dx: 0, dy: 0, guidesX: [], guidesY: [] })
  })

  it('snaps only the edge that grows', () => {
    const result = snap({ x: [197], y: [] }, [other], 1)
    expect(result).toEqual({ dx: 3, dy: 0, guidesX: [200], guidesY: [] })
  })

  it('names every line that matches after the shift', () => {
    const box = { x: 2, y: 400, width: 200, height: 10 }
    expect(snap(moving(box), [other], 1).guidesX.sort((a, b) => a - b)).toEqual([0, 100, 200])
  })
})
