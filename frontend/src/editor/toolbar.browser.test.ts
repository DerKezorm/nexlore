/**
 * The commands of the fixed toolbar and what it lights: run in a real editor, judged by the Markdown written.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, expect, it } from 'vitest'

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

/** Where a word starts in the document (the first time it comes). */
function at(view: EditorView, word: string): number {
  let hit = -1
  view.state.doc.descendants((node, pos) => {
    if (hit >= 0) return false
    if (node.isText && node.text!.includes(word)) hit = pos + node.text!.indexOf(word)
    return hit < 0
  })
  if (hit < 0) throw new Error(`no "${word}"`)
  return hit
}

function select(view: EditorView, word: string) {
  const from = at(view, word)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + word.length)))
}

function caret(view: EditorView, word: string) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at(view, word) + 1)))
}

it('lights what holds where the caret is: marks, heading, list, quote, table and its head row', async () => {
  const editor = await open('# Title\n\nSome **bold** words.\n\n- one\n- two\n\n> quoted\n\n| A | B |\n| --- | --- |\n| c | d |\n')
  caret(editor.view, 'Title')
  expect(editor.status()).toMatchObject({ block: 'h1', list: null, quote: false, table: false })
  caret(editor.view, 'bold')
  expect(editor.status().marks).toEqual(['strong'])
  select(editor.view, 'Some')
  expect(editor.status().marks).toEqual([])
  caret(editor.view, 'two')
  expect(editor.status()).toMatchObject({ list: 'bullet', canIndent: true, canOutdent: true })
  caret(editor.view, 'one')
  // The first item has nothing to go under.
  expect(editor.status().canIndent).toBe(false)
  caret(editor.view, 'quoted')
  expect(editor.status().quote).toBe(true)
  caret(editor.view, 'A')
  expect(editor.status()).toMatchObject({ table: true, headerRow: true })
  caret(editor.view, 'c')
  expect(editor.status()).toMatchObject({ table: true, headerRow: false })
})

it('tells of every change of the selection, and stops when asked', async () => {
  const editor = await open('One two.\n')
  let told = 0
  const stop = editor.subscribe(() => told++)
  caret(editor.view, 'two')
  expect(told).toBe(1)
  stop()
  caret(editor.view, 'One')
  expect(told).toBe(1)
})

it('undoes and redoes, and says when it can', async () => {
  const editor = await open('Plain words.\n')
  expect(editor.status().canUndo).toBe(false)
  select(editor.view, 'words')
  editor.run('bold')
  expect(editor.markdown()).toContain('**words**')
  expect(editor.status().canUndo).toBe(true)
  editor.run('undo')
  expect(editor.markdown()).not.toContain('**')
  expect(editor.status().canRedo).toBe(true)
  editor.run('redo')
  expect(editor.markdown()).toContain('**words**')
})

it('clears formatting on the selection but keeps its links', async () => {
  const editor = await open('A ***loud*** and `coded` [site](https://example.com) end.\n')
  select(editor.view, 'loud')
  editor.run('clear')
  select(editor.view, 'coded')
  editor.run('clear')
  select(editor.view, 'site')
  editor.run('bold')
  editor.run('clear')
  expect(editor.markdown()).toBe('A loud and coded [site](https://example.com) end.\n')
})

it('indents and outdents a list item', async () => {
  const editor = await open('- one\n- two\n')
  caret(editor.view, 'two')
  editor.run('indent')
  expect(editor.markdown()).toMatch(/^- one\n\s+- two\n$/)
  editor.run('outdent')
  expect(editor.markdown()).toBe('- one\n- two\n')
})

it('makes a callout of the kind chosen, and an unknown kind a note', async () => {
  const editor = await open('Mind the step.\n\nSecond.\n')
  caret(editor.view, 'Mind')
  editor.run('callout', 'warning')
  caret(editor.view, 'Second')
  editor.run('callout', 'x"><script>')
  expect(editor.markdown()).toBe('> [!warning] Mind the step.\n\n> [!note] Second.\n')
})

it('adds and deletes rows and columns, never above or of the head row, and deletes the table', async () => {
  const editor = await open('| A | B |\n| --- | --- |\n| c | d |\n')
  caret(editor.view, 'c')
  editor.run('rowAfter')
  editor.run('colAfter')
  const grown = editor.markdown().trim().split('\n')
  expect(grown).toHaveLength(4)
  expect(grown[0].split('|').length - 2).toBe(3)
  caret(editor.view, 'A')
  editor.run('rowBefore')
  editor.run('deleteRow')
  expect(editor.markdown().trim().split('\n')).toHaveLength(4)
  expect(editor.markdown()).toContain('A')
  caret(editor.view, 'c')
  editor.run('deleteRow')
  expect(editor.markdown()).not.toContain('c')
  caret(editor.view, 'B')
  editor.run('deleteCol')
  expect(editor.markdown().trim().split('\n')[0].split('|').length - 2).toBe(2)
  editor.run('deleteTable')
  expect(editor.markdown().trim()).toBe('')
})

it('turns a paragraph into a formula, and wraps the selection into an embed', async () => {
  const editor = await open('E = mc^2\n\nPlan\n')
  caret(editor.view, 'mc')
  editor.run('math')
  expect(editor.status().block).toBe('math')
  select(editor.view, 'Plan')
  editor.run('embed')
  const written = editor.markdown()
  expect(written).toContain('$$')
  expect(written).toContain('E = mc^2')
  expect(written).toContain('![[Plan]]')
})

it('puts a web link on words, and on words of its own where nothing was selected', async () => {
  const editor = await open('Read this.\n')
  caret(editor.view, 'this')
  editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, at(editor.view, '.'))))
  editor.run('link')
  // The words are there and selected; the address is asked in Crepe's box.
  const { from, to } = editor.view.state.selection
  expect(editor.view.state.doc.textBetween(from, to)).toBe('link')
})
