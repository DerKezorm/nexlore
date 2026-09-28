/**
 * The live preview as a reader sees it: what a wiki link, an embed, a highlight, a tag and a callout show, what
 * hides, what a click does, and that the brackets come back where the cursor is.
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'

import '../styles/editor.css'
import { openEditor } from './harness'
import type { EmbedShown } from './live'

type Open = Awaited<ReturnType<typeof openEditor>>
let open: Open | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const shown = (root: HTMLElement, selector: string) => [...root.querySelectorAll(selector)].map((element) => element.textContent)

/** Puts the cursor right after a piece of text, as a click there would. */
function cursorAfter(editor: Open, text: string) {
  let at = -1
  editor.view.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return at < 0
    const index = node.text!.indexOf(text)
    if (index >= 0) at = pos + index + text.length
    return false
  })
  expect(at).toBeGreaterThan(0)
  editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, at)))
}

it('shows a wiki link by its alias or name, the brackets hidden, a missing target marked', async () => {
  open = await openEditor('Start.\n\nSee [[Garden|the garden]] and [[Nowhere]] and [[Plan#Goals]].\n', {
    links: { exists: (target) => target !== 'Nowhere' },
  })
  // A heading of another note reads "Plan › Goals": the "#" hides, an arrow stands in its place.
  expect(shown(open.root, '.nx-wiki:not(.nx-subpath):not(.nx-hide)')).toEqual(['the garden', 'Nowhere', 'Plan', 'Goals'])
  expect(shown(open.root, '.nx-subpath')).toEqual([' › '])
  expect(shown(open.root, '.nx-wiki-missing')).toEqual(['Nowhere'])
  expect(shown(open.root, '.nx-hide')).toEqual(['[[Garden|', ']]', '[[', ']]', '[[', '#', ']]'])
  const targets = [...open.root.querySelectorAll('.nx-wiki[data-target]:not(.nx-hide)')].map((element) => element.getAttribute('data-target'))
  expect(targets).toEqual(['Garden', 'Nowhere', 'Plan#Goals', 'Plan#Goals'])
})

it('shows a link in a table cell by its alias, the escaped pipe included', async () => {
  open = await openEditor('Start.\n\n| Link |\n| --- |\n| [[Garden\\|the garden]] |\n', { links: { exists: (target) => target === 'Garden' } })
  expect(shown(open.root, '.nx-wiki')).toEqual(['the garden'])
  expect(open.root.querySelector('.nx-wiki')?.getAttribute('data-target')).toBe('Garden')
  expect(open.text()).toBe('Start.\n\n| Link |\n| --- |\n| [[Garden\\|the garden]] |\n')
})

it('shows the brackets of the link the cursor is in, and hides them again when it leaves', async () => {
  open = await openEditor('First [[Garden]] here.\n\nSecond paragraph.\n')
  cursorAfter(open, '[[Gar')
  expect(shown(open.root, '.nx-wiki-editing')).toEqual(['Garden'])
  expect(shown(open.root, '.nx-syntax')).toEqual(['[[', ']]'])
  cursorAfter(open, 'Second')
  expect(shown(open.root, '.nx-wiki-editing')).toEqual([])
  expect(shown(open.root, '.nx-hide')).toEqual(['[[', ']]'])
})

it('shows an embedded picture, video or sound itself, and the text again where the cursor is', async () => {
  const media: Record<string, EmbedShown | null | undefined> = {
    'photo.png': { url: '/api/file?path=S%2Fphoto.png', kind: 'image' },
    'clip.mp4': { url: '/api/file?path=S%2Fclip.mp4', kind: 'video' },
    'later.png': undefined,
    'doc.pdf': null,
  }
  open = await openEditor('Start.\n\n![[photo.png|120]] and ![[clip.mp4]] and ![[later.png]] and ![[doc.pdf]]\n', {
    links: { embed: (target) => media[target] },
  })
  const shownMedia = [...open.root.querySelectorAll('.nx-embed-media')] as HTMLElement[]
  expect(shownMedia.map((element) => [element.tagName, element.getAttribute('src'), element.style.width])).toEqual([
    ['IMG', '/api/file?path=S%2Fphoto.png', '120px'],
    ['VIDEO', '/api/file?path=S%2Fclip.mp4', ''],
  ])
  // Not known yet, or not a picture: a chip with the name.
  expect(shown(open.root, '.nx-embed:not(.nx-hide)')).toEqual(['later.png', 'doc.pdf'])
  cursorAfter(open, '![[photo')
  expect(open.root.querySelectorAll('.nx-embed-media')).toHaveLength(1)
  expect(shown(open.root, '.nx-wiki-editing')).toEqual(['photo.png|120'])
  // The file's text stays as written.
  expect(open.text()).toBe('Start.\n\n![[photo.png|120]] and ![[clip.mp4]] and ![[later.png]] and ![[doc.pdf]]\n')
})

