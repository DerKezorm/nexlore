/**
 * The bridge to the iPhone app, driven as the app drives it: calls on the bridge, messages read from a stand-in for
 * `webkit.messageHandlers.nexlore`. Judged by what the app is told (`change`, `state`, `suggest`, `asset`, `openLink`).
 */
import { TextSelection } from '@milkdown/kit/prose/state'
import { afterEach, beforeAll, expect, it } from 'vitest'

import { CHANGE_EVERY, createBridge, type BridgeHandle, type Message } from './bridge'
import { startEditorI18n } from './i18n'

beforeAll(() => startEditorI18n('en'))

type Open = { bridge: BridgeHandle; seen: Message[]; host: HTMLElement }
const opened: Open[] = []
afterEach(async () => {
  for (const { bridge, host } of opened.splice(0)) {
    await bridge.destroy()
    host.remove()
  }
})

async function open(text: string, options: { readOnly?: boolean } = {}): Promise<Open> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const seen: Message[] = []
  const bridge = createBridge(host, (message) => seen.push(message))
  const made = { bridge, seen, host }
  opened.push(made)
  bridge.load({ text, readOnly: options.readOnly, theme: { mode: 'dark', accent: '#2dd4bf' } })
  await bridge.settled()
  return made
}

const of = <T extends Message['type']>(seen: Message[], type: T) => seen.filter((message): message is Extract<Message, { type: T }> => message.type === type)

/** The last `change` after the queue is done and the wait is over (`blur` sends it at once). */
async function told(made: Open): Promise<string> {
  made.bridge.blur()
  await made.bridge.settled()
  const changes = of(made.seen, 'change')
  if (!changes.length) throw new Error('no change told')
  return changes[changes.length - 1].text
}

function caretAfter(made: Open, word: string) {
  const view = made.bridge.current()!.view
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false
    if (node.isText && node.text!.includes(word)) at = pos + node.text!.indexOf(word) + word.length
    return at < 0
  })
  if (at < 0) throw new Error(`no "${word}"`)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

function select(made: Open, word: string) {
  caretAfter(made, word)
  const view = made.bridge.current()!.view
  const to = view.state.selection.from
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to - word.length, to)))
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

it('shows a note with its front matter as properties and tells nothing changed', async () => {
  const text = '---\nstatus: draft\n---\n# Garden\n\nTomatoes [[Compost]] #green\n'
  const made = await open(text)
  expect(made.host.querySelector('.ProseMirror h1')?.textContent).toBe('Garden')
  await expect.poll(() => [...made.host.querySelectorAll<HTMLInputElement>('.nx-properties input')].map((field) => field.value)).toContain('draft')
  expect(made.host.querySelector('.nx-wiki')?.textContent).toContain('Compost')
  expect(made.host.querySelector('.nx-tag')?.textContent).toBe('#green')
  expect(of(made.seen, 'state')).toHaveLength(1)
  expect(of(made.seen, 'height').length).toBeGreaterThan(0)
  await sleep(CHANGE_EVERY + 100)
  expect(of(made.seen, 'change')).toEqual([])
})

it('gathers typing into one change at most every 300 ms, front matter and all', async () => {
  const made = await open('---\nstatus: draft\n---\nStart\n')
  caretAfter(made, 'Start')
  const started = performance.now()
  for (let i = 0; i < 20; i++) {
    made.bridge.command('insertText', { text: String(i % 10) })
    await sleep(50)
  }
  await sleep(CHANGE_EVERY + 100)
  const changes = of(made.seen, 'change')
  const took = performance.now() - started
  expect(changes.length).toBeGreaterThan(1)
  expect(changes.length).toBeLessThanOrEqual(Math.ceil(took / CHANGE_EVERY))
  expect(changes[changes.length - 1].text).toBe('---\nstatus: draft\n---\nStart01234567890123456789\n')
})

it('runs every key of the bar on the selection, as the note page does', async () => {
  const cases: [string, Record<string, unknown> | undefined, string, string][] = [
    // command, args, the note, what it becomes (the word "here" chosen, or the caret after it)
    ['bold', undefined, 'Put here now\n', 'Put **here** now\n'],
    ['italic', undefined, 'Put here now\n', 'Put *here* now\n'],
    ['strike', undefined, 'Put here now\n', 'Put ~~here~~ now\n'],
    ['code', undefined, 'Put here now\n', 'Put `here` now\n'],
    ['wikilink', undefined, 'Put here now\n', 'Put [[here]] now\n'],
    ['tag', undefined, 'Put here now\n', 'Put #here now\n'],
    ['heading', { level: 2 }, 'Put here now\n', '## Put here now\n'],
    ['heading', { level: 5 }, 'Put here now\n', '##### Put here now\n'],
    ['heading', { level: 2 }, '## Put here now\n', 'Put here now\n'],
    ['bullet', undefined, 'Put here now\n', '- Put here now\n'],
    ['ordered', undefined, 'Put here now\n', '1. Put here now\n'],
    ['task', undefined, 'Put here now\n', '- [ ] Put here now\n'],
    ['quote', undefined, 'Put here now\n', '> Put here now\n'],
    ['callout', { kind: 'tip' }, 'Put here now\n', '> [!tip] Put here now\n'],
    ['indent', undefined, '- one\n- Put here now\n', '- one\n  - Put here now\n'],
    ['outdent', undefined, '- one\n  - Put here now\n', '- one\n- Put here now\n'],
    ['insertText', { text: 'there' }, 'Put here now\n', 'Put there now\n'],
  ]
  for (const [name, args, text, expected] of cases) {
    const made = await open(text)
    select(made, 'here')
    made.bridge.command(name, args)
    expect(await told(made), `${name} ${JSON.stringify(args ?? {})}`).toBe(expected)
  }
})

