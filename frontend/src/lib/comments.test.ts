/** Where a comment sits: its anchor found again after the text changed, and @names in its words. */
import { describe, expect, it } from 'vitest'

import { anchorOf, locate, rangeOf, textMap, typingMention, withMentions } from './comments'

describe('the anchor of a comment', () => {
  const text = 'The bed by the fence. The bed by the pond. The bed by the fence gate.'

  it('keeps the words and a little around them', () => {
    const at = text.indexOf('bed by the pond')
    expect(anchorOf(text, at, at + 15)).toEqual({ quote: 'bed by the pond', before: 'The bed by the fence. The ', after: '. The bed by the fence gate.' })
  })

  it('finds the same place among equal words by what stands around it', () => {
    const second = text.lastIndexOf('bed by the fence')
    const anchor = anchorOf(text, second, second + 16)
    expect(locate(text, anchor)).toEqual({ start: second, end: second + 16 })
    const first = text.indexOf('bed by the fence')
    expect(locate(text, anchorOf(text, first, first + 16))).toEqual({ start: first, end: first + 16 })
  })

  it('follows the words when text before them grew, and says when they are gone', () => {
    const at = text.indexOf('pond')
    const anchor = anchorOf(text, at, at + 4)
    const longer = 'A new first line. ' + text
    expect(locate(longer, anchor)).toEqual({ start: at + 18, end: at + 22 })
    expect(locate(text.replace('pond', 'lake'), anchor)).toBeNull()
    expect(locate(text, { quote: '', before: '', after: '' })).toBeNull()
  })

  it('turns characters of an element into a range across its text nodes', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>Dig the <strong>long</strong> bed</p>'
    const map = textMap(root)
    expect(map.text).toBe('Dig the long bed')
    const range = rangeOf(map, 4, 12)!
    expect(range.toString()).toBe('the long')
    expect(rangeOf(map, 8, 16)!.toString()).toBe('long bed')
    // At the edge between two nodes a start belongs to the node it begins, an end to the node it closes.
    const edge = rangeOf(map, 8, 12)!
    expect([edge.startContainer.textContent, edge.startOffset]).toEqual(['long', 0])
    expect([edge.endContainer.textContent, edge.endOffset]).toEqual(['long', 4])
  })
})

describe('@names', () => {
  it('stand apart from the words around them, and a mail address is none', () => {
    expect(withMentions('Ask @anna, not mail@example.com.')).toEqual([
      { text: 'Ask ', mention: false },
      { text: '@anna', mention: true },
      { text: ', not mail@example.com.', mention: false },
    ])
  })

  it('are noticed while typed', () => {
    expect(typingMention('Hello @an', 9)).toEqual({ start: 6, words: 'an' })
    expect(typingMention('Hello @', 7)).toEqual({ start: 6, words: '' })
    expect(typingMention('mail@an', 7)).toBeNull()
    expect(typingMention('@anna done', 10)).toBeNull()
  })
})
