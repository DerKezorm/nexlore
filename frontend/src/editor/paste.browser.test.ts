/**
 * Pasting into the editor: a picture that only exists in the browser (a `data:` or `blob:` address) never ends up
 * in the note as a huge address; ordinary pictures and text come through.
 */
import { Selection } from '@milkdown/kit/prose/state'
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
