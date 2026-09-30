/**
 * Tables with some comfort: a new or pasted table has no alignment (written `---`, as Obsidian does), a column's
 * alignment is set and taken away, rows sort by a column (numbers as numbers, the header stays), Tab goes on to the
 * next cell.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, expect, it } from 'vitest'

import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

function caretIn(view: EditorView, words: string) {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === words) at = pos + 1
    return at < 0
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

const TABLE = '# Prices\n\n| Item | Price |\n| --- | :-: |\n| Tea | 10 |\n| Cake | 2 |\n| Bread | 7 |\n'

it('writes a new table without alignment, as Obsidian writes one', async () => {
  open = await openEditor('Start.\n')
  const { view } = open
  caretIn(view, 'Start.')
  open.run('table')
  expect(open.text()).toMatch(/\n\| +\| +\| +\|\n\| -{3,} \| -{3,} \| -{3,} \|\n/)
  expect(open.text()).not.toContain(':-')
})

it('keeps a pasted table without alignment unless it had one', async () => {
  open = await openEditor('Start.\n')
  const { view } = open
  caretIn(view, 'Start.')
  const data = new DataTransfer()
  data.setData('text/html', '<table><tr><th>A</th><th style="text-align: right">B</th></tr><tr><td>1</td><td style="text-align: right">2</td></tr></table>')
  data.setData('text/plain', 'A B')
  view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  expect(open.text()).toContain('| A | B |\n| --- | --: |\n| 1 | 2 |')
})

it('sets and takes away a column\'s alignment, the other columns as they were', async () => {
  open = await openEditor(TABLE)
  const { view } = open
  caretIn(view, 'Tea')
  open.run('alignRight')
  expect(open.text()).toContain('| Item | Price |\n| --: | :-: |')
  // Every cell of the column, not the head alone (the file takes the head's; the editor shows each cell's).
  const column: unknown[] = []
  view.state.doc.descendants((node) => {
    if (node.type.name === 'table_row' || node.type.name === 'table_header_row') column.push(node.child(0).attrs.alignment)
    return true
  })
  expect(column).toEqual(['right', 'right', 'right', 'right'])
  caretIn(view, '10')
  open.run('alignNone')
  expect(open.text()).toContain('| Item | Price |\n| --: | --- |')
})

it('sorts the rows by the cursor\'s column, numbers as numbers, the header staying on top', async () => {
  open = await openEditor(TABLE)
  const { view } = open
  caretIn(view, 'Tea')
  open.run('sortAsc')
  expect(open.text()).toContain('| Bread | 7 |\n| Cake | 2 |\n| Tea | 10 |')
  caretIn(view, '7')
  open.run('sortDesc')
  expect(open.text()).toContain('| Tea | 10 |\n| Bread | 7 |\n| Cake | 2 |')
  expect(open.text()).toMatch(/^# Prices\n\n\| Item \| Price \|/)
})

it('goes on to the next cell with Tab', async () => {
  open = await openEditor(TABLE)
  const { view } = open
  caretIn(view, 'Tea')
  view.someProp('handleKeyDown', (handle) => handle(view, new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
  expect(view.state.selection.$from.parent.textContent).toBe('10')
})

it('adds a row with Tab in the last cell and goes into it, without blanks in the cell (review P3.9)', async () => {
  open = await openEditor(TABLE)
  const { view } = open
  caretIn(view, '7')
  view.someProp('handleKeyDown', (handle) => handle(view, new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
  view.dispatch(view.state.tr.insertText('Jam'))
  expect(open.text()).toContain('| Bread | 7 |\n| Jam |')
  expect(open.text()).not.toMatch(/7 {2,}/)
})
