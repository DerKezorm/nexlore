import { describe, expect, it } from 'vitest'

import { tidyAttention } from './syntax'

type Node = { type: string; value?: string; marker?: string; children?: Node[] }
const text = (value: string): Node => ({ type: 'text', value })
const strong = (...children: Node[]): Node => ({ type: 'strong', children })
const em = (...children: Node[]): Node => ({ type: 'emphasis', children })

describe('tidyAttention', () => {
  it('joins bold next to bold into one, so `**a****b**` is never written', () => {
    const tree: Node = { type: 'paragraph', children: [strong(text('a')), strong(text('b')), text(' c')] }
    tidyAttention(tree)
    expect(tree.children).toEqual([strong(text('a'), text('b')), text(' c')])
  })

  it('writes italic with `_` where its stars would touch the stars of bold', () => {
    const tree: Node = { type: 'paragraph', children: [em(text('kurs'), strong(text('iv'))), strong(text(','))] }
    tidyAttention(tree)
    expect(tree.children![0].marker).toBe('_')
    const apart: Node = { type: 'paragraph', children: [em(text('far')), text(' from '), strong(text('bold'))] }
    tidyAttention(apart)
    expect(apart.children![0].marker).toBeUndefined()
  })
})
