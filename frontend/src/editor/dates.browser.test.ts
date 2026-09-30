/**
 * Dates in words after "@" in a real editor: the list opens, Enter writes a link to the daily note, Shift+Enter the
 * date alone, Escape closes; an address with "@" in it never asks.
 */
import { Selection } from '@milkdown/kit/prose/state'
import { afterEach, expect, it } from 'vitest'

import { isoDate, parseDateWords } from '../lib/dates'
import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const list = () => document.querySelector('[data-testid="date-suggest"]')
const key = (editor: Open, name: string, shiftKey = false) =>
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }))

async function typeAtEnd(editor: Open, text: string) {
  editor.view.dispatch(editor.view.state.tr.setSelection(Selection.atEnd(editor.view.state.doc)))
  for (const char of text) editor.view.dispatch(editor.view.state.tr.insertText(char))
}

it('offers the day a word means and writes a link to its daily note with Enter', async () => {
  open = await openEditor('Call Anna\n')
  await typeAtEnd(open, ' @morgen')
  expect(list()?.textContent).toContain('morgen')
  key(open, 'Enter')
  const tomorrow = isoDate(parseDateWords('morgen', new Date())!)
  expect(open.text()).toBe(`Call Anna [[${tomorrow}]]\n`)
  expect(list()).toBeNull()
})

it('writes the date alone with Shift+Enter, and chooses among words while they are typed', async () => {
  open = await openEditor('Due\n')
  await typeAtEnd(open, ' @mo')
  // morgen, montag, monday: the second one.
  expect(list()?.querySelectorAll('[role="option"]').length).toBe(3)
  key(open, 'ArrowDown')
  key(open, 'Enter', true)
  const monday = isoDate(parseDateWords('montag', new Date())!)
  expect(open.text()).toBe(`Due ${monday}\n`)
})

it('closes with Escape, and an address or a word that means no day never asks', async () => {
  open = await openEditor('Mail\n')
  await typeAtEnd(open, ' name@morgen')
  expect(list()).toBeNull()
  await typeAtEnd(open, ' @anna')
  expect(list()).toBeNull()
  await typeAtEnd(open, ' @heute')
  expect(list()).not.toBeNull()
  key(open, 'Escape')
  expect(list()).toBeNull()
  // The address keeps its "@" (the writer may escape it); nothing was turned into a date.
  expect(open.text()).toMatch(/^Mail name\\?@morgen @anna @heute\n$/)
})
