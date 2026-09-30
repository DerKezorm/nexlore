/**
 * Pasting into the editor: a picture that only exists in the browser (a `data:` or `blob:` address) never ends up
 * in the note as a huge address; ordinary pictures and text come through.
 */
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, expect, it } from 'vitest'

import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>

/** Pasting as the browser does: an event with the clipboard's text on the editor (Milkdown's own paste listens too). */
function paste(view: EditorView, text: string) {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

it('keeps the path the note wrote when a picture is copied inside the editor, not the address it shows from', async () => {
  open = await openEditor('Start.\n')
  open.view.dispatch(open.view.state.tr.setSelection(Selection.atEnd(open.view.state.doc)))
  open.view.pasteHTML('<p><img src="/api/file?path=Home%2FAnh%C3%A4nge%2Fx.png" data-nx-src="Anh%C3%A4nge/x.png" alt="x"></p>')
  expect(open.text()).toContain('![x](Anh%C3%A4nge/x.png')
  expect(open.text()).not.toContain('/api/file')
})

it('takes the address a picture from another site shows, not what a lazy loader keeps in data-src', async () => {
  open = await openEditor('Start.\n')
  open.view.dispatch(open.view.state.tr.setSelection(Selection.atEnd(open.view.state.doc)))
  open.view.pasteHTML('<p><img src="https://example.com/shown.png" data-src="https://example.com/other.png" alt="y"></p>')
  expect(open.text()).toContain('https://example.com/shown.png')
  expect(open.text()).not.toContain('other.png')
})

it('leaves pictures with a data or blob address out of pasted content, and keeps the rest', async () => {
  open = await openEditor('Start.\n')
  open.view.dispatch(open.view.state.tr.setSelection(Selection.atEnd(open.view.state.doc)))
  open.view.pasteHTML(
    '<p>Pasted <img src="data:image/png;base64,iVBORw0KGgo=" alt="one"> text <img src="blob:http://localhost/x" alt="two">' +
      ' and <img src="https://example.com/pic.png" alt="three"></p>',
  )
  const written = open.text()
  expect(written).not.toMatch(/data:|blob:/)
  expect(written).toContain('Pasted')
  // Milkdown takes a pasted picture's alt text as its title too.
  expect(written).toMatch(/!\[three\]\(https:\/\/example\.com\/pic\.png( "three")?\)/)
})

it('an address pasted onto chosen words makes them a link to it; elsewhere it stays text', async () => {
  open = await openEditor('Read the guide today.\n\nSecond line.\n')
  const { view } = open
  const at = (word: string) => {
    let found = -1
    view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text!.includes(word)) found = pos + node.text!.indexOf(word)
      return found < 0
    })
    return found
  }
  const guide = at('the guide')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, guide, guide + 9)))
  paste(view, '  https://example.com/guide  ')
  expect(open.text()).toBe('Read [the guide](https://example.com/guide) today.\n\nSecond line.\n')
  // The words are still chosen: a second address replaces the first.
  paste(view, 'https://example.com/other')
  expect(open.text()).toBe('Read [the guide](https://example.com/other) today.\n\nSecond line.\n')
  // Words that are no address, or no words chosen: pasted as they are.
  const second = at('Second')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, second, second + 6)))
  paste(view, 'not an address')
  expect(open.text()).toContain('not an address line.')
  // One word without a scheme is no address either.
  const line = at('line.')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, line, line + 4)))
  paste(view, 'example.com')
  expect(open.text()).toContain('not an address example.com.')
  view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)))
  paste(view, 'https://example.com/end')
  expect(open.text()).toContain('https://example.com/end')
  expect(open.text()).not.toContain('](https://example.com/end)')
})

it('a web address pasted where nothing is chosen gets the page\'s title as its words, once it comes', async () => {
  const asked: string[] = []
  const answers: ((title: string | null) => void)[] = []
  let titles = true
  open = await openEditor('Start.\n', {
    linkTitle: (url) => {
      if (!titles) return null
      asked.push(url)
      return new Promise((resolve) => answers.push(resolve))
    },
  })
  const { view } = open
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const toEnd = () => view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)))
  toEnd()
  paste(view, 'https://example.com/tea')
  expect(asked).toEqual(['https://example.com/tea'])
  // A link to itself until the title comes.
  expect(open.text()).toContain('https://example.com/tea')
  answers[0]('Tea and Biscuits')
  await settle()
  expect(open.text()).toBe('Start.[Tea and Biscuits](https://example.com/tea)\n')

  // Its words changed before the title came: they stay.
  toEnd()
  paste(view, ' https://example.com/two')
  let two = -1
  view.state.doc.descendants((node, pos) => {
    if (two < 0 && node.isText && node.text === 'https://example.com/two') two = pos
    return two < 0
  })
  view.dispatch(view.state.tr.insertText('X', two + 8))
  answers[1]('Two')
  await settle()
  expect(open.text()).toContain('https://Xexample.com/two')
  expect(open.text()).not.toMatch(/\[Two/)

  // No title asked for: pasted as before; a mail address is never asked.
  titles = false
  toEnd()
  paste(view, ' https://example.com/plain')
  expect(open.text()).toContain('https://example.com/plain')
  expect(open.text()).not.toContain('](https://example.com/plain)')
  titles = true
  toEnd()
  paste(view, ' mailto:a@example.com')
  expect(asked).toEqual(['https://example.com/tea', 'https://example.com/two'])
})
