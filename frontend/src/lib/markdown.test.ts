/** The reading view never turns a note into code that runs. */

import { renderMarkdown, safeUrl } from './markdown'
import { buildVault } from './vault'

const vault = buildVault([])

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
    const html = renderMarkdown(`[x](${href}) and ![y](${href})`, vault)
    expect(html.toLowerCase()).not.toMatch(/(?:href|src)="\s*(?:java|vb)?\s*script|(?:href|src)="data:|(?:href|src)="file:/)
  })

  it.each(['https://example.com', 'http://example.com/a?b=c', 'mailto:someone@example.com', 'Anhänge/foto.webp', '../Notiz.md', '#heading'])(
    'keeps %s',
    (href) => {
      expect(safeUrl(href)).toBe(true)
      expect(renderMarkdown(`[x](${href})`, vault)).toContain('href="')
    },
  )

  it('shows raw HTML in a note as text', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> and <script>alert(1)</script>', vault)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })
})
