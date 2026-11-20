import {
  EMPTY_BOX,
  INK,
  LIMITS,
  MARKER_COLOR,
  askToDraw,
  blockPlacement,
  bounds,
  changedView,
  composeInk,
  erasePart,
  eraseWhole,
  fitTo,
  fittedHeight,
  followEdge,
  inBox,
  inPolygon,
  keptPoint,
  lassoPick,
  moveStrokes,
  panBy,
  pickedBox,
  pressureOf,
  readInk,
  readView,
  removeStrokes,
  strokeShape,
  takeDrawRequest,
  toDrawing,
  touches,
  viewBoxOf,
  widthAt,
  zoomAt,
  type InkStroke,
  type Point,
} from './ink'

const pen = (pts: [number, number][], size = 4): InkStroke => ({ tool: 'pen', color: INK, size, pts: pts.map(([x, y]) => [x, y, 0.5]) })
const line = (from: number, to: number, y = 0, step = 5): InkStroke =>
  pen(Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => [from + index * step, y] as [number, number]))

describe('reading a drawing', () => {
  it('keeps what it does not know, for the next save', () => {
    const raw = {
      v: 1,
      bg: 'grid',
      strokes: [{ tool: 'marker', color: '#22c55e', size: 8, pts: [[1, 2, 0.4]], pencil: 'kit' }],
      text: 'Router Keller',
      words: [{ t: 'Router', box: [1, 2, 3, 4] }],
      later: { field: true },
      view: { x: -10, y: 5, z: 1.5, h: 300 },
    }
    const ink = readInk(raw)
    expect(ink.bg).toBe('grid')
    expect(ink.text).toBe('Router Keller')
    expect(ink.words).toEqual(raw.words)
    expect(ink.later).toEqual({ field: true })
    expect(ink.strokes[0]).toEqual({ tool: 'marker', color: '#22c55e', size: 8, pts: [[1, 2, 0.4]], pencil: 'kit' })
    expect(ink.view).toEqual({ x: -10, y: 5, z: 1.5, h: 300 })
  })

  it('makes what it cannot draw safe: unknown paper plain, odd colours ink, sizes and pressure within bounds', () => {
    const ink = readInk({
      bg: 'stripes',
      strokes: [
        { tool: 'brush', color: 'red', size: 900, pts: [[0, 0, 7], ['x', 1, 0], [2e7, -2e7]] },
        { tool: 'pen', color: '#123456', size: 0, pts: [] },
        'nothing',
      ],
      view: { x: 0, y: 0, z: 99, h: 5 },
    })
    expect(ink.v).toBe(1)
    expect(ink.bg).toBe('none')
    expect(ink.strokes).toHaveLength(1)
    expect(ink.strokes[0]).toMatchObject({ tool: 'pen', color: INK, size: LIMITS.maxSize })
    expect(ink.strokes[0].pts).toEqual([
      [0, 0, 1],
      [LIMITS.coordinate, -LIMITS.coordinate, 0.5],
    ])
    expect(ink.view).toEqual({ x: 0, y: 0, z: LIMITS.maxZoom, h: LIMITS.minHeight })
    expect(readInk(null)).toEqual({ v: 1, bg: 'none', strokes: [] })
    expect(readInk({ strokes: [{ size: 0.1, pts: [[0, 0, 0.5]] }] }).strokes[0].size).toBe(LIMITS.minSize)
  })

  it('takes a view only when all of it is there', () => {
    expect(readView({ x: 1, y: 2, z: 1 })).toBeNull()
    expect(readView({ x: 1, y: 2, z: 0.001, h: 99999 })).toEqual({ x: 1, y: 2, z: LIMITS.minZoom, h: LIMITS.maxHeight })
    expect(readView('view')).toBeNull()
  })

  it('composes what goes back: what came, with the strokes, paper and view of now', () => {
    const loaded = readInk({ v: 1, bg: 'none', strokes: [], text: 'kept', view: { x: 0, y: 0, z: 1, h: 200 } })
    const strokes = [line(0, 10)]
    const next = composeInk(loaded, strokes, 'dots', { x: 5, y: 6, z: 2, h: 300 })
    expect(next).toEqual({ v: 1, bg: 'dots', strokes, text: 'kept', view: { x: 5, y: 6, z: 2, h: 300 } })
    expect(composeInk(loaded, strokes, 'none', null)).not.toHaveProperty('view')
    // The loaded drawing itself is not changed.
    expect(loaded.strokes).toEqual([])
    expect(loaded.bg).toBe('none')
  })
})

