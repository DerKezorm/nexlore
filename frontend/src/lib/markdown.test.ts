/** The reading view never turns a note into code that runs. */

import { appTargets, noteSection, renderMarkdown, safeUrl, shownDate, withoutFrontMatter } from './markdown'

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

  it('shows a less-than sign in code as it is written, not as an entity', () => {
    const html = renderMarkdown('```\nif a < b && c\n```\n\nand `x<y`', nowhere)
    expect(html).toContain('if a &lt; b &amp;&amp; c')
    expect(html).toContain('<code>x&lt;y</code>')
    expect(html).not.toContain('&amp;lt;')
  })

  it('keeps links and pictures in callouts and highlights to the same rules', () => {
    const html = renderMarkdown('> [!note] [t](javascript:alert(1))\n> [b](javascript:alert(2)) ![p](data:text/html,x)\n\n==[h](javascript:alert(3))==', nowhere)
    expect(html.toLowerCase()).not.toMatch(/(?:href|src)="(?:javascript|data):/)
    expect(renderMarkdown('> [!note] <img src=x onerror=alert(1)>\n> <script>alert(1)</script>', nowhere)).not.toMatch(/<img|<script/)
  })
})

describe("Obsidian's own writing in the reading view", () => {
  const plan = (target: string) => (target === 'Plan' ? 'S/Plan.md' : null)

  it('finds the target of a wiki link in a table, where the bar is written \\|', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| [[Plan\\|the plan]] | x |\n\n[[Plan\\|outside]]', plan)
    expect(html).toContain('<td><a class="nn-wikilink" data-note="S/Plan.md">the plan</a></td>')
    expect(html).toContain('data-note="S/Plan.md">outside</a>')
    expect(html).not.toContain('missing')
  })

  it('leaves wiki links in code as they are written', () => {
    const html = renderMarkdown('`[[Plan]]`\n\n```\n[[Plan]]\n```', plan)
    expect(html).not.toContain('data-note')
    expect(html.match(/\[\[Plan\]\]/g)).toHaveLength(2)
  })

  it('hides %%comments%% within a line and over lines of their own', () => {
    const html = renderMarkdown('seen %%hidden one%% seen too\n\n%%\nhidden two\n\nhidden three\n%%\n\nlast %%a%% and %%b%%', nowhere)
    expect(html).not.toMatch(/hidden|%%/)
    expect(html).toContain('seen  seen too')
    expect(html).toContain('last  and')
    // A comment that ends before the line does is not a block: the rest of the line stays.
    expect(renderMarkdown('%%a%% visible %%b%%', nowhere)).toContain('visible')
    expect(renderMarkdown('`%%code%%`', nowhere)).toContain('%%code%%')
  })

  it('shows #tags in the text as tags, the way the server reads them', () => {
    const html = renderMarkdown('#start of a line, a #tag, a #nested/tag/, an #äpfel and **#bold**\n\n#123 a#b C# `#code` [x](https://example.com/#top)', nowhere)
    // Each says its tag, for the page to lead to its notes (P4.7).
    expect(html.match(/<span class="nn-tag" data-tag="[^"]*">[^<]*<\/span>/g)).toEqual([
      '<span class="nn-tag" data-tag="start">#start</span>',
      '<span class="nn-tag" data-tag="tag">#tag</span>',
      '<span class="nn-tag" data-tag="nested/tag">#nested/tag</span>',
      '<span class="nn-tag" data-tag="äpfel">#äpfel</span>',
      '<span class="nn-tag" data-tag="bold">#bold</span>',
    ])
    expect(html).toContain('#123 a#b C#')
    expect(html).toContain('<code>#code</code>')
    expect(html).toContain('href="https://example.com/#top"')
    // A heading stays a heading.
    expect(renderMarkdown('# Title', nowhere)).toContain('<h1>Title</h1>')
  })

  it('reads a character reference as a character, never as a tag', () => {
    // The editor writes a space at the start of a line as `&#x20;` (it was shown as "&", a tag "#x20" and ";a").
    const html = renderMarkdown('&#x20;a and x&#35;y, then a #real one', nowhere)
    expect(html.match(/data-tag="[^"]*"/g)).toEqual(['data-tag="real"'])
    expect(html).toContain('&#x20;a')
  })

  it('marks ==highlights==, with Markdown inside', () => {
    expect(renderMarkdown('a ==very **important**== b', nowhere)).toContain('<mark>very <strong>important</strong></mark>')
    expect(renderMarkdown('a == b and c == d', nowhere)).not.toContain('<mark>')
    expect(renderMarkdown('`==x==`', nowhere)).not.toContain('<mark>')
  })

  it('shows callouts with their kind and title, folded shut with -, open with +, and nested', () => {
    const html = renderMarkdown('> [!Warning] Mind **this**\n> First line\n> - a point\n\nafter', nowhere)
    expect(html).toContain('<div class="nn-callout nn-callout-warning" data-callout="warning"><div class="nn-callout-title">Mind <strong>this</strong></div>')
    expect(html).toContain('<p>First line</p>')
    expect(html).toContain('<li>a point</li>')
    expect(html).toContain('<p>after</p>')
    expect(html).not.toContain('[!')
    expect(renderMarkdown('> [!tip]\n> text', nowhere)).toContain('<div class="nn-callout-title">Tip</div>')
    const shut = renderMarkdown('> [!faq]- Why?\n> Because.', nowhere)
    expect(shut).toContain('<details class="nn-callout nn-callout-faq" data-callout="faq"><summary class="nn-callout-title">Why?</summary>')
    expect(shut).not.toContain(' open')
    expect(renderMarkdown('> [!faq]+ Why?\n> Because.', nowhere)).toContain('data-callout="faq" open><summary')
    const nested = renderMarkdown('> [!note] Outer\n> > [!danger] Inner\n> > deep', nowhere)
    expect(nested).toMatch(/nn-callout-note[\s\S]*nn-callout-danger[\s\S]*<p>deep<\/p>\n<\/div><\/div>\n<\/div><\/div>/)
    // A kind that could break out of the class is a note.
    expect(renderMarkdown('> [!x" onclick="a] t', nowhere)).toContain('data-callout="note"')
    // An ordinary quote stays a quote.
    expect(renderMarkdown('> just a quote', nowhere)).toContain('<blockquote>')
  })

  it('embeds a note in a holder the note page fills, one level deep, and as a link elsewhere', () => {
    const html = renderMarkdown('![[Plan#Next steps]]\n\ntext ![[Plan]] more\n\n![[Nowhere]]', plan, 'S/Home.md')
    expect(html).toContain(
      '<div class="nn-embed-block"><span class="nn-embed-note" data-embed="S/Plan.md" data-section="Next steps"><a class="nn-wikilink" data-note="S/Plan.md" data-section="Next steps">Plan</a></span></div>',
    )
    expect(html).toContain('<p>text <span class="nn-embed-note" data-embed="S/Plan.md" data-section="">')
    expect(html).toContain('nn-wikilink-missing')
    const inside = renderMarkdown('![[Plan]]', plan, 'S/Plan.md', appTargets('S/Plan.md', false))
    expect(inside).not.toContain('data-embed')
    expect(inside).toContain('<a class="nn-wikilink" data-note="S/Plan.md">Plan</a>')
  })

  it('a link to a heading carries it, for the page to scroll to; one to a heading of the same note leads here', () => {
    const html = renderMarkdown('[[Plan#Next steps]] and [[#Here]]', plan, 'S/Home.md')
    expect(html).toContain('<a class="nn-wikilink" data-note="S/Plan.md" data-section="Next steps">Plan › Next steps</a>')
    expect(html).toContain('<a class="nn-wikilink" data-note="S/Home.md" data-section="Here">Here</a>')
    // Without a page of its own (a public page), the part of the same note stays text, as before.
    expect(renderMarkdown('[[#Here]]', plan, null, { ...appTargets(null), self: undefined })).not.toContain('data-note')
  })

  it('cuts a section out of a note: a heading down to the next of its level, or a block by its id', () => {
    const body = '---\na: 1\n---\n# Top\nintro\n## Next steps\none\n```\n# not a heading\n```\n### deeper\ntwo\n## Other\nthree'
    expect(noteSection(body, 'Next steps')).toBe('## Next steps\none\n```\n# not a heading\n```\n### deeper\ntwo')
    expect(noteSection(body, 'top#next  STEPS')).toContain('### deeper')
    expect(noteSection(body, 'Other')).toBe('## Other\nthree')
    expect(noteSection(body, 'not a heading')).toBeNull()
    expect(noteSection(body, 'Missing')).toBeNull()
    const blocks = 'First line\nsecond line ^para\n\n- item one\n- item two ^item\n- item three'
    expect(noteSection(blocks, '^para')).toBe('First line\nsecond line')
    expect(noteSection(blocks, '^item')).toBe('- item two')
    expect(noteSection(blocks, '^none')).toBeNull()
  })

  it('leaves out the front matter', () => {
    expect(withoutFrontMatter('---\ntags: [a]\n---\n# Title')).toBe('# Title')
    expect(withoutFrontMatter('text\n---\nnot front matter\n---\n')).toBe('text\n---\nnot front matter\n---\n')
  })
})

