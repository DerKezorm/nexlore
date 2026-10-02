import { atx, headingsOf, headingText } from './outline'

describe('headingsOf', () => {
  it('finds ATX and setext headings with their level and line', () => {
    const text = ['# Plan', '', 'Intro', '', '## Goals ##', 'Setext one', '==========', 'Setext two', '---', '###### Deep'].join('\n')
    expect(headingsOf(text)).toEqual([
      { level: 1, text: 'Plan', line: 1 },
      { level: 2, text: 'Goals', line: 5 },
      { level: 1, text: 'Setext one', line: 6 },
      { level: 2, text: 'Setext two', line: 8 },
      { level: 6, text: 'Deep', line: 10 },
    ])
  })

  it('skips the front matter, fenced code, comments and math, and a rule after an empty line', () => {
    const text = [
      '---', 'title: x', '# not a heading', '---',
      '```md', '# in code', '```',
      '~~~~', '## in tilde code', '~~~~',
      '%%', '# in a comment', '%%',
      '$$', '# in math', '$$',
      '',
      '---',
      '- item',
      '---',
      '#no space is a tag',
      '# Real',
    ].join('\n')
    expect(headingsOf(text).map((heading) => heading.text)).toEqual(['Real'])
  })

  it('reads CRLF files and an empty heading as nothing', () => {
    expect(headingsOf('# One\r\n#\r\n## Two\r\n')).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 2, text: 'Two', line: 3 },
    ])
  })
})

describe('headingText', () => {
  it('shows the words of the marks', () => {
    expect(headingText('**Big** plan with [[Note|alias]], [[Other]] and [site](https://example.com) `code` ==hi== *soft*')).toBe(
      'Big plan with alias, Other and site code hi soft',
    )
    expect(headingText('snake_case_name stays')).toBe('snake_case_name stays')
  })
})

describe('atx', () => {
  it('reads headings as before, closing hashes off', () => {
    expect(atx('## Title ##')).toEqual(['## Title ##', '##', 'Title'])
    expect(atx('# C# and F#')?.[2]).toBe('C# and F#')
    expect(atx('# Title#')?.[2]).toBe('Title#')
    expect(atx('   ### Three   ')?.[2]).toBe('Three')
    expect(atx('#tag')).toBeNull()
    expect(atx('####### seven')).toBeNull()
  })

  it('takes linear time on a line full of blanks or hashes (review before 1.0.0)', () => {
    for (const line of ['# a' + ' '.repeat(200_000) + 'b', '# a' + ' #'.repeat(100_000) + 'b']) {
      const started = performance.now()
      atx(line)
      headingsOf(line)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })
})
