/**
 * Pasting into the editor: a picture that only exists in the browser (a `data:` or `blob:` address) never ends up
 * in the note as a huge address; ordinary pictures and text come through.
 */
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, expect, it } from 'vitest'

import { openEditor } from './harness'

type Open = Awaited<ReturnType<typeof openEditor>>
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
  view.pasteText('  https://example.com/guide  ')
  expect(open.text()).toBe('Read [the guide](https://example.com/guide) today.\n\nSecond line.\n')
  // The words are still chosen: a second address replaces the first.
  view.pasteText('https://example.com/other')
  expect(open.text()).toBe('Read [the guide](https://example.com/other) today.\n\nSecond line.\n')
  // Words that are no address, or no words chosen: pasted as they are.
  const second = at('Second')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, second, second + 6)))
  view.pasteText('not an address')
  expect(open.text()).toContain('not an address line.')
  // One word without a scheme is no address either.
  const line = at('line.')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, line, line + 4)))
  view.pasteText('example.com')
  expect(open.text()).toContain('not an address example.com.')
  view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)))
  view.pasteText('https://example.com/end')
  expect(open.text()).toContain('https://example.com/end')
  expect(open.text()).not.toContain('](https://example.com/end)')
})
