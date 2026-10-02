/** Notes written to hurt whoever reads them: the reading view stays quick and never goes blank (review before 1.0.0). */

import { drawable } from './enrich'
import { MAX_NESTING, renderMarkdown } from './markdown'

const nowhere = () => null

function timed(text: string): { html: string; ms: number } {
  const started = performance.now()
  const html = renderMarkdown(text, nowhere, 'S/x.md')
  return { html, ms: performance.now() - started }
}

describe('a hostile note in the reading view', () => {
  it('shows quotes nested thousands deep as text instead of throwing', () => {
    const text = '>'.repeat(3000) + ' deep'
    const { html } = timed(text)
    expect(html).toContain('nn-plain-note')
    expect(html).toContain('deep')
  })

  it('shows a list nested deeper than the limit as text', () => {
    const text = Array.from({ length: MAX_NESTING }, (_, level) => '  '.repeat(level) + '- item').join('\n')
    expect(timed(text).html).toContain('nn-plain-note')
  })

  it('draws ordinary nesting and long indented code as usual', () => {
    expect(timed('> > > three\n\n- a\n  - b\n    - c').html).not.toContain('nn-plain-note')
    expect(timed(' '.repeat(400) + 'code').html).not.toContain('nn-plain-note')
  })

  it('escapes the note when it falls back to text', () => {
    const { html } = timed('>'.repeat(3000) + ' <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
  })

  // Each grew with the square of its length before: 64 KB took 2 to 7 s.
  it.each([
    ['brackets', '['.repeat(64_000)],
    ['wiki openings', '[['.repeat(32_000)],
    ['short paragraphs', '[\n\n'.repeat(21_000)],
    ['lines of brackets', '[\n'.repeat(32_000)],
    ['templater openings', '<%'.repeat(32_000)],
    ['open highlights', '==a '.repeat(16_000)],
  ])('reads 64 KB of %s in linear time', (_, text) => {
    expect(timed(text).ms).toBeLessThan(1500)
  })

  it('still finds every unsafe link, wherever it stands', () => {
    const text = [
      '> [!note] [t](javascript:alert(1))',
      '> [b](javascript:alert(2))',
      '',
      '| a | b |',
      '|---|---|',
      '| [c](javascript:alert(3)) | ![d](data:text/html,x) |',
      '',
      '- [e](javascript:alert(4))',
      '  - ==[f](javascript:alert(5))==',
      '',
      'Note^[[g](javascript:alert(6))] and[^n].',
      '',
      '[^n]: [h](javascript:alert(7))',
    ].join('\n')
    const html = timed(text).html.toLowerCase()
    expect(html).not.toMatch(/(?:href|src)="(?:javascript|data):/)
    expect(html.match(/href="#"/g)?.length).toBeGreaterThanOrEqual(6)
  })
})

describe('formulas', () => {
  it('are drawn when ordinary and left as text when nested too deep or too long', () => {
    expect(drawable('\\frac{a}{\\sqrt{b}}')).toBe(true)
    expect(drawable('{'.repeat(150) + 'x' + '}'.repeat(150))).toBe(false)
    expect(drawable('x'.repeat(30_000))).toBe(false)
  })
})
