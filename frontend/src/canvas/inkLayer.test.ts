import { describe, expect, it } from 'vitest'

import { toDrawing, type InkStroke } from '../lib/ink'
import {
  INK_FIELD,
  cardsOf,
  carriedStrokes,
  clampedPlacement,
  inkLayerOf,
  isInkLayer,
  layerBox,
  makeLayer,
  placementOf,
  sameBox,
  viewportOf,
} from './inkLayer'
import { EMPTY_CANVAS, addNode, makeNode, parseCanvas, serializeCanvas, type Canvas, type CanvasNode } from './model'

const line = (pts: [number, number][], tool: 'pen' | 'marker' = 'pen', size = 4): InkStroke => ({ tool, color: 'ink', size, pts: pts.map(([x, y]) => [x, y, 0.5]) })

describe('the two views', () => {
  it('turns React Flow’s view into the surface’s and back', () => {
    const viewport = { x: 120, y: -40, zoom: 2 }
    const place = placementOf(viewport)
    expect(place).toEqual({ x: -60, y: 20, z: 2 })
    expect(viewportOf(place)).toEqual(viewport)
  })

  it('finds under a pixel the same canvas point React Flow does', () => {
    // React Flow: screen = point * zoom + shift; a point = (screen - shift) / zoom.
    const viewport = { x: 37, y: 250, zoom: 0.5 }
    const [x, y] = toDrawing(placementOf(viewport), 237, 50)
    expect(x).toBeCloseTo((237 - 37) / 0.5)
    expect(y).toBeCloseTo((50 - 250) / 0.5)
  })

  it('keeps a zoom within the canvas’s, with the point under the pointer where it was', () => {
    const before = { x: 10, y: 20, z: 3 }
    // Zoomed by 2 around the pixel (100, 50): the surface asks for 6, the canvas goes to 4 at most.
    const asked = { x: before.x + 100 / 3 - 100 / 6, y: before.y + 50 / 3 - 50 / 6, z: 6 }
    const kept = clampedPlacement(before, asked, 0.05, 4)
    expect(kept.z).toBe(4)
    expect(toDrawing(kept, 100, 50)[0]).toBeCloseTo(toDrawing(before, 100, 50)[0])
    expect(toDrawing(kept, 100, 50)[1]).toBeCloseTo(toDrawing(before, 100, 50)[1])
    expect(clampedPlacement(before, { x: 1, y: 2, z: 2 }, 0.05, 4)).toEqual({ x: 1, y: 2, z: 2 })
    expect(clampedPlacement({ x: 0, y: 0, z: 0.05 }, { x: 5, y: 6, z: 0.01 }, 0.05, 4).z).toBe(0.05)
    // A move at a zoom out of bounds keeps the move.
    expect(clampedPlacement({ x: 0, y: 0, z: 5 }, { x: 7, y: 8, z: 5 }, 0.05, 4)).toEqual({ x: 7, y: 8, z: 4 })
  })
})

describe('the layer’s card', () => {
  it('is the box the server writes as viewBox: the line’s room and 24 around it, outwards to whole units', () => {
    // The numbers `services/ink._box` gives for the same strokes (measured there).
    expect(layerBox([line([[10, 20], [52.5, 22]])])).toEqual({ x: -17, y: -7, width: 97, height: 56 })
    const sketch = [
      line([[10, 20], [30, 25], [52.5, 22]], 'pen', 4),
      line([[0, 40], [60, 40]], 'marker', 6),
      line([[-100, -50]], 'pen', 2.5),
    ]
    expect(layerBox(sketch)).toEqual({ x: -126, y: -76, width: 219, height: 149 })
    expect(layerBox([])).toEqual({ x: 0, y: 0, width: 680, height: 220 })
  })

  it('is known by its field and stays out of the cards', () => {
    let canvas: Canvas = EMPTY_CANVAS
    const text = makeNode(canvas, { type: 'text', text: 'a' }, { x: 0, y: 0, width: 10, height: 10 })
    canvas = addNode(canvas, text)
    const layer = makeLayer(canvas, 'Attachments/Board 1.svg', [line([[0, 0], [10, 10]])])
    canvas = addNode(canvas, layer)
    expect(layer[INK_FIELD]).toBe(true)
    expect(Object.keys(layer)).toEqual(['id', 'type', 'file', 'x', 'y', 'width', 'height', INK_FIELD])
    expect(inkLayerOf(canvas)).toBe(layer)
    expect(cardsOf(canvas.nodes)).toEqual([text])
    // A picture without the field, or with another value, is a card like any other.
    const picture: CanvasNode = { ...layer, id: 'p', nexloreInk: 'yes' }
    expect(isInkLayer(picture)).toBe(false)
    expect(isInkLayer({ ...layer, type: 'text' })).toBe(false)
    // New cards go below it: whoever shows it as a picture draws it over them.
    const later = makeNode(canvas, { type: 'file', file: 'x.png' }, { x: 0, y: 0, width: 10, height: 10 })
    expect(addNode(canvas, later).nodes.map((node) => node.id)).toEqual([text.id, later.id, layer.id])
    // Written as JSON Canvas, with the field at the end, and read back the same.
    const written = serializeCanvas(canvas)
    expect(written).toContain(`"nexloreInk":true}`)
    expect(serializeCanvas(parseCanvas(written))).toBe(written)
  })

  it('compares boxes by every side', () => {
    const box = { x: 1, y: 2, width: 3, height: 4 }
    expect(sameBox(box, { ...box })).toBe(true)
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(sameBox(box, { ...box, [key]: box[key] + 1 })).toBe(false)
  })
})

describe('strokes that go along', () => {
  const card = { x: 100, y: 100, width: 200, height: 100 }

  it('are those lying wholly on a moved card, edges included', () => {
    const strokes = [
      line([[110, 110], [290, 190]]), // on it
      line([[100, 100], [300, 200]]), // on its edges
      line([[110, 110], [310, 150]]), // one point beside it
      line([[0, 0], [50, 50]]), // elsewhere
      line([[150, 99.9]]), // a dot just above it
    ]
    expect(carriedStrokes(strokes, [card])).toEqual([0, 1])
  })

  it('count each point on any of the moved cards: a line from one to the other goes along', () => {
    const other = { x: 400, y: 100, width: 100, height: 100 }
    const across = line([[150, 150], [450, 150]])
    const between = line([[150, 150], [350, 150], [450, 150]])
    expect(carriedStrokes([across, between], [card, other])).toEqual([0])
    expect(carriedStrokes([across], [card])).toEqual([])
    expect(carriedStrokes([across], [])).toEqual([])
  })
})