describe('boxes and views', () => {
  it('puts a box around the strokes with room, an empty drawing has the server size', () => {
    expect(bounds([])).toEqual(EMPTY_BOX)
    expect(bounds([pen([[0, 0], [100, 50]], 10)])).toEqual({ x: -7 - 24, y: -7 - 24, w: 114 + 48, h: 64 + 48 })
    // A highlighter reaches three times its size wide.
    const marker: InkStroke = { tool: 'marker', color: INK, size: 4, pts: [[0, 0, 0.5]] }
    expect(bounds([marker], 0)).toEqual({ x: -6, y: -6, w: 12, h: 12 })
  })

  it('fits a box into a window, centred, and never closer than allowed', () => {
    const fit = fitTo({ x: 0, y: 0, w: 200, h: 100 }, 416, 416, 8)
    expect(fit.z).toBe(2)
    expect(fit.x).toBe(100 - 104)
    expect(fit.y).toBe(50 - 104)
    expect(fitTo({ x: 0, y: 0, w: 10, h: 10 }, 1000, 1000).z).toBe(2.5)
    expect(fitTo({ x: 0, y: 0, w: 1e6, h: 1e6 }, 100, 100).z).toBe(LIMITS.minZoom)
  })

  it('zooms around the pointer: what is under it stays', () => {
    const before = { x: 10, y: 20, z: 2 }
    const after = zoomAt(before, 1.5, 100, 40)
    expect(after.z).toBe(3)
    expect(toDrawing(after, 100, 40)).toEqual(toDrawing(before, 100, 40))
    expect(zoomAt(before, 100, 0, 0).z).toBe(LIMITS.maxZoom)
    expect(zoomAt(before, 0.0001, 0, 0).z).toBe(LIMITS.minZoom)
  })

  it('moves with the hand and turns pixels into drawing units', () => {
    expect(panBy({ x: 10, y: 10, z: 2 }, 20, -40)).toEqual({ x: 0, y: 30, z: 2 })
    expect(toDrawing({ x: -5, y: 5, z: 4 }, 8, 12)).toEqual([-3, 8])
    expect(viewBoxOf({ x: 1.234, y: -2, z: 2 }, 300, 150)).toBe('1.23 -2 150 75')
  })

  it('gives a block the shape of its drawing, within reason', () => {
    expect(fittedHeight({ x: 0, y: 0, w: 200, h: 100 }, 600)).toBe(300)
    expect(fittedHeight({ x: 0, y: 0, w: 1000, h: 10 }, 600)).toBe(120)
    expect(fittedHeight({ x: 0, y: 0, w: 10, h: 1000 }, 600)).toBe(560)
  })

  it('shows the kept view in a block (D9), else everything; "show all" keeps the height', () => {
    const strokes = [line(0, 400)]
    const view = { x: 50, y: 60, z: 1.5, h: 333 }
    expect(blockPlacement({ strokes, view }, 700)).toEqual(view)
    const whole = blockPlacement({ strokes, view }, 700, true)
    expect(whole.h).toBe(333)
    expect(whole).toMatchObject(fitTo(bounds(strokes), 700, 333))
    const plain = blockPlacement({ strokes }, 700)
    expect(plain.h).toBe(fittedHeight(bounds(strokes), 700))
    expect(plain).toMatchObject(fitTo(bounds(strokes), 700, plain.h))
  })

  it('writes a view only when it changed, rounded as a file keeps it', () => {
    const kept = { x: 1.2, y: 3.4, z: 1.5, h: 300 }
    expect(changedView(kept, { x: 1.21, y: 3.39, z: 1.50001, h: 300 })).toBeNull()
    expect(changedView(kept, { x: 1.2, y: 3.4, z: 1.5, h: 301 })).toEqual({ ...kept, h: 301 })
    expect(changedView(undefined, { x: 1.26, y: -3.44, z: 2.123456, h: 50 })).toEqual({ x: 1.3, y: -3.4, z: 2.1235, h: LIMITS.minHeight })
  })

  it('pushes the picture along when the pen writes on at the edge', () => {
    expect(followEdge(300, 100, 600, 400, 2)).toEqual([0, 0])
    expect(followEdge(590, 100, 600, 400, 2)).toEqual([3, 0])
    expect(followEdge(5, 395, 600, 400, 2)).toEqual([-3, 3])
    expect(followEdge(300, 10, 600, 400, 1)).toEqual([0, -6])
  })
})