it('makes a table, a link, and takes back with undo and redo', async () => {
  const table = await open('Before\n')
  caretAfter(table, 'Before')
  table.bridge.command('table')
  expect(await told(table)).toMatch(/^Before\n\n\|.*\|\n\| -+ \| -+ \| -+ \|\n/)

  // A web link: its words go in, its address is asked in the editor's own box.
  const link = await open('Put here now\n')
  select(link, 'here')
  link.bridge.command('link')
  await link.bridge.settled()
  await expect.poll(() => link.host.querySelector('.milkdown-link-edit') ?? document.querySelector('.milkdown-link-edit')).toBeTruthy()

  const made = await open('Put here now\n')
  caretAfter(made, 'here')
  made.bridge.command('insertText', { text: ' more' })
  await made.bridge.settled()
  expect(of(made.seen, 'state').at(-1)).toMatchObject({ canUndo: true, canRedo: false })
  made.bridge.command('undo')
  expect(await told(made)).toBe('Put here now\n')
  expect(of(made.seen, 'state').at(-1)).toMatchObject({ canUndo: false, canRedo: true })
  made.bridge.command('redo')
  expect(await told(made)).toBe('Put here more now\n')
})

it('tells the keys what holds at the caret', async () => {
  const made = await open('## Title\n\nSome **bold** and *slanted* words.\n\n- one\n\n- [ ] task\n')
  const last = () => of(made.seen, 'state').at(-1)!
  caretAfter(made, 'Tit')
  expect(last()).toMatchObject({ heading: 2, bold: false, list: false, task: false })
  caretAfter(made, 'bo')
  expect(last()).toMatchObject({ heading: 0, bold: true, italic: false })
  caretAfter(made, 'slan')
  expect(last()).toMatchObject({ italic: true })
  caretAfter(made, 'on')
  expect(last()).toMatchObject({ list: true, task: false })
  caretAfter(made, 'tas')
  expect(last()).toMatchObject({ list: false, task: true })
})

it('asks the app for notes after [[ and for tags after #, and takes what it answers', async () => {
  const made = await open('Start\n')
  caretAfter(made, 'Start')
  made.bridge.command('insertText', { text: ' [[Com' })
  await made.bridge.settled()
  const asked = of(made.seen, 'suggest').find((message) => message.query === 'Com')!
  expect(asked).toMatchObject({ kind: 'wiki', query: 'Com' })
  made.bridge.answer(asked.id, [{ label: 'Compost', insert: 'Garden/Compost', detail: 'Garden' }, { nonsense: true }])
  await expect.poll(() => document.querySelector('.nx-suggest')?.textContent).toBe('CompostGarden')
  const view = made.bridge.current()!.view
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(await told(made)).toBe('Start [[Garden/Compost]]\n')

  made.bridge.command('insertText', { text: ' #gre' })
  await made.bridge.settled()
  const tag = of(made.seen, 'suggest').find((message) => message.kind === 'tag' && message.query === 'gre')!
  expect(tag).toBeTruthy()
  // Ids may come back as numbers.
  made.bridge.answer(Number(tag.id), [{ label: 'green', insert: 'green', detail: '3' }])
  await expect.poll(() => document.querySelector('.nx-suggest')?.textContent).toBe('green3')
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(await told(made)).toBe('Start [[Garden/Compost]] #green\n')
  // Each query is asked once.
  expect(of(made.seen, 'suggest').filter((message) => message.query === 'Com')).toHaveLength(1)
})

