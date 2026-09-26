/** The reading view never turns a note into code that runs. */

import { renderMarkdown, safeUrl, withoutFrontMatter } from './markdown'

const nowhere = () => null

describe('the reading view', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('refuses %s as a target', (href) => {
    expect(safeUrl(href)).toBe(false)
    const html = renderMarkdown(`[x](${href}) and ![y](${href})`, nowhere)
    expect(html.toLowerCase()).not.toMatch(/(?:href|src)="\s*(?:java|vb)?\s*script|(?:href|src)="data:|(?:href|src)="file:/)
  })

  it.each(['https://example.com', 'http://example.com/a?b=c', 'mailto:someone@example.com', 'Anhänge/foto.webp', '../Notiz.md', '#heading'])(
    'keeps %s',
    (href) => {
      expect(safeUrl(href)).toBe(true)
      expect(renderMarkdown(`[x](${href})`, nowhere)).toContain('href="')
    },
  )

  it('shows raw HTML in a note as text', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> and <script>alert(1)</script>', nowhere)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })

  it('links wiki links where the server says they point, and marks the missing', () => {
    const html = renderMarkdown('[[Plan|the plan]] and [[Nowhere]]', (target) => (target === 'Plan' ? 'S/Plan.md' : null))
    expect(html).toContain('data-note="S/Plan.md">the plan</a>')
    expect(html).toContain('nn-wikilink-missing')
  })

  it('escapes a path that tries to break out of the attribute', () => {
    const html = renderMarkdown('[[x]]', () => 'S/"><script>.md')
    expect(html).not.toContain('<script')
  })

  it('leaves out the front matter', () => {
    expect(withoutFrontMatter('---\ntags: [a]\n---\n# Title')).toBe('# Title')
    expect(withoutFrontMatter('text\n---\nnot front matter\n---\n')).toBe('text\n---\nnot front matter\n---\n')
  })
})
