import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NoteData } from '../api/client'
import { PluginFrame } from './host'
import type { PluginInfo } from './registry'

const calls: { path: string; options: unknown }[] = []
vi.mock('../api/client', () => ({
  api: async (path: string, options: unknown) => {
    calls.push({ path, options })
    return path === '/api/plugins/query' ? [{ path: 'S/a.md', title: 'a' }] : { saved: true, conflict: null, hash: 'h2' }
  },
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))

const NOTE = { path: 'S/Board.md', title: 'Board', content: 'secret words', hash: 'h1' } as unknown as NoteData

function plugin(permissions: string[]): PluginInfo {
  return { id: 'probe', version: '1.0.0', author: '', name: { en: 'Probe' }, description: { en: '' }, permissions, place: { panel: true }, strings: {}, source: 'catalog', enabled: true }
}

let root: Root | null = null
let holder: HTMLDivElement | null = null
const opened: string[] = []

/** The frame of a plugin with these permissions, and a way to ask as that frame (or as someone else). */
function mount(permissions: string[]) {
  holder = document.createElement('div')
  document.body.append(holder)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => {
    root = createRoot(holder!)
    root.render(<PluginFrame plugin={plugin(permissions)} place="panel" note={NOTE} onOpen={(path) => opened.push(path)} onWritten={() => undefined} />)
  })
  const frame = holder.querySelector('iframe')!
  const replies: unknown[] = []
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message: unknown) => {
    replies.push(message)
  })
  const ask = async (method: string, args: object = {}, source: MessageEventSource | null = frame.contentWindow) => {
    replies.length = 0
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { nx: 1, id: 7, method, args }, source }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return replies[0] as { reply?: number; value?: unknown; error?: string } | undefined
  }
  return { frame, ask }
}

afterEach(() => {
  act(() => root?.unmount())
  holder?.remove()
  calls.length = 0
  opened.length = 0
})

describe('the page answers a plugin only what its manifest allows', () => {
  it('runs the frame sandboxed, without an origin of its own', () => {
    const { frame } = mount([])
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('/api/plugins/probe/frame?scheme=dark')
  })

  it('reads the note only with note:read', async () => {
    expect(await mount([]).ask('note.read')).toEqual({ nx: 1, reply: 7, error: 'not_allowed' })
    act(() => root?.unmount())
    const answer = await mount(['note:read']).ask('note.read')
    expect(answer?.value).toEqual({ path: 'S/Board.md', title: 'Board', content: 'secret words', hash: 'h1' })
  })

  it('writes only with note:write, and only the note it sits on', async () => {
    expect((await mount(['note:read']).ask('note.write', { content: 'x', base_hash: 'h1' }))?.error).toBe('not_allowed')
    expect(calls).toEqual([])
    act(() => root?.unmount())
    await mount(['note:write']).ask('note.write', { content: 'x', base_hash: 'h1', path: 'Other/space.md' })
    expect(calls).toEqual([{ path: '/api/plugins/note', options: { method: 'PUT', body: { plugin: 'probe', path: 'S/Board.md', content: 'x', base_hash: 'h1' } } }])
  })

  it('lists notes only with vault:read, and passes on only the known query words', async () => {
    expect((await mount([]).ask('vault.query', { tag: 'x' }))?.error).toBe('not_allowed')
    act(() => root?.unmount())
    const answer = await mount(['vault:read']).ask('vault.query', { tag: 'veg', url: 'https://example.com' })
    expect(answer?.value).toEqual([{ path: 'S/a.md', title: 'a' }])
    expect(calls).toEqual([{ path: '/api/plugins/query', options: { query: { tag: 'veg' } } }])
  })

  it('listens to its own frame only', async () => {
    const { ask } = mount(['note:read'])
    expect(await ask('note.read', {}, window)).toBeUndefined()
    expect(await ask('note.open', { path: 'S/Other.md' }, null)).toBeUndefined()
    expect(opened).toEqual([])
    await ask('note.open', { path: 'S/Other.md' })
    expect(opened).toEqual(['S/Other.md'])
    expect((await ask('note.open', { path: 42 }))?.error).toBe('not_allowed')
    expect((await ask('window.close'))?.error).toBe('not_allowed')
  })

  it('opens only notes, and only for a plugin that may read', async () => {
    const reader = mount(['note:read'])
    for (const path of ['javascript:window.x=1.md', 'https://example.com/a.md', '/etc/a.md', 'S/Other', 'x'.repeat(1030) + '.md']) {
      expect((await reader.ask('note.open', { path }))?.error).toBe('not_allowed')
    }
    expect(opened).toEqual([])
    act(() => root?.unmount())
    holder?.remove()
    const blind = mount([])
    expect((await blind.ask('note.open', { path: 'S/Other.md' }))?.error).toBe('not_allowed')
    expect(opened).toEqual([])
  })
})
