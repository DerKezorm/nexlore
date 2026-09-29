/** Which bubble names win where they would overlap. */
import { loadLucide, lucidePaths } from '../lib/lucide'
import { SYMBOLS } from '../lib/symbols'
import { closedLabelPriority, drawLabels } from './labels'

describe('names of closed bubbles', () => {
  it('put bigger bubbles first', () => {
    expect(closedLabelPriority(400, 0)).toBeGreaterThan(closedLabelPriority(80, 0))
  })

  it('let a bubble that is opening give way to every closed bubble inside it', () => {
    // A space seen whole but starting to open: its fading name must not hide the names of its folders.
    expect(closedLabelPriority(2000, 0.3)).toBeLessThan(closedLabelPriority(20, 0))
    expect(closedLabelPriority(2000, 0.01)).toBeGreaterThan(closedLabelPriority(20, 0))
  })
})

describe('a symbol chosen by hand', () => {
  /** A canvas that only notes what is drawn, and in which colour. */
  function recorder() {
    const shapes: { how: 'stroke' | 'fill'; colour: string; d: string }[] = []
    const ctx = {
      font: '', textAlign: '', textBaseline: '', globalAlpha: 1, lineWidth: 1, lineCap: '', lineJoin: '',
      strokeStyle: '', fillStyle: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
      save: () => undefined, restore: () => undefined, translate: () => undefined, scale: () => undefined,
      fillText: () => undefined, strokeText: () => undefined,
      stroke(shape: { d: string }) { shapes.push({ how: 'stroke', colour: ctx.strokeStyle, d: shape.d }) },
      fill(shape: { d: string }) { shapes.push({ how: 'fill', colour: ctx.fillStyle, d: shape.d }) },
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, shapes }
  }

  beforeEach(() => {
    vi.stubGlobal('Path2D', class { constructor(public d: string) {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  const label = (icon: string | null) => ({
    x: 200, y: 150, text: 'Homelab', size: 14, weight: 600, color: '#e5e7eb', alpha: 1, baseline: 'middle' as const,
    priority: 300, icon, iconColor: '#38bdf8',
  })

  it('is drawn above the name, in the colour of the folder', () => {
    const { ctx, shapes } = recorder()
    expect(drawLabels(ctx, [label('server')], '#000', 400, 300)).toBe(1)
    expect(shapes.length).toBeGreaterThan(0)
    expect(shapes.map((shape) => shape.d)).toEqual((SYMBOLS.server as { d: string }[]).map((path) => path.d))
    expect(new Set(shapes.map((shape) => shape.colour))).toEqual(new Set(['#38bdf8']))
  })

  it('draws a Lucide symbol once its data is there', async () => {
    const { ctx, shapes } = recorder()
    await loadLucide()
    drawLabels(ctx, [label('l:car')], '#000', 400, 300)
    expect(shapes.map((shape) => shape.d)).toEqual(lucidePaths('l:car'))
    expect(new Set(shapes.map((shape) => shape.colour))).toEqual(new Set(['#38bdf8']))
  })

  it('takes room of its own: a name just above it gives way', () => {
    const above = { ...label(null), y: 150 - 22, text: 'Other', priority: 100, iconColor: undefined }
    expect(drawLabels(recorder().ctx, [label(null), { ...above }], '#000', 400, 300)).toBe(2)
    expect(drawLabels(recorder().ctx, [label('server'), { ...above }], '#000', 400, 300)).toBe(1)
  })
})
