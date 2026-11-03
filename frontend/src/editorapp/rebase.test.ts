import { expect, it } from 'vitest'

import { changes, rebase } from './rebase'

it('finds the changed lines of a text', () => {
  expect(changes('a\nb\nc\n', 'a\nb\nc\n')).toEqual([])
  expect(changes('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ from: 2, to: 4, grow: 0 }])
  expect(changes('a\nb\nc\nd\n', 'x\na\nb\nd\nyy\n')).toEqual([
    { from: 0, to: 0, grow: 2 },
    { from: 4, to: 6, grow: -2 },
    { from: 8, to: 8, grow: 3 },
  ])
  expect(changes('a', 'a\nb')).toEqual([{ from: 0, to: 1, grow: 2 }])
})

it('lays the typing onto a text merged from outside', () => {
  const base = 'Title\n\nOne\n\nTwo\n\nThree\n'
  const local = 'Title\n\nOne\n\nTwo typed\n\nThree\n'
  // Changed before and after the typing: both kept.
  expect(rebase(base, local, '---\na: 1\n---\nTitle\n\nOne!\n\nTwo\n\nThree and more\n')).toBe(
    '---\na: 1\n---\nTitle\n\nOne!\n\nTwo typed\n\nThree and more\n',
  )
  // Lines put in where the typing starts come before it.
  expect(rebase('a\nb\n', 'a\nXb\n', 'a\nnew\nb\n')).toBe('a\nnew\nXb\n')
  // Nothing typed, nothing merged, or the same text both ways.
  expect(rebase(base, base, 'other\n')).toBe('other\n')
  expect(rebase(base, local, base)).toBe(local)
  expect(rebase(base, local, local)).toBe(local)
  // Typed where the outside changed too: the outside wins.
  expect(rebase(base, local, 'Title\n\nOne\n\nTwo merged\n\nThree\n')).toBeNull()
  // Typed away: the line goes.
  expect(rebase(base, 'Title\n\nOne\n\nThree\n', 'Title\n\nOne more\n\nTwo\n\nThree\n')).toBe('Title\n\nOne more\n\nThree\n')
})
