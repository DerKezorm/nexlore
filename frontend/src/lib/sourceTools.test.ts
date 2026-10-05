import { describe, expect, it } from 'vitest'

import { sourceEdit, sourceStatus } from './sourceTools'

/** The text after a command, the selection shown as « and » (before and after). */
function after(command: Parameters<typeof sourceEdit>[0], marked: string, option?: string): string {
  const from = marked.indexOf('«')
  const to = marked.indexOf('»') - 1
  const text = marked.replace('«', '').replace('»', '')
  const edit = sourceEdit(command, text, from, to, option)
  if (!edit) return 'nothing'
  const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
  const [a, b] = edit.select
  return next.slice(0, a) + '«' + next.slice(a, b) + '»' + next.slice(b)
}

describe('the toolbar in the Markdown view', () => {
  it('wraps the words chosen in a mark and takes it off again', () => {
    expect(after('bold', 'say «hello» now')).toBe('say **«hello»** now')
    expect(after('bold', 'say **«hello»** now')).toBe('say «hello» now')
    expect(after('bold', 'say «**hello**» now')).toBe('say «hello» now')
    expect(after('italic', 'a «b» c')).toBe('a *«b»* c')
    expect(after('strike', '«x»')).toBe('~~«x»~~')
    expect(after('highlight', '«x»')).toBe('==«x»==')
    expect(after('code', '«x»')).toBe('`«x»`')
  })

  it('puts the caret between the marks when nothing is chosen', () => {
    expect(after('bold', 'a «»b')).toBe('a **«»**b')
  })

  it('makes headings of the lines and plain text again', () => {
    expect(after('h2', 'one\ntw«»o\nthree')).toBe('one\n## two«»\nthree')
    expect(after('h1', '### «Title»')).toBe('«# Title»')
    expect(after('text', '## Ti«»tle')).toBe('Title«»')
  })

  it('turns every chosen line into a list item, and takes the list off when all are', () => {
    expect(after('bulletList', '«one\ntwo»')).toBe('«- one\n- two»')
    expect(after('bulletList', '«- one\n- two»')).toBe('«one\ntwo»')
    expect(after('orderedList', '«one\n- two»')).toBe('«1. one\n2. two»')
    expect(after('taskList', '«- one»')).toBe('«- [ ] one»')
    expect(after('bulletList', '«- [ ] one»')).toBe('«- one»')
    expect(after('bulletList', '\to«»ne')).toBe('\t- one«»')
  })

  it('quotes lines, makes a callout of them, and moves them in and out', () => {
    expect(after('quote', '«a\nb»')).toBe('«> a\n> b»')
    expect(after('quote', '«> a\n> b»')).toBe('«a\nb»')
    expect(after('callout', '«Mind this»', 'warning')).toBe('> [!warning]\n> «Mind this»')
    expect(after('indent', '- «»a')).toBe('\t- a«»')
    expect(after('outdent', '\t- «»a')).toBe('- a«»')
  })

  it('writes links around the words, or with the caret where the words go', () => {
    expect(after('wikiLink', 'see «Plan»')).toBe('see [[«Plan»]]')
    expect(after('embed', '«a.png»')).toBe('![[«a.png»]]')
    expect(after('link', '«Docs»')).toBe('[Docs](https://«»)')
    expect(after('link', 'x «»')).toBe('x [«»](https://)')
  })

  it('sets blocks on lines of their own, with blank lines around', () => {
    expect(after('codeBlock', 'text\n«a = 1»\nmore')).toBe('text\n\n```\n«a = 1»\n```\n\nmore')
    expect(after('divider', 'one«»')).toBe('one\n\n---«»')
    expect(after('math', '«»')).toBe('$$\n«»\n$$')
    expect(after('table', 'x«»')).toBe('x\n\n| «Column» | Column |\n| --- | --- |\n|  |  |')
  })

  it('takes the marks off the words chosen but keeps stars between words', () => {
    expect(after('clear', '«**a** and *b* ~~c~~ ==d== `e` 2 * 3»')).toBe('«a and b c d e 2 * 3»')
  })

  it('does nothing for what has no meaning in plain text', () => {
    expect(after('sortAsc', '«x»')).toBe('nothing')
  })

  it('lights what holds at the caret', () => {
    const at = (text: string) => sourceStatus(text.replace('|', ''), text.indexOf('|'), text.indexOf('|'))
    expect(at('## Ti|tle').block).toBe('h2')
    expect(at('- [ ] do |it').list).toBe('task')
    expect(at('3. th|ree').list).toBe('ordered')
    expect(at('- o|ne').list).toBe('bullet')
    expect(at('> quo|ted').quote).toBe(true)
    expect(at('```\nco|de').block).toBe('code')
    expect(at('```\ncode\n```\nafter|').block).toBe('text')
    expect(at('say **hel|').marks).toEqual([])
    expect(sourceStatus('a **b** c', 4, 5).marks).toEqual(['strong'])
    expect(sourceStatus('a *b* c', 3, 4).marks).toEqual(['emphasis'])
  })
})