it('asks the app for the files a note shows and shows them from its answer', async () => {
  const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
  const made = await open('![Photo](Pictures/Bed%201.png)\n\n![[Leaf.png|200]]\n\n![[Plan.pdf#page=2]]\n\n![[Evil.pdf]]\n\n![Web](https://example.com/a.png)\n')
  const asks = of(made.seen, 'asset')
  expect(asks.map((message) => message.path).sort()).toEqual(['Evil.pdf', 'Leaf.png', 'Pictures/Bed 1.png', 'Plan.pdf'])
  const id = (path: string) => asks.find((message) => message.path === path)!.id
  made.bridge.answer(id('Pictures/Bed 1.png'), { url: dot })
  made.bridge.answer(id('Leaf.png'), { url: 'nexlore-asset://file/Garden/Leaf.png' })
  made.bridge.answer(id('Plan.pdf'), { url: 'nexlore-asset://file/Garden/Plan.pdf' })
  made.bridge.answer(id('Evil.pdf'), { url: 'javascript:alert(1)' })
  await expect.poll(() => made.host.querySelector('img[data-nx-src="Pictures/Bed%201.png"]')?.getAttribute('src')).toBe(dot)
  await expect.poll(() => made.host.querySelector('img.nx-embed-media')?.getAttribute('src')).toBe('nexlore-asset://file/Garden/Leaf.png')
  await expect.poll(() => [...made.host.querySelectorAll('iframe.nx-app-pdf')].map((frame) => frame.getAttribute('src'))).toEqual([
    'nexlore-asset://file/Garden/Plan.pdf#page=2',
  ])
  // An address elsewhere is shown as written, never asked of the app.
  expect(made.host.querySelector('img[data-nx-src="https://example.com/a.png"]')?.getAttribute('src')).toBe('https://example.com/a.png')
  await sleep(CHANGE_EVERY + 100)
  expect(of(made.seen, 'change')).toEqual([])
})

it('reads without writing, opens what is tapped, and writes again when told', async () => {
  const made = await open('See [[Compost]], [the site](https://example.com/) and #green.\n', { readOnly: true })
  const view = made.bridge.current()!.view
  expect(view.dom.getAttribute('contenteditable')).toBe('false')
  made.bridge.command('insertText', { text: 'nope' })
  made.bridge.command('bold')
  await made.bridge.settled()
  await sleep(CHANGE_EVERY + 100)
  expect(of(made.seen, 'change')).toEqual([])

  const press = (element: Element) => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    element.dispatchEvent(click)
    return click
  }
  press(made.host.querySelector('.nx-wiki')!)
  press(made.host.querySelector('.nx-tag')!)
  const away = press(made.host.querySelector('a[href]')!)
  // The web view never follows the link itself.
  expect(away.defaultPrevented).toBe(true)
  expect(of(made.seen, 'openLink')).toEqual([
    { type: 'openLink', target: 'Compost', kind: 'wiki' },
    { type: 'openLink', target: 'green', kind: 'tag' },
    { type: 'openLink', target: 'https://example.com/', kind: 'url' },
  ])

  made.bridge.setReadOnly(false)
  await made.bridge.settled()
  expect(view.dom.getAttribute('contenteditable')).toBe('true')
  caretAfter(made, 'green')
  made.bridge.command('insertText', { text: 'er' })
  expect(await told(made)).toBe('See [[Compost]], [the site](https://example.com/) and #greener.\n')
})

it('takes a text from outside without telling it back, the caret where it was', async () => {
  const made = await open('First line here.\n\nSecond.\n')
  caretAfter(made, 'First')
  made.bridge.command('insertText', { text: '!' })
  // The merged text comes before the typing was told (here even before it was done): the old typing is not told
  // over it.
  made.bridge.setText('---\nstatus: merged\n---\nFirst! line here.\n\nSecond, merged.\n')
  await made.bridge.settled()
  await sleep(CHANGE_EVERY + 100)
  expect(of(made.seen, 'change')).toEqual([])
  expect(made.host.querySelector('.ProseMirror')?.textContent).toContain('Second, merged.')
  await expect.poll(() => [...made.host.querySelectorAll<HTMLInputElement>('.nx-properties input')].map((field) => field.value)).toContain('merged')
  made.bridge.command('insertText', { text: '?' })
  expect(await told(made)).toBe('---\nstatus: merged\n---\nFirst!? line here.\n\nSecond, merged.\n')
})

it('loads another note with a fresh history and forgets the old one', async () => {
  const made = await open('Old note.\n')
  caretAfter(made, 'Old')
  made.bridge.command('insertText', { text: 'er' })
  made.bridge.load({ text: 'New note.\n' })
  await made.bridge.settled()
  await sleep(CHANGE_EVERY + 100)
  expect(of(made.seen, 'change')).toEqual([])
  expect(of(made.seen, 'state').at(-1)).toMatchObject({ canUndo: false })
  made.bridge.command('undo')
  made.bridge.command('insertText', { text: 'A ' })
  expect(await told(made)).toBe('A New note.\n')
})

it('takes the theme and says an unknown command is one', async () => {
  const made = await open('Text.\n')
  made.bridge.setTheme({ mode: 'light', accent: '#123456' })
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(document.documentElement.style.getPropertyValue('--color-accent-500')).toBe('#123456')
  made.bridge.command('explode')
  await made.bridge.settled()
  expect(of(made.seen, 'error')).toEqual([{ type: 'error', message: 'unknown command: explode' }])
})
