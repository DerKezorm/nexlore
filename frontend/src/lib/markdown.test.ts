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

  it('shows pictures of the vault through the server and links other files to their page', () => {
    const html = renderMarkdown('![](Anh%C3%A4nge/Foto%201.png) and [doc](Anhänge/doc.pdf) and [other](Other.md)', nowhere, 'Home/Shopping.md')
    expect(html).toContain(`src="/api/file?path=${encodeURIComponent('Home/Anhänge/Foto 1.png')}"`)
    expect(html).toContain(`href="/file/Home/${encodeURIComponent('Anhänge')}/doc.pdf"`)
    expect(html).toContain('href="Other.md"')
  })

  it('shows an embedded picture, video or sound where it is embedded, other files as a link', () => {
    const where: Record<string, string> = {
      'photo.png': 'Home/A/photo.png', 'clip.mp4': 'Home/A/clip.mp4', 'song.mp3': 'Home/A/song.mp3', 'doc.pdf': 'Home/A/doc.pdf',
    }
    const html = renderMarkdown('![[photo.png|300]] ![[clip.mp4]] ![[song.mp3]] ![[doc.pdf]] [[doc.pdf|the doc]]', (target) => where[target] ?? null)
    expect(html).toContain('<img class="nn-embed" src="/api/file?path=Home%2FA%2Fphoto.png" alt="photo.png" style="width:300px">')
    expect(html).toContain('<video class="nn-embed" src="/api/file?path=Home%2FA%2Fclip.mp4" controls')
    expect(html).toContain('<audio class="nn-embed" src="/api/file?path=Home%2FA%2Fsong.mp3" controls')
    expect(html).toContain('data-file="Home/A/doc.pdf" href="/file/Home/A/doc.pdf">doc.pdf</a>')
    expect(html).toContain('data-file="Home/A/doc.pdf" href="/file/Home/A/doc.pdf">the doc</a>')
  })

  it('leaves out the front matter', () => {
    expect(withoutFrontMatter('---\ntags: [a]\n---\n# Title')).toBe('# Title')
    expect(withoutFrontMatter('text\n---\nnot front matter\n---\n')).toBe('text\n---\nnot front matter\n---\n')
  })
})
