/**
 * The Kanban plugin of the catalog, run as it is shipped, with a stand-in for the page's side: moving and adding a
 * card write the lanes it touches the way the Obsidian Kanban plugin writes them, and a board that plugin wrote
 * changes in the card's lines alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// Read from the disk: the file lies outside what Vite may serve, and the app's types know nothing of Node.
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync: (file: string, encoding: string) => string }
const here = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd()
const CODE = fs.readFileSync(`${here}/../backend/app/catalog/kanban/main.js`, 'utf-8')

async function board(content: string): Promise<{ written: string[]; root: HTMLElement }> {
  const written: string[] = []
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('nexlore', {
    ready: (callback: () => void) => callback(),
    on: () => undefined,
    t: (key: string) => key,
    ask: async (what: string, value?: { content: string }) => {
      if (what === 'note.read') return { content, hash: 'h1' }
      written.push(value!.content)
      return { saved: true, conflict: null }
    },
  })
  new Function(CODE)()
  await vi.waitFor(() => expect(document.querySelector('.lane')).not.toBeNull())
  return { written, root: document.getElementById('board')! }
}

function lane(root: HTMLElement, title: string): HTMLElement {
  return [...root.querySelectorAll<HTMLElement>('.lane')].find((item) => item.querySelector('h3')!.textContent!.startsWith(title))!
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// As the Obsidian Kanban plugin writes it (laneToMd, boardToMd): one blank line under a heading, two after the last
// card, three under an empty lane.
const PLUGIN_BOARD =
  '---\n\nkanban-plugin: basic\n\n---\n\n' +
  '## Todo\n\n- [ ] Dig\n- [ ] Plant\n\n\n' +
  '## Doing\n\n\n\n' +
  '## Done\n\n**Complete**\n- [x] Buy seeds\n\n\n\n\n' +
  '%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%'

describe('the Kanban board', () => {
  it('writes the lanes a move touches as the Kanban plugin does', async () => {
    const { written, root } = await board('---\nkanban-plugin: basic\n---\n\n## Todo\n\n- [ ] Dig the bed\n\n## Done\n\n- [x] Buy seeds\n')
    lane(root, 'Todo').querySelector<HTMLButtonElement>('button[aria-label="right"]')!.click()
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toBe('---\nkanban-plugin: basic\n---\n\n## Todo\n\n\n\n## Done\n\n- [x] Buy seeds\n- [ ] Dig the bed\n')
  })

  it('changes a board the plugin wrote only in the lines of the card', async () => {
    const { written, root } = await board(PLUGIN_BOARD)
    lane(root, 'Todo').querySelectorAll<HTMLButtonElement>('button[aria-label="right"]')[0].click()
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toBe(PLUGIN_BOARD.replace('- [ ] Dig\n- [ ] Plant', '- [ ] Plant').replace('## Doing\n\n\n\n', '## Doing\n\n- [ ] Dig\n\n\n'))
  })

  it('moves a card into the lane before the settings, keeping the blank lines the settings stand after', async () => {
    const before = PLUGIN_BOARD.replace('## Doing\n\n\n\n', '## Doing\n\n- [ ] Water\n\n\n')
    const { written, root } = await board(before)
    lane(root, 'Doing').querySelector<HTMLButtonElement>('button[aria-label="right"]')!.click()
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toBe(PLUGIN_BOARD.replace('- [x] Buy seeds\n', '- [x] Buy seeds\n- [ ] Water\n'))
  })

  it('adds a card below the plugin’s Complete line of an empty lane, and after the last card elsewhere', async () => {
    const first = await board('## A\n\n**Complete**\n\n## B\n\n- [ ] one\n\n## C\n')
    const input = lane(first.root, 'A').querySelector('input:not([type])') as HTMLInputElement
    input.value = 'new'
    input.form!.requestSubmit()
    await vi.waitFor(() => expect(first.written).toHaveLength(1))
    expect(first.written[0]).toBe('## A\n\n**Complete**\n- [ ] new\n\n\n## B\n\n- [ ] one\n\n## C\n')

    const second = await board('## A\n\n- [ ] one\n  more of one\n\n## B\n')
    const more = lane(second.root, 'A').querySelector('input:not([type])') as HTMLInputElement
    more.value = 'two'
    more.form!.requestSubmit()
    await vi.waitFor(() => expect(second.written).toHaveLength(1))
    expect(second.written[0]).toBe('## A\n\n- [ ] one\n  more of one\n- [ ] two\n\n\n## B\n')
  })

  it('keeps the line ends and the lines at the end of the file, and ticks off by one line', async () => {
    const { written, root } = await board('## A\r\n\r\n- [ ] one\r\n\r\n## B\r\n\r\n- [ ] two\r\n')
    lane(root, 'A').querySelector<HTMLButtonElement>('button[aria-label="right"]')!.click()
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toBe('## A\r\n\r\n\r\n\r\n## B\r\n\r\n- [ ] two\r\n- [ ] one\r\n')

    const ticked = await board('## A\n\n- [ ] one\n\n\n\n## B\n')
    lane(ticked.root, 'A').querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await vi.waitFor(() => expect(ticked.written).toHaveLength(1))
    expect(ticked.written[0]).toBe('## A\n\n- [x] one\n\n\n\n## B\n')
  })
})