describe('dates of the properties', () => {
  it("are written in the app's language, not the computer's; what cannot be read stays as written", () => {
    expect(shownDate('2026-09-19', false, 'en')).toBe('Sep 19, 2026')
    expect(shownDate('2026-09-19', false, 'de')).toBe('19.09.2026')
    // Some ICU versions put a narrow no-break space before AM.
    expect(shownDate('2026-09-19T08:05', true, 'en').replace(/\s/g, ' ')).toBe('Sep 19, 2026, 8:05 AM')
    expect(shownDate('2026-09-19 08:05', true, 'de')).toBe('19.09.2026, 08:05')
    expect(shownDate('2026-02-30', false, 'en')).toBe('2026-02-30')
    expect(shownDate('someday', false, 'en')).toBe('someday')
  })
})

describe('pictures with a path from the top of the space (review P2.3)', () => {
  it('shows the picture the index found, not a path next to the note', () => {
    const found = (target: string) => (target === 'Anhänge/bild.png' ? 'Garden/Anhänge/bild.png' : null)
    const html = renderMarkdown('![Normales Bild](Anhänge/bild.png)', found, 'Garden/Projekte/Plan.md')
    expect(html).toContain(`src="/api/file?path=${encodeURIComponent('Garden/Anhänge/bild.png')}"`)
  })

  it('stays next to the note when the index knows nothing better', () => {
    const html = renderMarkdown('![x](bild.png)', nowhere, 'Garden/Projekte/Plan.md')
    expect(html).toContain(`src="/api/file?path=${encodeURIComponent('Garden/Projekte/bild.png')}"`)
  })
})

