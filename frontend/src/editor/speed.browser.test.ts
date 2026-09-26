/**
 * The editor stays usable with long and with hostile notes: opening, moving the cursor and saving take bounded
 * time. The limits are generous (a slow CI machine), they catch quadratic behaviour, not small slowdowns.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, expect, it } from 'vitest'

import { openEditor, replaceWord } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

async function timed<T>(work: () => T | Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const result = await work()
  return [result, performance.now() - started]
}

function moveCursor(editor: Open, times: number) {
  const size = editor.view.state.doc.content.size
  for (let k = 0; k < times; k++) {
    const at = 1 + Math.floor((size - 2) * (k / times))
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.near(editor.view.state.doc.resolve(at))))
  }
}

it('a long note (about 200 KB) opens, follows the cursor and saves in bounded time', async () => {
  const paragraph = (i: number) =>
    `Paragraph ${i} with a [[Link ${i % 50}]], some **bold**, a #tag${i % 7} and ==marked== words to make it look real.`
  const text = Array.from({ length: 1800 }, (_, i) => (i % 10 === 0 ? `## Section ${i}` : paragraph(i))).join('\n\n') + '\n'
  const [, opening] = await timed(async () => (open = await openEditor(text)))
  const editor = open!
  const [, moving] = await timed(() => moveCursor(editor, 50))
  replaceWord(editor.view, 'Paragraph 900 ', 'Changed 900 ')
  const [saved, saving] = await timed(() => editor.text())
  expect(saved).toBe(text.replace('Paragraph 900 ', 'Changed 900 '))
  console.log(`long note: open ${opening.toFixed(0)} ms, 50 cursor moves ${moving.toFixed(0)} ms, first save ${saving.toFixed(0)} ms`)
  expect(opening).toBeLessThan(15_000)
  expect(moving / 50).toBeLessThan(40)
  expect(saving).toBeLessThan(15_000)
})

// 10,000, not more: micromark itself (the parser under remark) turns superlinear on this line beyond that (20,000:
// 4 s to parse, without any of nexlore's extensions). Obsidian notes do not look like this.
it('a hostile line (10,000 unclosed [[, == and <%) does not hang the editor', async () => {
  const text = 'Start\n\n' + '[[a == <% '.repeat(10_000).trimEnd() + '\n\nEnd\n'
  const [, opening] = await timed(async () => (open = await openEditor(text)))
  const editor = open!
  const [, moving] = await timed(() => moveCursor(editor, 10))
  console.log(`hostile line: open ${opening.toFixed(0)} ms, 10 cursor moves ${moving.toFixed(0)} ms`)
  expect(opening).toBeLessThan(15_000)
  expect(moving / 10).toBeLessThan(80)
  expect(editor.text()).toBe(text)
})
