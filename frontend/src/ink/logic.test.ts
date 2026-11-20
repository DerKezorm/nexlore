import { INK, LIMITS, MARKER_COLOR, type InkStroke } from '../lib/ink'
import {
  NO_HISTORY,
  START_TOOLS,
  STEPS,
  draggedHeight,
  eraserRadius,
  inkKey,
  newStroke,
  pickColor,
  pressTool,
  recorded,
  stepBack,
  stepForth,
  type Snapshot,
} from './logic'

const key = (key: string, more: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  inkKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...more })

describe('the tools', () => {
  it('start with the pen in ink, middle size, the eraser on whole strokes (D4)', () => {
    expect(START_TOOLS).toEqual({ tool: 'pen', color: INK, size: 4, eraser: 'stroke' })
  })

  it('the eraser pressed again asks which kind; every other button just chooses', () => {
    const chosen = pressTool(START_TOOLS, 'eraser')
    expect(chosen).toEqual({ tools: { ...START_TOOLS, tool: 'eraser' }, askEraser: false })
    expect(pressTool(chosen.tools, 'eraser')).toEqual({ tools: chosen.tools, askEraser: true })
    expect(pressTool(chosen.tools, 'lasso')).toEqual({ tools: { ...START_TOOLS, tool: 'lasso' }, askEraser: false })
    expect(pressTool(START_TOOLS, 'pen').askEraser).toBe(false)
  })

  it('a colour is for drawing: the eraser and the lasso give way to the pen, the highlighter stays', () => {
    expect(pickColor({ ...START_TOOLS, tool: 'eraser' }, '#ef4444')).toEqual({ ...START_TOOLS, color: '#ef4444' })
    expect(pickColor({ ...START_TOOLS, tool: 'lasso' }, '#ef4444').tool).toBe('pen')
    expect(pickColor({ ...START_TOOLS, tool: 'marker' }, '#ef4444').tool).toBe('marker')
  })

  it('a new stroke takes the tools; a highlighter in ink is yellow and never thin', () => {
    const start: [number, number, number] = [1, 2, 0.5]
    expect(newStroke(START_TOOLS, start)).toEqual({ tool: 'pen', color: INK, size: 4, pts: [start] })
    expect(newStroke({ ...START_TOOLS, tool: 'marker', size: 2 }, start)).toEqual({ tool: 'marker', color: MARKER_COLOR, size: 4, pts: [start] })
    expect(newStroke({ ...START_TOOLS, tool: 'marker', size: 8, color: '#3b82f6' }, start)).toMatchObject({ color: '#3b82f6', size: 8 })
    expect(newStroke({ ...START_TOOLS, size: 2, color: '#3b82f6' }, start)).toMatchObject({ color: '#3b82f6', size: 2 })
  })

  it('the eraser is the same size on the screen at any zoom, larger for parts and thick pens', () => {
    expect(eraserRadius(START_TOOLS, 1)).toBe(7)
    expect(eraserRadius(START_TOOLS, 2)).toBe(3.5)
    expect(eraserRadius({ ...START_TOOLS, eraser: 'part' }, 1)).toBe(13)
    expect(eraserRadius({ ...START_TOOLS, eraser: 'part', size: 8 }, 2)).toBe(10.5)
  })
})

describe('the keys', () => {
  it('choose tools with P, M, E and L, in either case, without other keys held', () => {
    expect(key('p')).toEqual({ tool: 'pen' })
    expect(key('M')).toEqual({ tool: 'marker' })
    expect(key('e')).toEqual({ tool: 'eraser' })
    expect(key('l')).toEqual({ tool: 'lasso' })
    expect(key('p', { ctrlKey: true })).toBeNull()
    expect(key('p', { altKey: true })).toBeNull()
    expect(key('x')).toBeNull()
  })

  it('step back with Ctrl or Cmd Z, forth with Shift or Ctrl Y', () => {
    expect(key('z', { ctrlKey: true })).toEqual({ act: 'undo' })
    expect(key('z', { metaKey: true })).toEqual({ act: 'undo' })
    expect(key('Z', { ctrlKey: true, shiftKey: true })).toEqual({ act: 'redo' })
    expect(key('y', { ctrlKey: true })).toEqual({ act: 'redo' })
    expect(key('z')).toBeNull()
    expect(key('z', { ctrlKey: true, altKey: true })).toBeNull()
  })

  it('delete, let go, and show all', () => {
    expect(key('Delete')).toEqual({ act: 'delete' })
    expect(key('Backspace')).toEqual({ act: 'delete' })
    expect(key('Escape')).toEqual({ act: 'escape' })
    expect(key('!', { shiftKey: true, code: 'Digit1' })).toEqual({ act: 'showAll' })
    // Another keyboard puts another sign on Shift 1; the key itself counts.
    expect(key('+', { shiftKey: true, code: 'Digit1' })).toEqual({ act: 'showAll' })
    expect(key('1')).toBeNull()
    expect(key('Delete', { ctrlKey: true })).toBeNull()
  })
})

describe('steps back and forth', () => {
  const stroke = (x: number): InkStroke => ({ tool: 'pen', color: INK, size: 4, pts: [[x, 0, 0.5]] })
  const at = (...xs: number[]): Snapshot => ({ strokes: xs.map(stroke), bg: 'none' })

  it('go back and forth through the changes', () => {
    let history = recorded(NO_HISTORY, at())
    history = recorded(history, at(1))
    let present = at(1, 2)
    const back = stepBack(history, present)!
    expect(back.present).toEqual(at(1))
    expect(back.history.future).toEqual([present])
    const forth = stepForth(back.history, back.present)!
    expect(forth.present).toEqual(present)
    expect(forth.history).toEqual(history)
    present = forth.present
    expect(stepForth(forth.history, present)).toBeNull()
  })

  it('a new change ends the way forth', () => {
    const back = stepBack(recorded(NO_HISTORY, at()), at(1))!
    expect(back.history.future).toHaveLength(1)
    expect(recorded(back.history, back.present).future).toEqual([])
  })

  it('nothing to go back to is no step', () => {
    expect(stepBack(NO_HISTORY, at(1))).toBeNull()
  })

  it(`keeps the last ${STEPS} steps`, () => {
    let history = NO_HISTORY
    for (let index = 0; index < STEPS + 5; index++) history = recorded(history, at(index))
    expect(history.past).toHaveLength(STEPS)
    expect(history.past[0]).toEqual(at(5))
    const back = stepBack({ past: history.past, future: [] }, at(999))!
    const forth = stepForth({ ...back.history, past: history.past.slice(0, -1) }, back.present)!
    expect(forth.history.past.length).toBeLessThanOrEqual(STEPS)
  })
})

describe('the height of a block', () => {
  it('follows the drag within what a file keeps', () => {
    expect(draggedHeight(300, 50)).toBe(350)
    expect(draggedHeight(300, -400)).toBe(LIMITS.minHeight)
    expect(draggedHeight(1900, 500)).toBe(LIMITS.maxHeight)
    expect(draggedHeight(300, 0.6)).toBe(301)
  })
})
