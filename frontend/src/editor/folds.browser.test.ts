/**
 * Folding in the editor: a heading folds the blocks up to the next one as high, a list item the items below it; the
 * text written stays the same; a cursor landing in a folded part opens it.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, expect, it } from 'vitest'

import type { FoldStore } from './folds'
import { allFolds } from './folds'
import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const NOTE = '# Top\n\n## One\n\nFirst text.\n\n### Deeper\n\nDeep text.\n\n## Two\n\nSecond text.\n\n- Parent\n  - Child one\n  - Child two\n- Single\n'

function store(): FoldStore & { folded: Set<string>; asked: string[] } {
  const listeners = new Set<() => void>()
  const folded = new Set<string>()
  const changed = () => listeners.forEach((listener) => listener())
  return {
    folded,
    asked: [],
    keys: () => new Set(folded),
    toggle(key) {
      this.asked.push(key)
      if (folded.has(key)) folded.delete(key)
      else folded.add(key)
      changed()
    },
    set(keys) {
      folded.clear()
      keys.forEach((key) => folded.add(key))
      changed()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    label: (was, name) => `${was ? 'Unfold' : 'Fold'} ${name}`,
  }
}

const hidden = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.nx-folded')].map((element) => (element.textContent ?? '').split(/\s+/).filter(Boolean).join(' '))

it('folds a heading up to the next as high, and a list item\'s items, without touching the text', async () => {
  const folds = store()
  open = await openEditor(NOTE, { folds })
  const { root, view } = open
  expect(allFolds(view.state)).toEqual(['h1:Top#0', 'h2:One#0', 'h3:Deeper#0', 'h2:Two#0', 'l:Parent#0'])
  // Every fold has its arrow; a click on it folds.
  expect(root.querySelectorAll('.nx-fold')).toHaveLength(5)
  root.querySelector<HTMLButtonElement>('[data-fold="h2:One#0"]')!.click()
  expect(hidden(root)).toEqual(['First text.', 'Deeper', 'Deep text.'])
  expect(root.querySelector('[data-fold="h2:One#0"]')!.getAttribute('aria-expanded')).toBe('false')
  root.querySelector<HTMLButtonElement>('[data-fold="l:Parent#0"]')!.click()
  expect(hidden(root)).toEqual(['First text.', 'Deeper', 'Deep text.', 'Child one Child two'])
  expect(open.text()).toBe(NOTE)
  // The whole note under its top heading.
  folds.set(['h1:Top#0'])
  expect(hidden(root)).toEqual(expect.arrayContaining(['One', 'First text.', 'Deeper', 'Deep text.', 'Two', 'Second text.', 'Parent Child one Child two Single']))
  expect(hidden(root)).not.toContain('Top')
  folds.set([])
  expect(hidden(root)).toEqual([])
})

it('opens the fold a cursor lands in', async () => {
  const folds = store()
  folds.folded.add('h2:Two#0')
  open = await openEditor(NOTE, { folds })
  const { root, view } = open
  expect(hidden(root)).toContain('Second text.')
  let inside = -1
  view.state.doc.descendants((node, pos) => {
    if (inside < 0 && node.isText && node.text === 'Second text.') inside = pos + 3
    return inside < 0
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inside)))
  expect(folds.asked).toEqual(['h2:Two#0'])
  expect(hidden(root)).not.toContain('Second text.')
})

function keyAtEndOf(view: Open['view'], words: string, key: string): boolean {
  let end = -1
  view.state.doc.descendants((node, pos) => {
    if (end < 0 && node.isTextblock && node.textContent === words) end = pos + node.nodeSize - 1
    return end < 0
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)))
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  return view.someProp('handleKeyDown', (handle) => handle(view, event)) ?? false
}

it('Enter at the end of a folded item makes a new item after it and all it holds (review P3.14)', async () => {
  const folds = store()
  folds.folded.add('l:Parent#0')
  open = await openEditor(NOTE, { folds })
  expect(keyAtEndOf(open.view, 'Parent', 'Enter')).toBe(true)
  open.view.dispatch(open.view.state.tr.insertText('New'))
  expect(open.text()).toContain('- Parent\n  - Child one\n  - Child two\n- New\n- Single\n')
})

it('Delete at the end of a folded heading opens the fold instead of joining unseen words (review P3.14)', async () => {
  const folds = store()
  folds.folded.add('h2:Two#0')
  open = await openEditor(NOTE, { folds })
  expect(keyAtEndOf(open.view, 'Two', 'Delete')).toBe(true)
  expect(folds.asked).toEqual(['h2:Two#0'])
  expect(open.text()).toBe(NOTE)
})