it('shows the name of an embed, not its size', async () => {
  open = await openEditor('Start.\n\n![[photo.png|300]] and ![[Other note|a caption]]\n')
  expect(shown(open.root, '.nx-embed')).toEqual(['photo.png', 'a caption'])
})

it('highlights, dims comments, marks tags and block ids, and labels a callout', async () => {
  open = await openEditor('Start.\n\nSome ==marked== text %%hidden%% with #tag and a#b. ^block-1\n\n> [!warning] Careful\n> Inside.\n')
  expect(shown(open.root, '.nx-highlight')).toEqual(['marked'])
  expect(shown(open.root, '.nx-comment')).toEqual(['%%hidden%%'])
  expect(shown(open.root, '.nx-tag')).toEqual(['#tag'])
  expect(shown(open.root, '.nx-blockid')).toEqual(['^block-1'])
  expect(shown(open.root, '.nx-callout-label')).toEqual(['warning'])
  expect(open.root.querySelector('.nx-callout')?.getAttribute('data-callout')).toBe('warning')
  // Only the first line is the title; the text below it is text, on a line of its own (as Obsidian shows it).
  expect(shown(open.root, '.nx-callout-title').join('').trim()).toBe('Careful')
  const title = open.root.querySelector('.nx-callout-title')!.getBoundingClientRect()
  const walker = document.createTreeWalker(open.root.querySelector('.nx-callout')!, NodeFilter.SHOW_TEXT)
  let inside: Text | null = null
  while (walker.nextNode()) if (walker.currentNode.textContent?.includes('Inside.')) inside = walker.currentNode as Text
  const range = document.createRange()
  range.selectNodeContents(inside!)
  expect(range.getBoundingClientRect().top).toBeGreaterThanOrEqual(title.bottom - 1)
})

it('opens a link on a click, in a new tab with Ctrl', async () => {
  const opened: [string, boolean][] = []
  open = await openEditor('Start.\n\nGo to [[Garden|there]].\n', { links: { open: (target, newTab) => opened.push([target, newTab]) } })
  const link = () => open!.root.querySelector('.nx-wiki[data-target]:not(.nx-hide)') as HTMLElement
  await userEvent.click(link())
  // The click put the cursor into the link (on the page it goes to the note anyway): away from it again.
  cursorAfter(open, 'Start')
  await userEvent.keyboard('{Control>}')
  await userEvent.click(link())
  await userEvent.keyboard('{/Control}')
  expect(opened).toEqual([
    ['Garden', false],
    ['Garden', true],
  ])
})

it('works out after a change only what changed, and gets the same as working out everything', async () => {
  open = await openEditor('One [[A]] ==x==.\n\nTwo #tag.\n\nThree [[B|b]].\n')
  cursorAfter(open, 'Two')
  open.view.dispatch(open.view.state.tr.insertText(' [[C]]'))
  cursorAfter(open, 'Three')
  // A change away from the cursor (another tab's text coming in, a command): that block is worked out again too.
  cursorAfter(open, 'One')
  let at = -1
  open.view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.startsWith('Three')) at = pos + 'Three'.length
    return at < 0
  })
  open.view.dispatch(open.view.state.tr.insertText(' [[D]]', at))
  expect(open.view.state.selection.from).toBeLessThan(at)
  const step = shown(open.root, '.nx-wiki, .nx-hide, .nx-tag, .nx-highlight')
  open.refresh()
  expect(shown(open.root, '.nx-wiki, .nx-hide, .nx-tag, .nx-highlight')).toEqual(step)
  expect(shown(open.root, '.nx-wiki:not(.nx-subpath)')).toEqual(['A', 'C', 'D', 'b'])
})
