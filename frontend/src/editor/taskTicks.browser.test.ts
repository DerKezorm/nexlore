/**
 * Ticking a task off in a real editor writes what the task list writes (review before 1.0.0, P5.2): the done date,
 * and for a recurring task the next occurrence above it; undo takes both back.
 */
import { afterEach, expect, it } from 'vitest'

import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** The position of the n-th list item, as a click on its box finds it. */
function itemAt(editor: Open, index: number): number {
  let found = -1
  let seen = 0
  editor.view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.type.name === 'list_item') {
      if (seen === index) found = pos
      seen++
    }
    return true
  })
  return found
}

/** What a click on the box does: Crepe sets the attribute. */
const tick = (editor: Open, index: number, checked: boolean) =>
  editor.view.dispatch(editor.view.state.tr.setNodeAttribute(itemAt(editor, index), 'checked', checked))

it('writes the done date when a task is ticked off, and takes it away when it is opened again', async () => {
  open = await openEditor('- [ ] Water the fern ^f1\n')
  tick(open, 0, true)
  expect(open.text()).toBe(`- [x] Water the fern ✅ ${today()} ^f1\n`)
  tick(open, 0, false)
  expect(open.text()).toBe('- [ ] Water the fern ^f1\n')
})

it('puts the next occurrence of a recurring task above it, and undo takes all of it back', async () => {
  open = await openEditor('- [ ] Sweep **the yard** 🔁 every week 📅 2026-09-27\n')
  tick(open, 0, true)
  expect(open.text()).toBe(
    `- [ ] Sweep **the yard** 🔁 every week 📅 2026-10-04\n- [x] Sweep **the yard** 🔁 every week 📅 2026-09-27 ✅ ${today()}\n`,
  )
  const ticked = open.text()
  open.run('undo')
  expect(open.text()).toBe('- [ ] Sweep **the yard** 🔁 every week 📅 2026-09-27\n')
  // Redo brings the same back, not a second next occurrence on top.
  open.run('redo')
  expect(open.text()).toBe(ticked)
})
