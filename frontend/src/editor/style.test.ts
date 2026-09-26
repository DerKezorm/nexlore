import { detectStyle } from './style'

describe("the author's style", () => {
  it("defaults to Obsidian's", () => {
    expect(detectStyle('Just text.\n')).toMatchObject({ bullet: '-', emphasis: '*', fence: '`', fences: true, setext: false, bareUrls: true, listIndent: null, alignTables: false })
  })

  it('is read from what the file does most', () => {
    const text = '* a\n* b\n    * nested\n\nTitle\n=====\n\n~~~\ncode\n~~~\n\n_it_ and _more_\n\n| a  | b |\n|----|---|\n| xx | y |\n'
    expect(detectStyle(text)).toMatchObject({ bullet: '*', bulletOther: '-', setext: true, fence: '~', emphasis: '_', listIndent: '    ', alignTables: true })
  })

  it('knows tabs, indented code and angle-bracket addresses', () => {
    expect(detectStyle('- a\n\t- b\n').listIndent).toBe('\t')
    expect(detectStyle('Text\n\n    indented code\n').fences).toBe(false)
    expect(detectStyle('See <https://example.com> and <https://example.org>.\n').bareUrls).toBe(false)
  })

  it('does not count what stands inside fenced code', () => {
    expect(detectStyle('```\n* not a list\n* really not\n```\n- real\n').bullet).toBe('-')
  })
})