describe('strokes as shapes', () => {
  it('a pen is a filled outline as wide as its pressure, round at both ends', () => {
    const shape = strokeShape(pen([[0, 0], [10, 0], [20, 0]], 4))
    expect(shape.filled).toBe(true)
    expect(shape.d.startsWith('M')).toBe(true)
    expect(shape.d.endsWith('Z')).toBe(true)
    expect(shape.d.match(/A/g)).toHaveLength(2)
    // Half the width at pressure 0.5 on either side of the line: y = ±1.65.
    expect(shape.d).toContain('M0 1.7')
    expect(shape.d).toContain('A1.7 1.7 0 0 0 20 -1.6')
    expect(widthAt(4, 0)).toBeCloseTo(1.4)
    expect(widthAt(4, 1)).toBeCloseTo(5.2)
  })

  it('a heavier hand draws wider', () => {
    const light = strokeShape({ tool: 'pen', size: 4, pts: [[0, 0, 0.1], [10, 0, 0.1]] }).d
    const heavy = strokeShape({ tool: 'pen', size: 4, pts: [[0, 0, 1], [10, 0, 1]] }).d
    const top = (d: string) => Number(/^M\S+ (\S+?)L/.exec(d)![1])
    expect(top(heavy)).toBeGreaterThan(top(light))
  })

  it('a single point is a dot, a highlighter a wide line', () => {
    const dot = strokeShape(pen([[5, 5]], 4))
    expect(dot.filled).toBe(true)
    expect(dot.d).toMatch(/^M[\d.]+ 5a/)
    const marker = strokeShape({ tool: 'marker', size: 4, pts: [[0, 0, 0.5], [10, 5, 0.5]] })
    expect(marker).toEqual({ d: 'M0 0L10 5', filled: false, width: 12 })
    expect(strokeShape({ tool: 'marker', size: 2, pts: [[1, 1, 0.5]] }).d).toBe('M1 1l0.1 0')
    expect(strokeShape({ tool: 'pen', size: 2, pts: [] }).d).toBe('')
  })

  it('a pen says its pressure; a mouse gets one from its speed, thinner when fast', () => {
    expect(pressureOf('pen', 0.8, null, [0, 0], 1)).toBe(0.8)
    expect(pressureOf('pen', 0, null, [0, 0], 1)).toBe(0.55)
    expect(pressureOf('mouse', 0.5, null, [0, 0], 1)).toBe(0.55)
    const slow = pressureOf('mouse', 0.5, [0, 0, 0.55], [1, 0], 1)
    const fast = pressureOf('mouse', 0.5, [0, 0, 0.55], [40, 0], 1)
    expect(fast).toBeLessThan(slow)
    expect(fast).toBeGreaterThanOrEqual(0.25)
    // The same move counts more when zoomed in.
    expect(pressureOf('mouse', 0.5, [0, 0, 0.55], [5, 0], 4)).toBeLessThan(pressureOf('mouse', 0.5, [0, 0, 0.55], [5, 0], 1))
  })

  it('keeps points as a file keeps them', () => {
    expect(keptPoint(1.234, -5.678, 0.4567)).toEqual([1.2, -5.7, 0.46])
    expect(keptPoint(5e6, -5e6, 3)).toEqual([LIMITS.coordinate, -LIMITS.coordinate, 1])
  })
})

