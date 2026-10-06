import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import { describe, expect, it } from 'vitest'

import { classicWorker, heightOf, linkedIn, openable, pageOf, plainName } from './pdfFrame'

describe('the page and height of a PDF link', () => {
  it('come from #page= and #height=, as Obsidian writes them', () => {
    expect(pageOf('page=6')).toBe(6)
    expect(pageOf('page=6&height=400')).toBe(6)
    expect(pageOf('height=400&page=2')).toBe(2)
    expect(pageOf('')).toBe(1)
    expect(pageOf('page=0')).toBe(1)
    expect(heightOf('page=2&height=400')).toBe(400)
    expect(heightOf('')).toBe(480)
    expect(heightOf('height=5')).toBe(480)
    expect(heightOf('height=9999')).toBe(2000)
  })
})

describe('what the frame may ask for', () => {
  it('is a plain file name, never a path', () => {
    expect(plainName('78-EUC-H.bcmap')).toBe(true)
    expect(plainName('FoxitSans.pfb')).toBe(true)
    expect(plainName('openjpeg.wasm')).toBe(true)
    for (const bad of ['../secret', 'a/b', '..bcmap', '', '.hidden', 'x'.repeat(200), 'a b']) expect(plainName(bad)).toBe(false)
  })

  it('opens only the web and mail from a PDF', () => {
    expect(openable('https://example.com/a')).toBe(true)
    expect(openable('mailto:a@example.com')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '/api/file?path=x', 'data:text/html,x', ' https://x']) expect(openable(bad)).toBe(false)
  })
})

describe("pdf.js's worker", () => {
  it('runs as a classic script once the module parts are gone', () => {
    const classic = classicWorker(workerSource)
    expect(classic).not.toMatch(/import\.meta/)
    expect(classic).not.toMatch(/export\s*\{/)
    // Parsed, not run, as plain script code: a module's syntax (import, export) would throw here.
    expect(() => new Function(classic)).not.toThrow()
    expect(classic).toContain('WorkerMessageHandler')
  })

  it('refuses a worker that is still a module', () => {
    expect(() => classicWorker('import x from "y"\nexport { WorkerMessageHandler }')).toThrow()
    expect(() => classicWorker('const a = import.meta.url; export{Other};')).toThrow()
  })
})

describe('the notes that link a PDF', () => {
  it('come once each, with the pages they name', () => {
    const notes = linkedIn({
      outgoing: [],
      backlinks: [
        { path: 'A.md', title: 'A', line: 1, kind: 'wiki', subpath: 'page=6' },
        { path: 'A.md', title: 'A', line: 3, kind: 'wiki', subpath: 'page=4' },
        { path: 'A.md', title: 'A', line: 5, kind: 'wiki', subpath: 'page=4&height=300' },
        { path: 'B.md', title: 'B', line: 1, kind: 'embed', subpath: '' },
      ],
    })
    expect(notes).toEqual([
      { path: 'A.md', title: 'A', pages: [4, 6], whole: false },
      { path: 'B.md', title: 'B', pages: [], whole: true },
    ])
  })
})
