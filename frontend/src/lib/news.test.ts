// @vitest-environment jsdom
/**
 * MCP 14: "a program waits for your yes" stands in the bell ("Neu" in the sidebar, the module's `RequestBellRow`):
 * `refreshNews` asks the waiting requests of the account with the notes and notices, and keeps only waiting ones.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const asked: string[] = []

vi.mock('../api/client', () => ({
  newsApi: { list: () => Promise.resolve({ count: 0, notes: [], mentions: [] }), seenAll: () => Promise.resolve() },
  noticesApi: { list: () => Promise.resolve([]), accept: vi.fn(), decline: vi.fn() },
  api: vi.fn(),
}))

vi.mock('./mcpModule', () => ({
  mcpRequest: (path: string) => {
    asked.push(path)
    return Promise.resolve([
      { id: 7, status: 'waiting', tool: 'create_note', key_name: 'Agent' },
      { id: 8, status: 'done', tool: 'create_note', key_name: 'Agent' },
    ])
  },
}))

afterEach(() => {
  asked.length = 0
})

describe('the bell', () => {
  it('holds the requests that wait for the account, asked with the news', async () => {
    const { refreshNews, useNews } = await import('./news')
    await refreshNews()
    expect(asked).toEqual(['/api/connections/mcp/requests?status=waiting'])
    // What the sidebar renders its bell rows from.
    const seen: unknown[] = []
    function Bell() {
      seen.push(useNews().requests.map((request) => request.id))
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(createElement(Bell)))
    expect(seen.at(-1)).toEqual([7])
    await act(async () => root.unmount())
  })
})