describe('erasing', () => {
  const strokes = [line(0, 100, 0), line(0, 100, 50), line(0, 100, 100)]

  it('the whole stroke goes when the eraser touches it anywhere, also between two points', () => {
    const sparse = pen([[0, 0], [100, 0]])
    expect(touches(sparse, [50, 2.9], 1)).toBe(true)
    expect(touches(sparse, [50, 6], 1)).toBe(false)
    const left = eraseWhole(strokes, [50, 49], 3)
    expect(left).toHaveLength(2)
    expect(left).toEqual([strokes[0], strokes[2]])
    expect(left[0]).toBe(strokes[0])
  })

  it('touching nothing changes nothing, not even the array', () => {
    expect(eraseWhole(strokes, [50, 25], 3)).toBe(strokes)
    expect(erasePart(strokes, [50, 25], 3)).toBe(strokes)
  })

  it('a part takes only the points under it, the stroke falls into pieces', () => {
    const left = erasePart(strokes, [50, 50], 3)
    expect(left).toHaveLength(4)
    expect(left[0]).toBe(strokes[0])
    const pieces = left.slice(1, 3)
    expect(pieces[0].pts.at(-1)![0]).toBeLessThan(50)
    expect(pieces[1].pts[0][0]).toBeGreaterThan(50)
    expect(pieces.every((piece) => piece.pts.every((point) => Math.abs(point[0] - 50) >= 5))).toBe(true)
    // At the end of a stroke only one piece is left.
    expect(erasePart([strokes[0]], [0, 0], 3)).toHaveLength(1)
    expect(erasePart([pen([[0, 0]])], [0, 0], 3)).toEqual([])
  })

  it('a highlighter is hit as wide as it is drawn', () => {
    const marker: InkStroke = { tool: 'marker', color: MARKER_COLOR, size: 8, pts: [[0, 0, 0.5], [100, 0, 0.5]] }
    expect(touches(marker, [50, 12.5], 1)).toBe(true)
    expect(touches({ ...marker, tool: 'pen' }, [50, 12.5], 1)).toBe(false)
  })
})

describe('the lasso', () => {
  const square: Point[] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ]

  it('knows inside from outside', () => {
    expect(inPolygon([50, 50], square)).toBe(true)
    expect(inPolygon([150, 50], square)).toBe(false)
    expect(inPolygon([-1, 50], square)).toBe(false)
    const hook: Point[] = [[0, 0], [100, 0], [100, 100], [50, 100], [50, 30], [0, 30]]
    expect(inPolygon([20, 60], hook)).toBe(false)
    expect(inPolygon([70, 60], hook)).toBe(true)
  })

  it('catches strokes with more than half of their points inside', () => {
    const strokes = [line(10, 90, 50), line(60, 180, 20), line(80, 140, 70), line(200, 300, 50)]
    expect(lassoPick(strokes, square)).toEqual([0])
    expect(lassoPick(strokes, [[0, 0], [100, 0]])).toEqual([])
  })

  it('moves the chosen strokes and leaves the others as they are', () => {
    const strokes = [line(0, 10), line(0, 10, 20)]
    const moved = moveStrokes(strokes, [1], 5.04, -2)
    expect(moved[0]).toBe(strokes[0])
    expect(moved[1].pts[0]).toEqual([5, 18, 0.5])
    expect(strokes[1].pts[0]).toEqual([0, 20, 0.5])
  })

  it('takes the chosen strokes away and draws a box around them', () => {
    const strokes = [line(0, 10), line(0, 10, 20), line(0, 10, 40)]
    expect(removeStrokes(strokes, [0, 2])).toEqual([strokes[1]])
    const box = pickedBox(strokes, [1, 2], 8)!
    expect(box.x).toBeCloseTo(-10.8)
    expect(box.y).toBeCloseTo(9.2)
    expect(box.w).toBeCloseTo(31.6)
    expect(box.h).toBeCloseTo(41.6)
    expect(pickedBox(strokes, [])).toBeNull()
    expect(pickedBox(strokes, [7])).toBeNull()
    expect(inBox([0, 30], box)).toBe(true)
    expect(inBox([0, 60], box)).toBe(false)
    expect(inBox([0, 0], null)).toBe(false)
  })
})

describe('a new drawing opens at once', () => {
  it('asks its block once', () => {
    expect(takeDrawRequest('S/a.svg')).toBe(false)
    askToDraw('S/a.svg')
    expect(takeDrawRequest('S/b.svg')).toBe(false)
    expect(takeDrawRequest('S/a.svg')).toBe(true)
    expect(takeDrawRequest('S/a.svg')).toBe(false)
  })
})
