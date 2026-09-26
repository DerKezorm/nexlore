import { readProperties, splitNote, writeProperties, writeYaml } from './frontmatter'

const HEAD = '---\n# a comment stays\ntitle: "Plan: next"\ntags:\n  - alpha\n  - beta\naliases: [A, B]\ndone: false\ncount: 3\nwhen: 2026-09-26\n---\n'

describe('front matter', () => {
  it('is split from the body exactly, CRLF and a missing end included', () => {
    expect(splitNote(HEAD + '# Body\n')).toEqual({ head: HEAD, body: '# Body\n' })
    expect(splitNote('---\r\na: 1\r\n---\r\nText')).toEqual({ head: '---\r\na: 1\r\n---\r\n', body: 'Text' })
    expect(splitNote('No head\n---\nx: 1\n---\n').head).toBe('')
    expect(splitNote('---\nnot closed\n').head).toBe('')
  })

  it('reads kinds the way Obsidian shows them', () => {
    const read = readProperties(HEAD)
    expect(read.ok && read.items.map((item) => [item.key, item.kind, item.value])).toEqual([
      ['title', 'text', 'Plan: next'],
      ['tags', 'list', ['alpha', 'beta']],
      ['aliases', 'list', ['A', 'B']],
      ['done', 'checkbox', false],
      ['count', 'number', '3'],
      ['when', 'date', '2026-09-26'],
    ])
  })

  it('writes back only the line that changed', () => {
    const read = readProperties(HEAD)
    if (!read.ok) throw new Error('not ok')
    const items = read.items.map((item) => (item.key === 'done' ? { ...item, value: true } : item))
    expect(writeProperties(HEAD, items)).toBe(HEAD.replace('done: false', 'done: true'))
    // Unchanged: the head as it was, byte for byte.
    expect(writeProperties(HEAD, read.items)).toBe(HEAD)
  })

  it('keeps the style of a list: one per line stays one per line, flow stays flow', () => {
    const read = readProperties(HEAD)
    if (!read.ok) throw new Error('not ok')
    const items = read.items.map((item) =>
      item.key === 'tags' ? { ...item, value: ['alpha', 'gamma'] } : item.key === 'aliases' ? { ...item, value: ['A'] } : item,
    )
    const out = writeProperties(HEAD, items)
    expect(out).toContain('tags:\n  - alpha\n  - gamma\n')
    expect(out).toContain('aliases: [A]\n')
    expect(out).toContain('# a comment stays\ntitle: "Plan: next"\n')
  })

  it('adds and removes properties, and an empty table removes the head', () => {
    const read = readProperties('---\na: 1\n---\n')
    if (!read.ok) throw new Error('not ok')
    expect(writeProperties('---\na: 1\n---\n', [...read.items, { key: 'b', kind: 'text', value: 'two' }])).toBe('---\na: 1\nb: two\n---\n')
    expect(writeProperties('---\na: 1\nb: 2\n---\n', read.items)).toBe('---\na: 1\n---\n')
    expect(writeProperties('---\na: 1\n---\n', [])).toBe('')
    expect(writeProperties('', [{ key: 'new', kind: 'list', value: ['x'] }])).toBe('---\nnew:\n  - x\n---\n')
  })

  it('splits a tag string at blanks, an alias string only at commas', () => {
    const read = readProperties('---\ntags: one two\naliases: My Note Title\ncssclasses: wide, dark\n---\n')
    expect(read.ok && read.items.map((item) => item.value)).toEqual([['one', 'two'], ['My Note Title'], ['wide', 'dark']])
  })

  it('keeps the comment after a property that is removed (it is about the next one)', () => {
    const head = '---\ntitle: a\n# note about b\nb: 2\n# last words\n---\n'
    const read = readProperties(head)
    if (!read.ok) throw new Error('not ok')
    expect(writeProperties(head, read.items.filter((item) => item.key !== 'title'))).toBe('---\n# note about b\nb: 2\n# last words\n---\n')
    expect(writeProperties(head, read.items.filter((item) => item.key !== 'b'))).toBe('---\ntitle: a\n# note about b\n# last words\n---\n')
    const changed = read.items.map((item) => (item.key === 'title' ? { ...item, value: 'z' } : item))
    expect(writeProperties(head, changed)).toBe('---\ntitle: z\n# note about b\nb: 2\n# last words\n---\n')
  })

  it('keeps CRLF', () => {
    const head = '---\r\na: 1\r\nb: 2\r\n---\r\n'
    const read = readProperties(head)
    if (!read.ok) throw new Error('not ok')
    expect(writeProperties(head, read.items.map((item) => (item.key === 'b' ? { ...item, value: '3' } : item)))).toBe('---\r\na: 1\r\nb: 3\r\n---\r\n')
  })

  it('hands YAML that is not a table of properties to the text field', () => {
    expect(readProperties('---\n- a\n- b\n---\n').ok).toBe(false)
    expect(readProperties('---\na: [unclosed\n---\n').ok).toBe(false)
    expect(writeYaml('---\n- a\n---\n', '- a\n- b')).toBe('---\n- a\n- b\n---\n')
    expect(writeYaml('---\n- a\n---\n', '- a')).toBe('---\n- a\n---\n')
  })
})
