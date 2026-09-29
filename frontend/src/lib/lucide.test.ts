/** The Lucide symbols: found by English and German words, and every element turned into a path that means the same. */
import { beforeAll, describe, expect, it } from 'vitest'

// @ts-expect-error: a plain script of the build, without types
import { toPath } from '../../scripts/icons.mjs'
import { loadLucide, lucidePaths, searchLucide, type Lucide } from './lucide'

let all: Lucide
beforeAll(async () => {
  all = await loadLucide()
})

describe('the Lucide symbols', () => {
  it('are all there, each with its paths', () => {
    expect(Object.keys(all).length).toBeGreaterThan(1500)
    expect(lucidePaths('l:car')?.length).toBeGreaterThan(1)
    expect(lucidePaths('car')).toBeUndefined()
    expect(lucidePaths('l:no-such-symbol')).toBeUndefined()
  })

  it('are found by their name, by their words, and by German words, in part too', () => {
    expect(searchLucide(all, 'car')[0]).toBe('l:car')
    expect(searchLucide(all, 'Auto')).toContain('l:car')
    expect(searchLucide(all, 'vehicle')).toContain('l:car')
    expect(searchLucide(all, 'fahrr')).toContain('l:bike')
    expect(searchLucide(all, 'Geld')).toContain('l:wallet')
    // Every word must match.
    const up = searchLucide(all, 'arrow up')
    expect(up).toContain('l:arrow-up')
    expect(up).not.toContain('l:arrow-down')
    expect(searchLucide(all, '   ')).toEqual([])
    expect(searchLucide(all, 'zzzqqq')).toEqual([])
    expect(searchLucide(all, 'a', 5)).toHaveLength(5)
  })

  it('turn every element into a path', () => {
    expect(toPath('line', { x1: '1', y1: '2', x2: '3', y2: '4' })).toBe('M1 2L3 4')
    expect(toPath('polyline', { points: '1 2 3 4 5 6' })).toBe('M1 2L3 4L5 6')
    expect(toPath('polygon', { points: '1,2 3,4 5,6' })).toBe('M1 2L3 4L5 6Z')
    expect(toPath('rect', { x: '2', y: '3', width: '10', height: '6' })).toBe('M2 3h10v6h-10Z')
    expect(toPath('circle', { cx: '12', cy: '12', r: '10' })).toBe('M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0')
    // Rounded corners: four arcs, and the straight parts between them.
    const rounded = toPath('rect', { x: '2', y: '2', width: '20', height: '10', rx: '2' })
    expect(rounded.match(/a2 2 0 0 1/g)).toHaveLength(4)
    expect(rounded).toContain('h16')
    expect(() => toPath('text', {})).toThrow()
  })
})
