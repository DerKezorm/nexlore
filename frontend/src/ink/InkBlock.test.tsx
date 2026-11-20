/**
 * A drawing's block in a note, against a server stood in for: what it shows, and what it sends back when drawn in
 * (the strokes of now, and everything else of the file as it came).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { InkData } from '../api/client'
import { askToDraw } from '../lib/ink'
import InkBlock from './InkBlock'
import { START_TOOLS } from './logic'
import { setTools } from './useInk'

const server = vi.hoisted(() => ({
  data: null as unknown as InkData,
  saves: [] as { path: string; ink: Record<string, unknown>; base: string }[],
  role: 'write',
}))

vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  inkApi: {
    read: vi.fn(async () => structuredClone(server.data)),
    state: vi.fn(async () => ({ hash: server.data.hash, modified: 0, lock: null })),
    save: vi.fn(async (path: string, ink: Record<string, unknown>, base: string) => {
      server.saves.push({ path, ink, base })
      server.data = { ...server.data, hash: `h${server.saves.length + 1}` }
      return { saved: true, hash: server.data.hash, conflict: null }
    }),
  },
  vaultApi: {
    lock: vi.fn(async () => ({ holder: 'tester', mine: true, expires_at: '' })),
    unlock: vi.fn(async () => undefined),
  },
}))
vi.mock('../state/store', () => ({ useStore: () => ({ spaces: [{ name: 'S', role: server.role }] }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const PATH = 'S/Attachments/Plan 1.svg'

function drawing(more: Record<string, unknown> = {}): InkData {
  return {
    path: PATH,
    ink: {
      v: 1,
      bg: 'lines',
      strokes: [{ tool: 'pen', color: 'ink', size: 4, pts: [[0, 0, 0.5], [100, 50, 0.5]] }],
      text: 'Router',
      words: [{ t: 'Router', box: [0, 0, 40, 20] }],
      later: [1, 2, 3],
      ...more,
    },
    hash: 'h1',
    size: 100,
    modified: 0,
    readonly: false,
    problem: null,
    lock: null,
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
const opened: string[] = []

async function show(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(<InkBlock path={PATH} text="Plan 1.svg" onOpen={(route) => opened.push(route)} />)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  return host
}

function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' }, pressure: { value: 0 } })
  act(() => void target.dispatchEvent(event))
}

function click(element: Element | null) {
  if (!element) throw new Error('nothing to click')
  act(() => (element as HTMLElement).click())
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lays nothing out.
  Element.prototype.scrollIntoView = () => undefined
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

beforeEach(() => {
  vi.useFakeTimers()
  server.data = drawing()
  server.saves = []
  server.role = 'write'
  opened.length = 0
  setTools(START_TOOLS)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.useRealTimers()
})

describe('a drawing in a note', () => {
  it('shows its strokes and offers to draw and to open it large', async () => {
    const block = await show()
    expect(block.querySelector('[data-ink-block]')).not.toBeNull()
    expect(block.querySelectorAll('[data-strokes] path')).toHaveLength(1)
    expect(block.querySelector('[data-paper="lines"]')).not.toBeNull()
    click(block.querySelector('[data-ink-act="open"]'))
    expect(opened).toEqual(['/file/S/Attachments/Plan%201.svg'])
  })

  it('an SVG that is no drawing stays a link to its page', async () => {
    server.data = { ...drawing(), ink: null, readonly: true, problem: 'not_ink' }
    const block = await show()
    expect(block.querySelector('[data-ink-block]')).toBeNull()
    const link = block.querySelector('a.nn-filelink')!
    expect(link.textContent).toBe('Plan 1.svg')
    expect(link.getAttribute('data-file')).toBe(PATH)
    click(link)
    expect(opened).toEqual(['/file/S/Attachments/Plan%201.svg'])
  })

  it('shows the view kept with the drawing, at its height (D9)', async () => {
    server.data = drawing({ view: { x: 10, y: 20, z: 2, h: 250 } })
    const block = await show()
    const svg = block.querySelector('[data-ink-surface] svg')!
    expect(svg.getAttribute('viewBox')).toBe('10 20 300 125')
    expect((block.querySelector('[data-ink-surface]') as HTMLElement).style.height).toBe('250px')
    // "Show all" shows everything, at the same height.
    click(block.querySelector('[data-ink-act="whole"]'))
    expect(svg.getAttribute('viewBox')).not.toBe('10 20 300 125')
    expect((block.querySelector('[data-ink-surface]') as HTMLElement).style.height).toBe('250px')
  })

  it('without the right to write, there is nothing to draw', async () => {
    server.role = 'read'
    const block = await show()
    expect(block.querySelector('[data-ink-act="draw"]')).toBeNull()
    expect(block.querySelector('[data-ink-act="open"]')).not.toBeNull()
  })

  it('drawn in, it saves after a pause: the new stroke, and the recognised text and the unknown as they came', async () => {
    const block = await show()
    click(block.querySelector('[data-ink-act="draw"]'))
    expect(block.querySelector('[data-testid="ink-toolbar"]')).not.toBeNull()
    const surface = block.querySelector('[data-ink-surface]')!
    pointer(surface, 'pointerdown', 10, 10)
    pointer(surface, 'pointermove', 40, 30)
    pointer(surface, 'pointerup', 40, 30)
    expect(server.saves).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(server.saves).toHaveLength(1)
    const sent = server.saves[0]
    expect(sent.path).toBe(PATH)
    expect(sent.base).toBe('h1')
    expect(sent.ink.text).toBe('Router')
    expect(sent.ink.words).toEqual([{ t: 'Router', box: [0, 0, 40, 20] }])
    expect(sent.ink.later).toEqual([1, 2, 3])
    expect(sent.ink.bg).toBe('lines')
    expect(sent.ink.strokes).toHaveLength(2)
    expect(sent.ink).not.toHaveProperty('view')
  })

  it('"Done" keeps the view and the height in the file; Escape too', async () => {
    for (const how of ['done', 'escape'] as const) {
      server.data = drawing()
      server.saves = []
      const block = await show()
      click(block.querySelector('[data-ink-act="draw"]'))
      if (how === 'done') click(block.querySelector('[data-ink-tool="done"]'))
      else act(() => void block.querySelector('[data-ink-surface]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(block.querySelector('[data-testid="ink-toolbar"]'), how).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1300)
      })
      expect(server.saves, how).toHaveLength(1)
      const view = server.saves[0].ink.view as Record<string, number>
      expect(Object.keys(view).sort(), how).toEqual(['h', 'x', 'y', 'z'])
      expect(view.h, how).toBeGreaterThanOrEqual(120)
      expect(server.saves[0].ink.strokes, how).toHaveLength(1)
      act(() => root?.unmount())
      host?.remove()
      root = null
    }
  })

  it('steps back with Ctrl Z and chooses tools with their keys', async () => {
    const block = await show()
    click(block.querySelector('[data-ink-act="draw"]'))
    const surface = block.querySelector('[data-ink-surface]')!
    pointer(surface, 'pointerdown', 10, 10)
    pointer(surface, 'pointermove', 40, 30)
    pointer(surface, 'pointerup', 40, 30)
    expect(block.querySelectorAll('[data-strokes] path')).toHaveLength(2)
    act(() => void surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })))
    expect(block.querySelectorAll('[data-strokes] path')).toHaveLength(1)
    // A step back is saved like any change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(server.saves.at(-1)!.ink.strokes).toHaveLength(1)
    act(() => void surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })))
    expect(block.querySelectorAll('[data-strokes] path')).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(server.saves.at(-1)!.ink.strokes).toHaveLength(2)
    act(() => void surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })))
    expect(surface.getAttribute('data-tool')).toBe('eraser')
  })

  it('a drawing just made from the note opens for drawing at once', async () => {
    askToDraw(PATH)
    const block = await show()
    expect(block.querySelector('[data-testid="ink-toolbar"]')).not.toBeNull()
    expect(block.querySelector('[data-ink-block]')!.hasAttribute('data-editing')).toBe(true)
  })
})
