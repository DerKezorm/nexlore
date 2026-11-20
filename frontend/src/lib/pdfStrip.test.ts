/** A PDF's pages as a strip on a canvas card (`pdfFrame.ts`): its height, its sharpness, what the frame may ask for. */
import { describe, expect, it } from 'vitest'

import { STRIP_GAP, STRIP_MORE, frameData, sharpness, stripLayout } from './pdfFrame'

describe('a strip of pages on a card', () => {
  it('is as tall as its pages at its width, with room between them', () => {
    // A4 portrait (595 x 842 points) and a landscape page at 400 pixels.
    const { heights, total } = stripLayout([{ width: 595, height: 842 }, { width: 842, height: 595 }], 400, 0)
    expect(heights[0]).toBeCloseTo((400 * 842) / 595)
    expect(heights[1]).toBeCloseTo((400 * 595) / 842)
    expect(total).toBe(Math.ceil(heights[0] + heights[1] + STRIP_GAP))
  })

  it('has a line below for the pages it leaves out, and grows with its width', () => {
    const page = { width: 100, height: 200 }
    expect(stripLayout([page], 300, 0).total).toBe(600)
    expect(stripLayout([page], 300, 12).total).toBe(600 + STRIP_GAP + STRIP_MORE)
    expect(stripLayout([page, page, page], 150, 0).total).toBe(3 * 300 + 2 * STRIP_GAP)
    expect(stripLayout([], 300, 0).total).toBe(0)
    // A page of no width breaks nothing.
    expect(Number.isFinite(stripLayout([{ width: 0, height: 10 }], 300, 0).total)).toBe(true)
  })

  it('is drawn sharper on a dense screen and when zoomed in, three times at most', () => {
    expect(sharpness(1, 1)).toBe(1)
    expect(sharpness(2, 1)).toBe(2)
    expect(sharpness(1, 2.5)).toBe(2.5)
    expect(sharpness(2, 2)).toBe(3)
    expect(sharpness(1, 0.2)).toBe(1)
  })

  it('gets only the files pdf.js may ask for', async () => {
    expect(await frameData({ type: 'data', id: 1, kind: 'cMapUrl', name: '../secret' })).toBeNull()
    expect(await frameData({ type: 'data', id: 1, kind: 'nothing' as never, name: 'a.bcmap' })).toBeNull()
  })
})
