import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { INK, type InkStroke, type Placement } from '../lib/ink'
import { InkSurface } from './InkSurface'
import { START_TOOLS, type Tools } from './logic'
import type { InkController } from './useInk'

/** The drawing's side of the surface, without a server: what it was told. */
function controller(strokes: InkStroke[] = [], selection: number[] = []): InkController {
  return {
    path: 'S/a.svg',
    status: 'ready',
    error: null,
    problem: null,
    readonly: false,
    lockedBy: null,
    dirty: false,
    conflict: null,
    dismissConflict: () => undefined,
    flush: async () => undefined,
    reload: async () => undefined,
    loaded: { v: 1, bg: 'none', strokes },
    source: 'S/a.svg',
    strokes,
    bg: 'none',
    view: undefined,
    commit: vi.fn(),
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    selection,
    select: vi.fn(),
    keepView: vi.fn(),
    space: { current: false },
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null

type Shown = { surface: HTMLElement; onPlace: ReturnType<typeof vi.fn> }

function show(ink: InkController, options: { tools?: Partial<Tools>; place?: Placement; moves?: boolean; draws?: boolean; echo?: HTMLElement } = {}): Shown {
  host = document.createElement('div')
  document.body.append(host)
  const onPlace = vi.fn()
  act(() => {
    root = createRoot(host!)
    root.render(
      <InkSurface
        ink={ink}
        tools={{ ...START_TOOLS, ...options.tools }}
        place={options.place ?? { x: 0, y: 0, z: 1 }}
        onPlace={onPlace}
        moves={options.moves ?? true}
        draws={options.draws ?? true}
        height={300}
        echo={options.echo}
      />,
    )
  })
  return { surface: host.querySelector<HTMLElement>('[data-ink-surface]')!, onPlace }
}

/** A pointer event as a browser sends it (jsdom knows no PointerEvent of its own). */
function pointer(target: HTMLElement, type: string, x: number, y: number, more: { id?: number; kind?: string; button?: number; pressure?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: more.button ?? 0 })
  Object.defineProperties(event, {
    pointerId: { value: more.id ?? 1 },
    pointerType: { value: more.kind ?? 'mouse' },
    pressure: { value: more.pressure ?? 0.5 },
  })
  act(() => void target.dispatchEvent(event))
  return event
}

function drag(target: HTMLElement, points: [number, number][], more: Parameters<typeof pointer>[4] = {}) {
  pointer(target, 'pointerdown', points[0][0], points[0][1], more)
  for (const [x, y] of points.slice(1)) pointer(target, 'pointermove', x, y, more)
  const [x, y] = points[points.length - 1]
  pointer(target, 'pointerup', x, y, more)
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

const line = (y: number): InkStroke => ({ tool: 'pen', color: INK, size: 4, pts: [[0, y, 0.5], [50, y, 0.5], [100, y, 0.5]] })

describe('the drawing surface', () => {
  it('draws a stroke with the mouse, in drawing units of the view, and commits it when lifted', () => {
    const ink = controller([line(0)])
    const { surface } = show(ink, { place: { x: 100, y: 50, z: 2 } })
    drag(surface, [[20, 10], [40, 10], [60, 30], [60.5, 30]])
    expect(ink.commit).toHaveBeenCalledTimes(1)
    const [strokes] = (ink.commit as ReturnType<typeof vi.fn>).mock.calls[0] as [InkStroke[]]
    expect(strokes).toHaveLength(2)
    expect(strokes[0]).toBe(ink.strokes[0])
    const drawn = strokes[1]
    expect(drawn).toMatchObject({ tool: 'pen', color: INK, size: 4 })
    // A point closer than a pixel and a bit to the last adds nothing.
    expect(drawn.pts.map(([x, y]) => [x, y])).toEqual([
      [110, 55],
      [120, 55],
      [130, 65],
    ])
    expect(drawn.pts.every(([, , p]) => p > 0 && p <= 1)).toBe(true)
  })

  it('takes the pen pressure as the pen says it', () => {
    const ink = controller()
    const { surface } = show(ink)
    drag(surface, [[0, 0], [20, 0]], { kind: 'pen', pressure: 0.9 })
    const [strokes] = (ink.commit as ReturnType<typeof vi.fn>).mock.calls[0] as [InkStroke[]]
    expect(strokes[0].pts.map((point) => point[2])).toEqual([0.9, 0.9])
  })

  it('a highlighter in ink draws yellow and wide', () => {
    const ink = controller()
    const { surface } = show(ink, { tools: { tool: 'marker', size: 2 } })
    drag(surface, [[0, 0], [20, 0]])
    const [strokes] = (ink.commit as ReturnType<typeof vi.fn>).mock.calls[0] as [InkStroke[]]
    expect(strokes[0]).toMatchObject({ tool: 'marker', color: '#facc15', size: 4 })
  })

  it('a finger moves the picture and never draws', () => {
    const ink = controller()
    const { surface, onPlace } = show(ink, { place: { x: 0, y: 0, z: 2 } })
    drag(surface, [[100, 100], [80, 60]], { kind: 'touch' })
    expect(ink.commit).not.toHaveBeenCalled()
    expect(onPlace).toHaveBeenLastCalledWith({ x: 10, y: 20, z: 2 })
  })

  it('the right or the middle button, or Space held, move the picture', () => {
    for (const how of ['right', 'middle', 'space'] as const) {
      const ink = controller()
      if (how === 'space') ink.space.current = true
      const { surface, onPlace } = show(ink, { place: { x: 0, y: 0, z: 1 } })
      drag(surface, [[50, 50], [70, 40]], { button: how === 'right' ? 2 : how === 'middle' ? 1 : 0 })
      expect(ink.commit, how).not.toHaveBeenCalled()
      expect(onPlace, how).toHaveBeenLastCalledWith({ x: -20, y: 10, z: 1 })
      act(() => root?.unmount())
      host?.remove()
      root = null
    }
  })

  it('only shows where it does not draw: no stroke, no move, the page scrolls with a finger', () => {
    const ink = controller()
    const { surface, onPlace } = show(ink, { moves: false, draws: false })
    drag(surface, [[0, 0], [40, 40]])
    drag(surface, [[0, 0], [40, 40]], { kind: 'touch' })
    expect(ink.commit).not.toHaveBeenCalled()
    expect(onPlace).not.toHaveBeenCalled()
    expect(surface.style.touchAction).toBe('pan-y')
    expect(surface.getAttribute('tabindex')).toBeNull()
  })

  it('a drawing it may not change is not drawn in', () => {
    const ink = { ...controller(), readonly: true }
    const { surface } = show(ink)
    drag(surface, [[0, 0], [40, 40]])
    expect(ink.commit).not.toHaveBeenCalled()
  })

  it('a stroke the browser broke off is not kept', () => {
    const ink = controller()
    const { surface } = show(ink)
    pointer(surface, 'pointerdown', 0, 0)
    pointer(surface, 'pointermove', 30, 0)
    pointer(surface, 'pointercancel', 30, 0)
    expect(ink.commit).not.toHaveBeenCalled()
  })

  it('the eraser takes the stroke it touches, once, when lifted', () => {
    const ink = controller([line(0), line(40)])
    const { surface } = show(ink, { tools: { tool: 'eraser' } })
    drag(surface, [[50, 38], [60, 41]])
    expect(ink.commit).toHaveBeenCalledTimes(1)
    expect(ink.commit).toHaveBeenCalledWith([ink.strokes[0]])
  })

  it('the eraser touching nothing changes nothing', () => {
    const ink = controller([line(0)])
    const { surface } = show(ink, { tools: { tool: 'eraser' } })
    drag(surface, [[50, 100], [60, 120]])
    expect(ink.commit).not.toHaveBeenCalled()
  })

  it('the eraser for parts leaves the pieces', () => {
    const ink = controller([{ tool: 'pen', color: INK, size: 2, pts: [0, 10, 20, 30, 40, 50, 60].map((x) => [x, 0, 0.5]) }])
    const { surface } = show(ink, { tools: { tool: 'eraser', eraser: 'part', size: 2 } })
    drag(surface, [[30, 0], [30, 1]])
    const [strokes] = (ink.commit as ReturnType<typeof vi.fn>).mock.calls[0] as [InkStroke[]]
    expect(strokes).toHaveLength(2)
  })

  it('the lasso chooses strokes, and dragging the chosen ones moves them', () => {
    const ink = controller([line(0), line(200)])
    const { surface } = show(ink, { tools: { tool: 'lasso' } })
    drag(surface, [[-10, -10], [120, -10], [120, 20], [-10, 20]])
    expect(ink.select).toHaveBeenLastCalledWith([0])
    act(() => root?.unmount())
    host?.remove()
    const chosen = controller([line(0), line(200)], [0])
    const again = show(chosen, { tools: { tool: 'lasso' } })
    expect(again.surface.querySelector('[data-chosen="1"]')).not.toBeNull()
    drag(again.surface, [[50, 0], [60, 30]])
    expect(chosen.commit).toHaveBeenCalledTimes(1)
    const [strokes] = (chosen.commit as ReturnType<typeof vi.fn>).mock.calls[0] as [InkStroke[]]
    expect(strokes[0].pts[0]).toEqual([10, 30, 0.5])
    expect(strokes[1]).toBe(chosen.strokes[1])
  })

  it('drawing lets go of what the lasso chose', () => {
    const ink = controller([line(0)], [0])
    const { surface } = show(ink)
    drag(surface, [[300, 300], [320, 300]])
    expect(ink.select).toHaveBeenCalledWith([])
  })

  it('the wheel moves the picture, with Ctrl it zooms around the pointer; only where the surface moves', () => {
    const ink = controller()
    const { surface, onPlace } = show(ink, { place: { x: 0, y: 0, z: 1 } })
    act(() => void surface.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })))
    expect(onPlace).toHaveBeenLastCalledWith({ x: 0, y: 100, z: 1 })
    act(() => void surface.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 50, bubbles: true, cancelable: true })))
    const zoomed = onPlace.mock.lastCall![0] as Placement
    expect(zoomed.z).toBeGreaterThan(1)
    // The point under the pointer stays (50, 150 in the view moved before).
    expect(zoomed.x + 50 / zoomed.z).toBeCloseTo(50)
    act(() => root?.unmount())
    host?.remove()
    const still = show(controller(), { moves: false, draws: false })
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    act(() => void still.surface.dispatchEvent(wheel))
    expect(still.onPlace).not.toHaveBeenCalled()
    expect(wheel.defaultPrevented).toBe(false)
  })

  it('the paper is laid over what the view shows', () => {
    const ink = { ...controller(), bg: 'grid' as const }
    const { surface } = show(ink, { place: { x: 10, y: 20, z: 2 } })
    const paper = surface.querySelector('[data-paper="grid"]')!
    expect(paper.getAttribute('x')).toBe('10')
    expect(paper.getAttribute('y')).toBe('20')
    expect(paper.getAttribute('height')).toBe('150')
  })

  it('beside a canvas it draws the strokes in ink once more in the echo, in its view, the chosen ones dimmed', () => {
    const echo = document.createElement('div')
    document.body.append(echo)
    const strokes: InkStroke[] = [
      { tool: 'pen', color: INK, size: 3, pts: [[0, 0, 0.5], [40, 40, 0.5]] },
      { tool: 'pen', color: '#ff0000', size: 3, pts: [[0, 40, 0.5], [40, 0, 0.5]] },
      { tool: 'pen', color: INK, size: 3, pts: [[10, 10, 0.5], [30, 10, 0.5]] },
    ]
    const { surface } = show(controller(strokes, [2]), { place: { x: 10, y: 20, z: 2 }, echo })
    // On the surface all three, the two in ink marked; in the echo only those two, in the surface's view.
    expect(surface.querySelectorAll('[data-strokes] path')).toHaveLength(3)
    expect(surface.querySelectorAll('[data-strokes] path[data-ink]')).toHaveLength(2)
    const twice = echo.querySelector('svg[data-ink-echo]')!
    expect(twice.querySelectorAll('path')).toHaveLength(2)
    expect(twice.querySelector('path[fill="#ff0000"], path[stroke="#ff0000"]')).toBeNull()
    expect(twice.getAttribute('viewBox')).toBe(surface.querySelector('svg')!.getAttribute('viewBox'))
    expect(twice.querySelectorAll('path[opacity]')).toHaveLength(1)
    echo.remove()
  })
})
