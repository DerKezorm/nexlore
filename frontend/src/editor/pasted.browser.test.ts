/**
 * Formatted text pasted from outside (`editor/pasted.ts`), as the browser pastes it: a first block stays a block,
 * Word's lists become lists, a code block keeps its language; words copied inside the editor keep their way.
 */
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, expect, it } from 'vitest'

import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

function pasteHtml(view: EditorView, html: string, text = 'plain') {
  const data = new DataTransfer()
  data.setData('text/html', html)
  data.setData('text/plain', text)
  view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}

async function pastedAtEnd(html: string): Promise<string> {
  open = await openEditor('Start.\n')
  open.view.dispatch(open.view.state.tr.setSelection(Selection.atEnd(open.view.state.doc)))
  pasteHtml(open.view, html)
  const text = open.text()
  await open.close()
  open = null
  return text
}

it('keeps a pasted heading, list or code block a block of its own at the end of a line', async () => {
  expect(await pastedAtEnd('<h2>Prices</h2><p>Cheap.</p>')).toBe('Start.\n\n## Prices\n\nCheap.\n')
  expect(await pastedAtEnd('<ul><li>One<ul><li>One a</li></ul></li><li>Two</li></ul>')).toBe('Start.\n\n- One\n  - One a\n- Two\n')
  expect(await pastedAtEnd('<p>Just words</p>')).toBe('Start.Just words\n')
})

it('makes lists of Word\'s list paragraphs, numbered where Word numbered them', async () => {
  const bullets =
    '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><span style="font-family:Symbol">·<span>&nbsp;&nbsp;</span></span>Bullet one<o:p></o:p></p>' +
    '<p class=MsoListParagraphCxSpLast style="mso-list:l0 level1 lfo1"><span style="font-family:Symbol">·<span>&nbsp;</span></span>Bullet two<o:p></o:p></p>'
  expect(await pastedAtEnd(bullets)).toBe('Start.\n\n- Bullet one\n- Bullet two\n')
  const numbered =
    '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><span>1.<span>&nbsp;&nbsp;</span></span>First<o:p></o:p></p>' +
    '<p class=MsoListParagraphCxSpMiddle style="mso-list:l0 level2 lfo1"><span>a.<span>&nbsp;</span></span>Inner<o:p></o:p></p>' +
    '<p class=MsoListParagraphCxSpLast style="mso-list:l0 level1 lfo1"><span>2.<span>&nbsp;</span></span>Second<o:p></o:p></p>'
  expect(await pastedAtEnd(numbered)).toBe('Start.\n\n1. First\n   1. Inner\n2. Second\n')
})

it('keeps a code block\'s language and no empty line at its end', async () => {
  expect(await pastedAtEnd('<pre class="lang-python"><code>print(1)\nprint(2)\n</code></pre>')).toBe('Start.\n\n```python\nprint(1)\nprint(2)\n```\n')
  expect(await pastedAtEnd('<pre><code class="language-js">let a = 1\n</code></pre>')).toBe('Start.\n\n```js\nlet a = 1\n```\n')
})

it('pastes words copied inside the editor as words, even out of a list item', async () => {
  open = await openEditor('Start.\n\n- copied words here\n')
  const { view } = open
  let from = -1
  view.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.startsWith('copied')) from = pos
    return from < 0
  })
  // The editor's own copy of two words inside the list item, as the browser would carry it.
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 'copied words'.length)))
  const copied = new DataTransfer()
  view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: copied, bubbles: true, cancelable: true }))
  expect(copied.getData('text/html')).toContain('data-pm-slice')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 'Start.'.length + 1)))
  pasteHtml(view, copied.getData('text/html'), copied.getData('text/plain'))
  expect(open.text()).toBe('Start.copied words\n\n- copied words here\n')
})

it('keeps a bulleted list right before a numbered one two lists, and drops Outlook own bullet (review P3.13)', async () => {
  const word =
    '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><span style="font-family:Symbol">·<span>&nbsp;&nbsp;</span></span>Bullet A<o:p></o:p></p>' +
    '<p class=MsoListParagraphCxSpLast style="mso-list:l1 level1 lfo2"><span>1.<span>&nbsp;&nbsp;</span></span>Nummer A<o:p></o:p></p>'
  expect(await pastedAtEnd(word)).toBe('Start.\n\n- Bullet A\n\n1. Nummer A\n')
  const outlook = '<ul><li class=MsoListParagraph><span style="mso-list:Ignore">•<span>&nbsp;&nbsp;</span></span>Punkt</li></ul>'
  expect(await pastedAtEnd(outlook)).toBe('Start.\n\n- Punkt\n')
})
