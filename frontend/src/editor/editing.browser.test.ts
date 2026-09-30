/**
 * What the review before 1.0.0 found while writing (PG notes, block Q): pasting code, files, dragging, keys.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it } from 'vitest'

import { insertFiles } from './editor'
import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

/** The caret at the end of the paragraph whose text is ``text``. */
function caretAfter(view: Open['view'], text: string): void {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false
    if (node.type.name === 'paragraph' && node.textContent === text) at = pos + node.nodeSize - 1
    return at < 0
  })
  expect(at).toBeGreaterThan(-1)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

function paste(view: Open['view'], data: Record<string, string>): void {
  const transfer = new DataTransfer()
  for (const [type, value] of Object.entries(data)) transfer.setData(type, value)
  view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
}

const VSCODE_HTML =
  '<meta charset="utf-8"><div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, \'Courier New\', monospace;font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;">' +
  '<div><span style="color: #569cd6;">function</span><span style="color: #cccccc;"> add(a, b) {</span></div>' +
  '<div><span style="color: #cccccc;">    </span><span style="color: #c586c0;">return</span><span style="color: #cccccc;"> a + b</span></div>' +
  '<div><span style="color: #cccccc;">}</span></div></div>'
const VSCODE_TEXT = 'function add(a, b) {\n    return a + b\n}'

describe('code from a code editor (P3.1)', () => {
  it('becomes a code block with its language, the line before untouched', async () => {
    open = await openEditor('Davor.\n\nx\n')
    caretAfter(open.view, 'x')
    open.view.dispatch(open.view.state.tr.delete(open.view.state.selection.from - 1, open.view.state.selection.from))
    paste(open.view, { 'text/plain': VSCODE_TEXT, 'text/html': VSCODE_HTML, 'vscode-editor-data': '{"version":1,"isFromEmptySelection":false,"mode":"javascript"}' })
    expect(open.text()).toBe('Davor.\n\n```javascript\nfunction add(a, b) {\n    return a + b\n}\n```\n')
  })

  it('becomes a code block also without VS Code\'s own note, found by its HTML', async () => {
    open = await openEditor('Davor.\n')
    caretAfter(open.view, 'Davor.')
    paste(open.view, { 'text/plain': VSCODE_TEXT, 'text/html': VSCODE_HTML })
    expect(open.text()).toContain('```\nfunction add(a, b) {\n    return a + b\n}\n```')
    expect(open.text()).not.toContain('&#x20;')
  })

  it('leaves one line of code a line of words, and HTML from elsewhere to the usual way', async () => {
    open = await openEditor('Davor.\n')
    caretAfter(open.view, 'Davor.')
    paste(open.view, { 'text/plain': 'add(a, b)', 'text/html': VSCODE_HTML.replace(/<div><span[\s\S]*<\/div><\/div>$/, '<div>add(a, b)</div></div>') })
    expect(open.text()).toBe('Davor.add(a, b)\n')
  })
})

describe('a file that is not a picture (P1.1)', () => {
  it('comes in as a link to the file, also inside bold words', async () => {
    open = await openEditor('Hier **fett** und so.\n')
    const { schema } = open.view.state
    let inBold = -1
    open.view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'fett') inBold = pos + 2
    })
    open.view.dispatch(open.view.state.tr.setSelection(TextSelection.create(open.view.state.doc, inBold)))
    insertFiles(open.view, [schema.text('liste.pdf', [schema.marks.link.create({ href: 'Attachments/liste.pdf' })])])
    expect(open.text()).toContain('[liste.pdf](Attachments/liste.pdf)')
  })
})

describe('Shift+Tab stays in the editor (P3.8)', () => {
  function shiftTab(view: Open['view']): boolean {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    return view.someProp('handleKeyDown', (handle) => handle(view, event)) ?? false
  }

  it('takes the indentation off a line of code', async () => {
    open = await openEditor('```python\ndef f(x):\n    return x\n```\n')
    let at = -1
    open.view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'code_block') at = pos + 1 + node.textContent.indexOf('return') + 2
    })
    open.view.dispatch(open.view.state.tr.setSelection(TextSelection.create(open.view.state.doc, at)))
    expect(shiftTab(open.view)).toBe(true)
    expect(open.text()).toBe('```python\ndef f(x):\nreturn x\n```\n')
  })

  it('is taken in a paragraph, so the focus stays', async () => {
    open = await openEditor('Ein Satz.\n')
    caretAfter(open.view, 'Ein Satz.')
    expect(shiftTab(open.view)).toBe(true)
    expect(open.text()).toBe('Ein Satz.\n')
  })
})

describe('amounts of money are not a formula (P3.12)', () => {
  it('shows two dollar amounts as words and writes them as they were', async () => {
    open = await openEditor('Es kostet 5 $ und 10 $ zusammen, und $x^2$ ist eine Formel.\n')
    const inline: string[] = []
    open.view.state.doc.descendants((node) => {
      if (node.isInline && !node.isText) inline.push(node.type.name)
    })
    expect(inline).toEqual(['math_inline'])
    expect(open.root.textContent).toContain('5 $ und 10 $')
    const [find, replace] = ['zusammen', 'insgesamt']
    let at = -1
    open.view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text!.includes(find)) at = pos + node.text!.indexOf(find)
    })
    open.view.dispatch(open.view.state.tr.insertText(replace, at, at + find.length))
    expect(open.text()).toBe('Es kostet 5 $ und 10 $ insgesamt, und $x^2$ ist eine Formel.\n')
  })
})

describe('several paragraphs made a list (P3.6)', () => {
  for (const [command, expected] of [
    ['bulletList', '- Eins\n- Zwei\n- Drei\n'],
    ['orderedList', '1. Eins\n2. Zwei\n3. Drei\n'],
    ['taskList', '- [ ] Eins\n- [ ] Zwei\n- [ ] Drei\n'],
  ] as const) {
    it(`${command}: one item for each paragraph`, async () => {
      open = await openEditor('Eins\n\nZwei\n\nDrei\n')
      open.view.dispatch(open.view.state.tr.setSelection(TextSelection.create(open.view.state.doc, 1, open.view.state.doc.content.size - 1)))
      open.run(command)
      expect(open.text()).toBe(expected)
    })
  }
})
