import { describe, expect, it } from 'vitest'

import { highlights, parseWiki } from './live'
import { searchNames } from './suggest'

describe('parseWiki', () => {
  it('splits target and alias at the first pipe', () => {
    expect(parseWiki('Garden|the garden')).toEqual({ target: 'Garden', label: 'the garden', aliasAt: 7 })
    expect(parseWiki(' Garden ')).toEqual({ target: 'Garden', label: ' Garden ', aliasAt: 0 })
  })

  it('takes the escaped pipe of a table cell as the separator', () => {
    expect(parseWiki('Garden\\|the garden')).toEqual({ target: 'Garden', label: 'the garden', aliasAt: 8 })
  })
})

describe('highlights', () => {
  it('pairs markers on one line, not across lines, not next to another =', () => {
    const text = 'a ==one== b ==two==\n==open\nclose== a===no=== ==x =='
    expect(highlights(text).map(([from, to]) => text.slice(from, to))).toEqual(['==one==', '==two=='])
  })

  it('needs no blank inside the markers and ignores an escaped one', () => {
    expect(highlights('== no== ==no ==')).toEqual([])
    expect(highlights('\\==no== ==yes==').map(([from, to]) => [from, to])).toEqual([[8, 15]])
  })
})

describe('searchNames', () => {
  const item = (label: string, detail = '') => ({ label, detail, insert: label })
  it('puts names starting with the query first, then shorter ones, then matches in the path', () => {
    const list = [
      item('Old garden plan'), item('Garden tools'), item('My garden'), item('Garden'), item('Plan', 'Work/Garden/Plan.md'),
      item('Other'),
    ]
    // "My garden" is shorter than "Garden tools", but the name starting with the query comes first.
    expect(searchNames(list, ' garden ').map((found) => found.label)).toEqual([
      'Garden', 'Garden tools', 'My garden', 'Old garden plan', 'Plan',
    ])
  })

  it('gives the first ones for an empty query', () => {
    const list = Array.from({ length: 12 }, (_, k) => item(`Note ${k}`))
    expect(searchNames(list, '  ')).toHaveLength(8)
  })
})
