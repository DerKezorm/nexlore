import { compareTexts, copiesOf, merge, originalOf, splitBlocks, wordDiff } from './compare'

describe('comparing a note with its conflict copy', () => {
  it('cuts blocks that give the text again, byte for byte', () => {
    for (const text of [
      '---\na: 1\n---\n# Title\n\nPara one\nstill one\n\n\n```\ncode\n\nstill code\n```\nafter\n',
      'no end of line',
      '\n\nleading blank lines\r\n\r\nCRLF\r\n',
      '',
    ]) {
      expect(splitBlocks(text).join('')).toBe(text)
    }
    expect(splitBlocks('```\na\n\nb\n```\n')).toHaveLength(1)
    expect(splitBlocks('---\nx: 1\n---\n# T\n')).toEqual(['---\nx: 1\n---\n', '# T\n'])
  })

  it('pairs equal blocks and groups the rest into changes', () => {
    const rows = compareTexts('# A\n\nsame\n\nold\n', '# A\n\nsame\n\nnew\n\nadded\n')
    expect(rows.map((row) => row.kind)).toEqual(['same', 'same', 'change'])
    const change = rows[2]
    expect(change.kind === 'change' && [change.left, change.right]).toEqual([['old\n'], ['new\n\n', 'added\n']])
  })

  it('puts the note together from the chosen sides', () => {
    const left = '# A\n\nsame\n\nold\n'
    const rows = compareTexts(left, '# A\n\nsame\n\nnew\n')
    expect(merge(rows, [])).toBe(left)
    expect(merge(rows, ['right'])).toBe('# A\n\nsame\n\nnew\n')
    expect(merge(rows, ['both'])).toBe('# A\n\nsame\n\nold\n\nnew\n')
  })

  it('keeps a blank line between blocks from different sides', () => {
    const rows = compareTexts('one\n\ntwo', 'one\n\nthree')
    expect(merge(rows, ['both'])).toBe('one\n\ntwo\n\nthree')
  })

  it('marks the words that differ', () => {
    const diff = wordDiff('the old house', 'the new house')
    expect(diff.left).toEqual([{ text: 'the ', changed: false }, { text: 'old', changed: true }, { text: ' house', changed: false }])
    expect(diff.right.filter((part) => part.changed).map((part) => part.text)).toEqual(['new'])
  })

  it('finds copies and the note they belong to', () => {
    const copy = 'Work/Plan (conflict 2026-09-26 101010).md'
    expect(originalOf(copy)).toBe('Work/Plan.md')
    expect(originalOf('Work/Plan.md')).toBeNull()
    expect(originalOf('Work/Plan (conflict soon).md')).toBeNull()
    expect(copiesOf('Work/Plan.md', ['Work/Plan.md', copy, 'Work/Plan (conflict 2026-09-27 090000).md', 'Home/Plan (conflict 2026-09-26 101010).md'])).toEqual([
      'Work/Plan (conflict 2026-09-27 090000).md',
      copy,
    ])
  })
})
