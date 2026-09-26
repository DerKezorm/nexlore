/**
 * What the editor writes into a block that changed: Obsidian's syntax typed into a table cell, bold and italic
 * next to each other, and a list keeping its own marker in a note whose other lists use another.
 */
import type { Mark, Node as ProseNode } from '@milkdown/kit/prose/model'
import { afterEach, expect, it } from 'vitest'

import { openEditor, replaceWord } from './harness'

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

it('escapes the pipe of a wiki link typed into a table cell, so the table keeps its columns', async () => {
  const editor = await open('Start.\n\n| Name | Link |\n| --- | --- |\n| one | two |\n')
  expect(replaceWord(editor.view, 'two', '[[Garden|the garden]]')).toBe(true)
  const written = editor.text()
  expect(written).toContain('[[Garden\\|the garden]]')
  const row = written.split('\n').find((line) => line.includes('Garden'))!
  expect(row.replace(/\\\|/g, '').split('|').length - 2).toBe(2)
})

it('writes bold and italic next to each other so that they read back the same', async () => {
  const editor = await open('Start.\n')
  const { schema } = editor.view.state
  const em = schema.marks.emphasis.create()
  const strong = schema.marks.strong.create()
  const run = (text: string, marks: Mark[]) => schema.text(text, marks)
  const paragraphs: ProseNode[] = [
    schema.nodes.paragraph.create(null, [run('kurs', [em]), run('iv', [em, strong]), run(',', [strong]), run(' end', [])]),
    schema.nodes.paragraph.create(null, [run('a', [strong]), run('b', [em, strong]), run('c', [strong])]),
    schema.nodes.paragraph.create(null, [run('x', [em]), run('y', [strong]), run(' z', [])]),
    schema.nodes.paragraph.create(null, [run('ab', [em, strong]), run('c', [em]), run('.', [])]),
  ]
  const tr = editor.view.state.tr.replaceWith(0, editor.view.state.doc.content.size, paragraphs)
  editor.view.dispatch(tr)
  const written = editor.markdown()
  const again = await open(written)
  // What is marked must come back; with which character (`*` or `_`) is the writer's choice.
  const marks = (doc: ProseNode) => JSON.stringify(doc.toJSON(), (key, value) => (key === 'marker' ? undefined : value))
  expect(marks(again.view.state.doc)).toBe(marks(editor.view.state.doc))
})

it('keeps the marker of a list in a note whose other lists use another', async () => {
  const text = '* one\n* two\n\nText.\n\n- alpha\n- beta\n- gamma\n\nMore.\n\n- x\n- y\n'
  const editor = await open(text)
  expect(replaceWord(editor.view, 'two', 'TWO')).toBe(true)
  expect(editor.text()).toBe(text.replace('two', 'TWO'))
})