describe('reading as Obsidian shows it (review P2.9 to P2.11)', () => {
  it('keeps a single line break a line break', () => {
    expect(renderMarkdown('Zeile eins\nZeile zwei', nowhere)).toContain('Zeile eins<br>Zeile zwei')
  })

  it('hides a block id and leaves an anchor for it', () => {
    const html = renderMarkdown('Ein Absatz ^wichtig\n\nNoch einer', nowhere)
    expect(html).not.toMatch(/>[^<]*\^wichtig/)
    expect(html).toContain('id="^wichtig"')
  })

  it('names the heading or block a link points at', () => {
    const plan = (target: string) => (target === 'Plan' ? 'S/Plan.md' : null)
    expect(renderMarkdown('[[Plan#Netzwerk]] und [[Plan#^wichtig]]', plan)).toContain('>Plan › Netzwerk</a>')
    expect(renderMarkdown('[[Plan#^wichtig]]', plan)).toContain('>Plan › wichtig</a>')
    expect(renderMarkdown('[[Plan#Netzwerk|Netz]]', plan)).toContain('>Netz</a>')
  })
})

describe('Templater outside a code block (review P2.17)', () => {
  it('is shown as code, on its own line, and never as markup', () => {
    const html = renderMarkdown('<% tp.date.now("YYYY") %>\n<%* tR += "<b>x</b>" %>', nowhere)
    expect(html).toContain('<code class="nn-templater">&lt;% tp.date.now(&quot;YYYY&quot;) %&gt;</code><br>')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })
})
