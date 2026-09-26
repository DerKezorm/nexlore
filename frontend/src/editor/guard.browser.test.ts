/**
 * The loss guard: a block the editor would lose letters of stays raw Markdown. No construct known today loses
 * anything any more, so the test brings its own: a remark step that drops level 6 headings, the
 * way Milkdown dropped images without a title.
 */
import { $remark } from '@milkdown/kit/utils'
import type { Root } from 'mdast'
import { afterEach, expect, it } from 'vitest'

import { openEditor, replaceWord } from './harness'
import { forcedRaw } from './syntax'

const dropSmallHeadings = $remark('testDropH6', () => () => (tree: Root) => {
  tree.children = tree.children.filter((node) => !(node.type === 'heading' && node.depth === 6))
})

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const TEXT = '# Title\n\nA paragraph.\n\n###### Small heading the editor would lose\n\nLast paragraph.\n'

it('keeps a block the editor would lose as raw Markdown, through edits around it', async () => {
  open = await openEditor(TEXT, { plugins: [dropSmallHeadings].flat() })
  const raw = open.view.state.doc.child(2)
  expect(raw.type.name).toBe('nx_raw_block')
  expect(raw.attrs.value).toBe('###### Small heading the editor would lose')
  expect(open.text()).toBe(TEXT)
  expect(replaceWord(open.view, 'Last', 'Final')).toBe(true)
  expect(replaceWord(open.view, 'A paragraph', 'One paragraph')).toBe(true)
  expect(open.text()).toBe(TEXT.replace('Last', 'Final').replace('A paragraph', 'One paragraph'))
})

it('two editors with the same text keep it marked until both are closed', async () => {
  const first = await openEditor(TEXT, { plugins: [dropSmallHeadings].flat() })
  const second = await openEditor(TEXT, { plugins: [dropSmallHeadings].flat() })
  await first.close()
  expect(second.view.state.doc.child(2).type.name).toBe('nx_raw_block')
  expect(replaceWord(second.view, 'Last', 'Final')).toBe(true)
  expect(second.text()).toBe(TEXT.replace('Last', 'Final'))
  await second.close()
  expect(forcedRaw.size).toBe(0)
})

/** Drops inline code, the way a quirk could lose one word of a block and keep all its letters elsewhere. */
const dropInlineCode = $remark('testDropInlineCode', () => () => (tree: Root) => {
  for (const node of tree.children) {
    if (node.type === 'paragraph') node.children = node.children.filter((child) => child.type !== 'inlineCode')
  }
})

it('counts letters: a block that still has every letter somewhere, but fewer of them, stays raw too', async () => {
  const text = 'Start.\n\nKeep `Keep` here.\n'
  open = await openEditor(text, { plugins: [dropInlineCode].flat() })
  expect(open.view.state.doc.child(1).type.name).toBe('nx_raw_block')
  expect(replaceWord(open.view, 'Start', 'Begin')).toBe(true)
  expect(open.text()).toBe(text.replace('Start', 'Begin'))
})

it('forgets the texts it marked when the editor closes', async () => {
  open = await openEditor(TEXT, { plugins: [dropSmallHeadings].flat() })
  expect(forcedRaw.size).toBeGreaterThan(0)
  await open.close()
  open = null
  expect(forcedRaw.size).toBe(0)
})
