import { renderMarkdown } from './markdown'

const none = () => null
const render = (text: string) => renderMarkdown(text, none)

describe('formulas', () => {
  it('marks $…$ in the text and $$…$$ on lines of their own, escaped, to be drawn later', () => {
    expect(render('Euler: $e^{i\\pi} + 1 = 0$ ok')).toContain('<span class="nn-math">e^{i\\pi} + 1 = 0</span>')
    expect(render('$$\n\\frac{a}{b} < c\n$$\n')).toContain('<div class="nn-math" data-display="true">\\frac{a}{b} &lt; c</div>')
    expect(render('inline $$x^2$$ big')).toContain('<span class="nn-math" data-display="true">x^2</span>')
    expect(render('one $x$ letter')).toContain('<span class="nn-math">x</span>')
  })
  it('leaves prices, blanks inside the dollars and code alone, as Obsidian does', () => {
    for (const text of ['costs 5$ and 10$', 'a $ b $ c', 'from $5 to $10', '`$x$` in code']) {
      expect(render(text), text).not.toContain('nn-math')
    }
    expect(render('```\n$$\nx\n$$\n```')).not.toContain('nn-math')
  })
})

describe('footnotes', () => {
  it('numbers references in the order they appear and lists the notes at the end with a way back', () => {
    const html = render('First[^b] then[^a] and again[^b].\n\n[^a]: Note **A**.\n[^b]: Note B\n  goes on.\n')
    const numbers = [...html.matchAll(/<sup class="nn-fn-ref" id="(fn\d+-ref-[\d-]+)"><a href="#(fn\d+-\d+)">(\d+)<\/a><\/sup>/g)].map((m) => m[3])
    expect(numbers).toEqual(['1', '2', '1'])
    const list = html.slice(html.indexOf('<section class="nn-footnotes"'))
    expect(list).toMatch(/<li id="fn\d+-1">Note B goes on\. <a class="nn-fn-back" href="#fn\d+-ref-1"/)
    expect(list).toMatch(/<li id="fn\d+-2">Note <strong>A<\/strong>\./)
    // The definitions are not shown where they stand.
    expect(html.indexOf('Note B')).toBe(html.lastIndexOf('Note B'))
  })
  it('takes ^[inline notes], keeps a reference without a note as text, and gives each rendering its own ids', () => {
    const html = render('Here^[right *here*] and [^missing].')
    expect(html).toContain('[^missing]')
    expect(html).toMatch(/<li id="fn\d+-1">right <em>here<\/em> <a class="nn-fn-back"/)
    const first = /id="(fn\d+)-1"/.exec(render('x^[y]'))![1]
    const second = /id="(fn\d+)-1"/.exec(render('x^[y]'))![1]
    expect(first).not.toBe(second)
    expect(render('no notes here')).not.toContain('nn-footnotes')
  })
})

describe('diagrams and code', () => {
  it('marks a Mermaid block to be drawn and leaves other code for its colours', () => {
    expect(render('```mermaid\ngraph TD\n  A-->B\n```')).toContain('<div class="nn-mermaid">graph TD\n  A--&gt;B</div>')
    expect(render('```js\nconst a = 1\n```')).toContain('<code class="language-js">')
  })
})
