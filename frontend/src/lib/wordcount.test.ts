import { describe, expect, it } from 'vitest'

import { countChars, countWords } from './wordcount'

describe('word count', () => {
  it('counts words, not the marks between them', () => {
    expect(countWords('Five words stand here now.')).toBe(5)
    expect(countWords('  Heading\n\nA line — with a dash, and 42 things!  ')).toBe(9)
    expect(countWords('')).toBe(0)
    // Without spaces between words the segmenter still finds them.
    expect(countWords('日本語の文章')).toBeGreaterThan(1)
  })

  it('counts characters as a person does: an accent with its letter, no line breaks', () => {
    expect(countChars('Five words.')).toBe(11)
    expect(countChars('Käse\nBrot\r\n')).toBe(8)
    // "e" and a combining accent are one character; a family emoji is one too.
    expect(countChars('é')).toBe(1)
    expect(countChars('👨‍👩‍👧')).toBe(1)
  })
})
