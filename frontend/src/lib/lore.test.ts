import { describe, expect, it } from 'vitest'

import type { LoreSource } from '../api/client'
import { answerHtml, answerParts, sourceUrl, splitEvents } from './lore'

const SOURCES: LoreSource[] = [
  { n: 1, path: 'Wissen/Backups/Backup-Strategie.md', title: 'Backup-Strategie', heading: 'Fotos', excerpt: '' },
  { n: 2, path: 'Wissen/ZFS-Pool.md', title: 'ZFS-Pool', heading: '', excerpt: '' },
]

describe('the stream of events', () => {
  it('hands on whole events and keeps what is still coming', () => {
    const first = splitEvents('event: start\ndata: {"conversation": 4, "sources": [], "trace": null}\n\nevent: delta\ndata: {"t": "Stü')
    expect(first.events).toEqual([{ name: 'start', data: { conversation: 4, sources: [], trace: null } }])
    const second = splitEvents(first.rest + 'ndlich"}\n\nevent: done\ndata: {"conversation": 4, "message": 9}\n\n')
    expect(second.events).toEqual([
      { name: 'delta', data: { t: 'Stündlich' } },
      { name: 'done', data: { conversation: 4, message: 9 } },
    ])
    expect(second.rest).toBe('')
  })

  it('reads CRLF lines and skips a broken one without losing the next', () => {
    const read = splitEvents('event: delta\r\ndata: {broken\r\n\r\nevent: delta\r\ndata: {"t": "ok"}\r\n\r\n: a comment\n\n')
    expect(read.events).toEqual([{ name: 'delta', data: { t: 'ok' } }])
  })
})

describe('the answer', () => {
  it('takes out what the notes do not say', () => {
    expect(answerParts('Hourly [1].\n\n!missing: when the copy was last checked\n!MISSING:   ')).toEqual({
      body: 'Hourly [1].',
      missing: ['when the copy was last checked'],
    })
  })

  it('makes chips of the numbers that are sources, and of nothing else', () => {
    const html = answerHtml('Hourly [1], see [2] and [7]. Code: `[1]`', SOURCES)
    const box = document.createElement('div')
    box.innerHTML = html
    const chips = [...box.querySelectorAll('button[data-source]')].map((chip) => chip.getAttribute('data-source'))
    expect(chips).toEqual(['1', '2'])
    expect(box.textContent).toContain('[7]')
    expect(box.querySelector('code')?.textContent).toBe('[1]')
  })

  it('says the same source twice in a row once', () => {
    const box = document.createElement('div')
    box.innerHTML = answerHtml('Hourly [1] [1][1], then [2] and [1].', SOURCES)
    expect([...box.querySelectorAll('sup button[data-source]')].map((chip) => chip.textContent)).toEqual(['1', '2', '1'])
  })

  it('leads a wiki link to its source and lets no HTML of the model in', () => {
    const box = document.createElement('div')
    box.innerHTML = answerHtml('See [[ZFS-Pool]]. <img src=x onerror="alert(1)"><script>alert(2)</script>', SOURCES)
    expect(box.querySelector('a[data-note]')?.getAttribute('data-note')).toBe('Wissen/ZFS-Pool.md')
    expect(box.querySelector('img, script')).toBeNull()
    expect(box.querySelector('[onerror]')).toBeNull()
    expect(box.textContent).toContain('<script>alert(2)</script>')
  })

  it('opens a source at its heading', () => {
    expect(sourceUrl(SOURCES[0])).toBe('/note/Wissen/Backups/Backup-Strategie.md#Fotos')
    expect(sourceUrl(SOURCES[1])).toBe('/note/Wissen/ZFS-Pool.md')
    expect(sourceUrl({ path: 'Wissen/ZFS-Pool.md', title: 'ZFS-Pool', heading: 'ZFS-Pool' })).toBe('/note/Wissen/ZFS-Pool.md')
  })
})
