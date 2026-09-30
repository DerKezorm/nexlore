/**
 * Moving blocks as an outliner does: a list item with the items below it among its siblings, any other block among
 * the note's blocks; the keys the editor answers to, the cursor moving along, and the ends where nothing moves.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, expect, it } from 'vitest'

import { openEditor } from './harness'
import { moveBlock } from './moveBlock'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

function caretIn(view: EditorView, words: string, offset = 1) {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(words)) at = pos + node.text.indexOf(words) + offset
    return at < 0
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

function press(view: EditorView, key: string, modifiers: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  view.someProp('handleKeyDown', (handle) => handle(view, event))
}

it('moves a list item with the items below it among its siblings, by Alt with the arrows', async () => {
  open = await openEditor('# List\n\n- One\n- Two\n  - Two a\n  - Two b\n- Three\n')
  const { view } = open
  caretIn(view, 'Two', 1)
  press(view, 'ArrowUp', { altKey: true })
  expect(open.text()).toBe('# List\n\n- Two\n  - Two a\n  - Two b\n- One\n- Three\n')
  // The cursor went along: once more up does nothing (first already), down twice brings it to the end.
  expect(moveBlock(-1)(view.state, view.dispatch)).toBe(false)
  press(view, 'ArrowDown', { altKey: true })
  press(view, 'ArrowDown', { altKey: true })
  expect(open.text()).toBe('# List\n\n- One\n- Three\n- Two\n  - Two a\n  - Two b\n')
  // An item below another one moves among its own siblings only.
  caretIn(view, 'Two b', 2)
  press(view, 'ArrowUp', { ctrlKey: true, shiftKey: true })
  expect(open.text()).toBe('# List\n\n- One\n- Three\n- Two\n  - Two b\n  - Two a\n')
})

it('moves any other block among the note\'s blocks', async () => {
  open = await openEditor('# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n## End\n')
  const { view } = open
  caretIn(view, 'Second', 2)
  press(view, 'ArrowUp', { altKey: true })
  expect(open.text()).toBe('# Title\n\nSecond paragraph.\n\nFirst paragraph.\n\n## End\n')
  caretIn(view, 'End', 1)
  expect(moveBlock(1)(view.state, view.dispatch)).toBe(false)
})
