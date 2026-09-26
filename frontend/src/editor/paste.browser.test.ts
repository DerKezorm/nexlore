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
