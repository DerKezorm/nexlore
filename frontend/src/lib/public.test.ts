import type { PublicPage } from '../api/client'
import { safeNext } from './auth'
import { renderMarkdown } from './markdown'
import { publicRoute, publicTargets } from './public'

const TOKEN = 'tok_en-123456789012345678'

function render(content: string, links: PublicPage['links']): string {
  const page: PublicPage = { path: 'Roses.md', title: 'Roses', content, links }
  const { resolve, targets } = publicTargets(TOKEN, page)
  return renderMarkdown(page.content, resolve, null, targets)
}

describe('a public page', () => {
  it('links notes of the share within the share', () => {
    const html = render('See [[Tulips]].', [{ kind: 'wiki', target: 'Tulips', note: 'Sub/Tulips.md', file: null }])
    expect(html).toContain(`href="/s/${TOKEN}/Sub/Tulips.md"`)
    expect(html).not.toContain('data-note')
  })

  it('shows a link out of the share as its text, never as a link or a hint', () => {
    const html = render('See [[Diary]] and [[Diary|my diary]].', [{ kind: 'wiki', target: 'Diary', note: null, file: null }])
    expect(html).toContain('See Diary and my diary.')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('nn-wikilink-missing')
  })

  it('takes files only from the share by their number', () => {
    const html = render('![[rose.png]] and [leaflet](Attachments/leaflet.pdf)', [
      { kind: 'embed', target: 'rose.png', note: null, file: 7 },
      { kind: 'md', target: 'Attachments/leaflet.pdf', note: null, file: 9 },
    ])
    expect(html).toContain(`src="/api/public/${TOKEN}/file/7"`)
    expect(html).toContain(`href="/api/public/${TOKEN}/file/9"`)
    expect(html).not.toContain('/api/file?')
  })

  it('turns a relative Markdown link the share does not know into text', () => {
    const html = render('Read [the diary](../Private/Diary.md) or [the web](https://example.com).', [])
    expect(html).toContain('Read the diary or')
    expect(html).toContain('href="https://example.com"')
  })

  it('decodes an escaped Markdown link before looking it up', () => {
    const html = render('[Tulips](My%20Tulips.md)', [{ kind: 'md', target: 'My Tulips.md', note: 'My Tulips.md', file: null }])
    expect(html).toContain(`href="/s/${TOKEN}/My%20Tulips.md"`)
  })

  it('escapes every part of an address', () => {
    expect(publicRoute(TOKEN, 'A/50% C#.md')).toBe(`/s/${TOKEN}/A/50%25%20C%23.md`)
  })
})

describe('where the sign-in goes back to', () => {
  it('stays inside nexlore', () => {
    expect(safeNext('/note/Home/Shopping.md')).toBe('/note/Home/Shopping.md')
    expect(safeNext(null)).toBe('/')
    for (const outside of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com', 'javascript:alert(1)']) {
      expect(safeNext(outside)).toBe('/')
    }
  })
})
