/**
 * The query plugin of the catalog, run as it is shipped: its own lines become filters, any other line is a search as
 * the search page reads it (what Obsidian's own query block holds), and a line it cannot read says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// Read from the disk: the file lies outside what Vite may serve, and the app's types know nothing of Node.
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync: (file: string, encoding: string) => string }
const here = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd()
const CODE = fs.readFileSync(`${here}/../backend/app/catalog/query/main.js`, 'utf-8')

async function asked(source: string): Promise<{ query: Record<string, unknown>; warnings: string[] }> {
  let query: Record<string, unknown> | null = null
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('nexlore', {
    ready: (callback: (context: { source: string }) => void) => callback({ source }),
    t: (key: string, values?: { line: string }) => (values ? `${key}:${values.line}` : key),
    ask: async (what: string, value: Record<string, unknown>) => {
      if (what === 'vault.query') query = value
      return []
    },
  })
  new Function(CODE)()
  await vi.waitFor(() => expect(document.getElementById('app')!.textContent).toContain('nothing'))
  const warnings = [...document.querySelectorAll('.warn')].map((item) => item.textContent!)
  return { query: query!, warnings }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the query block', () => {
  it('reads a search as Obsidian writes it', async () => {
    const { query, warnings } = await asked('path: "Server/"')
    expect(warnings).toEqual([])
    expect(query).toEqual({ view: 'list', q: 'path: "Server/"' })
  })

  it('keeps its own lines and joins the rest into one search', async () => {
    const { query, warnings } = await asked('tag: #garden\nview: table\nlimit: 5\nfile:plan\n-path:Archive OR words')
    expect(warnings).toEqual([])
    expect(query).toEqual({ view: 'table', tag: 'garden', limit: 5, q: 'file:plan -path:Archive OR words' })
  })

  it('takes a line with two tags as a search, not as one tag', async () => {
    const { query } = await asked('tag:#a tag:#b')
    expect(query).toEqual({ view: 'list', q: 'tag:#a tag:#b' })
  })

  it('names a line it cannot read and leaves it out of the search', async () => {
    const { query, warnings } = await asked('limt: 5\nline:(call mum)\nfile:plan section:(dig)\npath:Server')
    expect(warnings).toEqual(['unknown:limt: 5', 'unknown:line:(call mum)', 'unknown:file:plan section:(dig)'])
    expect(query).toEqual({ view: 'list', q: 'path:Server' })
  })

  it('asks for the newest notes when the block is empty, as before', async () => {
    const { query } = await asked('')
    expect(query).toEqual({ view: 'list' })
  })
})
