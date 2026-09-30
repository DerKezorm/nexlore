/**
 * Find and replace in a real editor: which hits there are, which is current, what replacing writes to the file.
 */
import { undo } from '@milkdown/kit/prose/history'
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, expect, it } from 'vitest'

import { codeHits, findHits, MAX_HITS } from './find'
import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
const opened: Open[] = []
afterEach(async () => {
  for (const editor of opened.splice(0)) await editor.close()
})

async function open(text: string): Promise<Open> {
  const editor = await openEditor(text)
  opened.push(editor)
  return editor
}

/** The words of each hit, in order. */
const words = (editor: Open, query: string, caseSensitive = false) =>
  findHits(editor.view.state.doc, query, caseSensitive).map((hit) => editor.view.state.doc.textBetween(hit.from, hit.to))

it('finds a word in every text block, across marks, with or without case, and never in a code block', async () => {
  const editor = await open('# Cat\n\nThe cat and the c**at**.\n\n- a CAT\n\n```\ncat in code\n```\n\n| cat |\n| --- |\n| x |\n')
  expect(words(editor, 'cat')).toEqual(['Cat', 'cat', 'cat', 'CAT', 'cat'])
  expect(words(editor, 'cat', true)).toEqual(['cat', 'cat', 'cat'])
  expect(words(editor, '')).toEqual([])
  // Characters of a pattern are words to look for, nothing more.
  expect(words(editor, '.')).toEqual(['.'])
  expect(words(editor, 'a.d')).toEqual([])
})

it('never finds across a line break inside a block', async () => {
  const editor = await open('one two  \nthree\n')
  expect(words(editor, 'two')).toEqual(['two'])
  expect(words(editor, 'twothree')).toEqual([])
  expect(words(editor, 'two\nthree')).toEqual([])
})

it('marks the hits, the current one first at the caret, and steps round both ways', async () => {
  const editor = await open('cat one\n\ncat two\n\ncat three\n')
  const { view, find } = editor
  // The caret in the second paragraph: its hit is current.
  const second = findHits(view.state.doc, 'cat', false)[1]
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, second.from)))
  find.search('cat', false)
  expect(find.status()).toMatchObject({ count: 3, current: 1, query: 'cat' })
  expect(editor.root.querySelectorAll('.nx-find')).toHaveLength(3)
  expect(editor.root.querySelector('.nx-find-current')?.textContent).toBe('cat')
  find.next()
  expect(find.status().current).toBe(2)
  find.next()
  expect(find.status().current).toBe(0)
  find.previous()
  expect(find.status().current).toBe(2)
  find.search('', false)
  expect(find.status()).toMatchObject({ count: 0, current: -1 })
  expect(editor.root.querySelectorAll('.nx-find')).toHaveLength(0)
})

it('counts again when the text changes while the bar is open', async () => {
  const editor = await open('cat\n\ndog\n')
  const { view, find } = editor
  find.search('cat', false)
  expect(find.status().count).toBe(1)
  view.dispatch(view.state.tr.insertText(' cat', view.state.doc.content.size - 1))
  expect(find.status().count).toBe(2)
})

it('replaces the current hit and goes on to the next, keeping the marks, as one step of undo', async () => {
  const editor = await open('# Title\n\nA *cat* here.\n\nUntouched   spacing  here.\n\nAnother cat.\n')
  const { find } = editor
  editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1)))
  find.search('cat', false)
  expect(find.status()).toMatchObject({ count: 2, current: 0 })
  find.replace('dog')
  expect(find.status()).toMatchObject({ count: 1, current: 0 })
  // Only the changed block differs from the file; the odd spacing of the other stays.
  expect(editor.text()).toBe('# Title\n\nA *dog* here.\n\nUntouched   spacing  here.\n\nAnother cat.\n')
  undo(editor.view.state, editor.view.dispatch)
  expect(editor.text()).toBe('# Title\n\nA *cat* here.\n\nUntouched   spacing  here.\n\nAnother cat.\n')
})

it('replaces every hit in one step, an empty replacement deleting them', async () => {
  const editor = await open('cat, Cat and CAT.\n\n```\ncat\n```\n')
  const { find } = editor
  find.search('cat', false)
  // Longer than the word: each replacement moves the ones after it.
  expect(find.replaceAll('bird')).toBe(3)
  expect(editor.text()).toBe('bird, bird and bird.\n\n```\ncat\n```\n')
  expect(find.status().count).toBe(0)
  undo(editor.view.state, editor.view.dispatch)
  expect(editor.text()).toBe('cat, Cat and CAT.\n\n```\ncat\n```\n')
  find.search('cat', true)
  expect(find.replaceAll('')).toBe(1)
  expect(editor.text()).toBe(', Cat and CAT.\n\n```\ncat\n```\n')
})

it('a replacement that holds the word itself does not run away', async () => {
  const editor = await open('ab ab\n')
  const { find } = editor
  find.search('ab', false)
  find.replace('abab')
  expect(editor.text()).toBe('abab ab\n')
  // The next hit is the one after what was put in, not inside it.
  expect(find.status()).toMatchObject({ count: 3, current: 2 })
})

it('closing puts the selection on the current hit and takes the marks away', async () => {
  const editor = await open('one cat two cat\n')
  const { find, view } = editor
  find.search('cat', false)
  find.next()
  find.close(true)
  const { from, to } = view.state.selection
  expect(view.state.doc.textBetween(from, to)).toBe('cat')
  expect(from).toBe(findHits(view.state.doc, 'cat', false)[1].from)
  expect(find.status().count).toBe(0)
  expect(editor.root.querySelectorAll('.nx-find')).toHaveLength(0)
})

it('stops marking at the limit', async () => {
  const editor = await open('a'.repeat(MAX_HITS + 5) + '\n')
  editor.find.search('a', false)
  expect(editor.find.status()).toMatchObject({ count: MAX_HITS, capped: true })
})

it('counts the words in code blocks apart, for the bar to say the search leaves them out (review P3.19)', async () => {
  const editor = await open('Katze im Text.\n\n```js\nconst katze = 1 // Katze\n```\n\n$$\nKatze\n$$\n')
  expect(words(editor, 'katze')).toEqual(['Katze'])
  expect(codeHits(editor.view.state.doc, 'katze', false)).toBe(3)
  expect(codeHits(editor.view.state.doc, 'Katze', true)).toBe(2)
  expect(codeHits(editor.view.state.doc, '', false)).toBe(0)
})
