/**
 * The canvas (`.canvas`, JSON Canvas): cards of every kind shown, moved with snapping, a text card made and typed in
 * the editor of the note page, a note edited beside the canvas, a line drawn, a new canvas from the folder menu; the
 * file always written the way Obsidian writes a canvas.
 *
 * Each test makes a space of its own (a name per run: a deleted space keeps its name in the trash).
 */
import { type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { shownRow } from './tree'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-canvas00' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'makes spaces of its own')

/** A text card, a note, a section of it, a link, and a group around the first two; a line from the text to the note. */
function board(): string {
  const nodes = [
    { id: 'g000000000000001', type: 'group', x: -40, y: -60, width: 760, height: 360, label: 'Planung' },
    { id: 't000000000000001', type: 'text', text: '**Plan** for [[Material]]', x: 0, y: 0, width: 260, height: 120 },
    { id: 'n000000000000001', type: 'file', file: 'Material.md', x: 400, y: 0, width: 300, height: 220 },
    { id: 'n000000000000002', type: 'file', file: 'Material.md', subpath: '#Wood', x: 800, y: 0, width: 300, height: 160 },
    { id: 'l000000000000001', type: 'link', url: 'https://example.com/guide', x: 800, y: 260, width: 300, height: 90 },
  ]
  const edges = [{ id: 'e000000000000001', fromNode: 't000000000000001', fromSide: 'right', toNode: 'n000000000000001', toSide: 'left', label: 'Next', color: '1' }]
  const lines = (items: object[]) => items.map((item, index) => `\t\t${JSON.stringify(item)}${index < items.length - 1 ? ',' : ''}`).join('\n')
  return `{\n\t"nodes":[\n${lines(nodes)}\n\t],\n\t"edges":[\n${lines(edges)}\n\t]\n}`
}

async function makeSpace(request: APIRequestContext): Promise<string> {
  const name = `Canvas ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
  expect((await request.post('/api/spaces', { data: { name }, headers: TAB })).ok()).toBe(true)
  const note = await request.post('/api/notes', {
    data: { folder: name, title: 'Material', content: '# Material\n\nTimber and screws.\n\n## Wood\n\nLarch, 28 mm.\n' },
    headers: TAB,
  })
  expect(note.ok()).toBe(true)
  const made = await request.post('/api/canvases', { data: { folder: name, name: 'Shed' }, headers: TAB })
  expect(made.ok()).toBe(true)
  const empty = await made.json()
  const saved = await request.put('/api/canvas', { data: { path: empty.path, content: board(), base_hash: empty.hash }, headers: TAB })
  expect(saved.ok()).toBe(true)
  // The lock of the request's tab would keep the page from editing.
  await request.delete('/api/locks', { params: { path: empty.path }, headers: TAB })
  return name
}

async function onDisk(request: APIRequestContext, path: string): Promise<string> {
  return (await (await request.get('/api/canvas', { params: { path } })).json()).content
}

async function open(page: Page, space: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/file/${encodeURIComponent(space)}/Shed.canvas`)
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
}

async function saved(page: Page): Promise<void> {
  await expect(page.locator('header').getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
}

test('a canvas shows its cards, far out only their titles', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  const text = page.locator('.react-flow__node[data-id="t000000000000001"]')
  await expect(text.locator('strong')).toHaveText('Plan')
  await expect(text.locator('a.nn-wikilink')).toHaveText('Material')
  await expect(page.locator('.react-flow__node[data-id="n000000000000001"]')).toContainText('Timber and screws.')
  // A section of the note: only what stands under its heading.
  const section = page.locator('.react-flow__node[data-id="n000000000000002"]')
  await expect(section).toContainText('Larch, 28 mm.')
  await expect(section).not.toContainText('Timber')
  await expect(page.locator('.react-flow__node[data-id="l000000000000001"]')).toContainText('example.com')
  await expect(page.locator('.nl-group-label')).toHaveText('Planung')
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  // Far out: titles instead of text.
  // One step at a time: a click during the last one's animation would cut it short.
  const shown = page.getByRole('toolbar', { name: 'View' }).locator('[aria-live]')
  // The line's label stays readable on the way: never under 13 pixels on the screen.
  const label = page.locator('.nl-edge-label')
  // Its letters' size on the screen: on the canvas, times how much they are drawn larger or smaller.
  // Only while it is shown: far out it is hidden, and a step can end there between two looks (0 / 0 gave NaN).
  const labelPixels = () =>
    label.evaluate((element) => {
      const text = element.querySelector('text')!
      const drawn = text.getBBox().height
      return drawn > 0 && !element.closest('.nl-far') ? (parseFloat(getComputedStyle(text).fontSize) * text.getBoundingClientRect().height) / drawn : null
    })
  await expect(label).toHaveText('Next')
  // The line stops behind its label: in the middle of the label the label is on top, not the line.
  const onTop = await label.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.nl-edge-label') === element
  })
  expect(onTop).toBe(true)
  // Chosen, the red line shows it: wider and glowing, though it keeps its red.
  const line = page.locator('.react-flow__edge[data-id="e000000000000001"]')
  const looks = () => line.locator('.react-flow__edge-path').evaluate((path) => ({ width: getComputedStyle(path).strokeWidth, glow: getComputedStyle(path).filter }))
  expect(await looks()).toEqual({ width: '2px', glow: 'none' })
  const quarter = await line.locator('.react-flow__edge-path').evaluate((path: SVGPathElement) => {
    const p = path.getPointAtLength(path.getTotalLength() / 4)
    const m = path.getScreenCTM()!
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
  })
  await page.mouse.click(quarter.x, quarter.y)
  await expect(line).toHaveClass(/selected/)
  expect(await looks()).toMatchObject({ width: '3.5px' })
  expect((await looks()).glow).toContain('drop-shadow')
  await page.keyboard.press('Escape')
  const sizes: number[] = []
  // Up to 30 steps: on a slow machine a click still cuts the last step's animation short, and twelve short steps once
  // did not reach far out (CI, 06.10.2026).
  for (let step = 0; step < 30 && !(await page.locator('.nl-canvas.nl-far').count()); step++) {
    const size = await labelPixels()
    if (size !== null) sizes.push(size)
    const before = await shown.textContent()
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await expect(shown).not.toHaveText(before ?? '')
  }
  expect(sizes.length).toBeGreaterThan(1)
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12.9)
  await expect(page.locator('.nl-canvas')).toHaveClass(/nl-far/)
  await expect(page.locator('.react-flow__node[data-id="n000000000000001"] .nl-card')).toHaveAttribute('data-title', 'Material')
  expect(problems).toEqual([])
})

test('a card moved near another snaps to it, and the file stays as Obsidian writes it', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  await page.getByRole('button', { name: 'Show everything' }).click()
  const link = page.locator('.react-flow__node[data-id="l000000000000001"]')
  const box = (await link.boundingBox())!
  const section = (await page.locator('.react-flow__node[data-id="n000000000000002"]').boundingBox())!
  const zoom = Number((await page.locator('.nl-canvas').getAttribute('style'))!.match(/--nl-zoom:\s*([\d.]+)/)![1])
  // Picked up (React Flow starts the drag with the first step, which does not count), then brought up to 2 px of the
  // canvas below the section card's bottom (y 160), measured from where the card is now: it snaps onto 160.
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, box.y + box.height / 2 + 10, { steps: 3 })
  const now = (await link.boundingBox())!
  const goal = section.y + section.height + 2 * zoom
  await page.mouse.move(x, box.y + box.height / 2 + 10 + (goal - now.y), { steps: 10 })
  await expect(page.locator('.nl-guide')).not.toHaveCount(0)
  // On its way it is see-through, laid down it covers again.
  await expect(link).toHaveCSS('opacity', '0.55')
  await page.mouse.up()
  await expect(link).toHaveCSS('opacity', '1')
  await saved(page)
  const text = await onDisk(page.request, `${space}/Shed.canvas`)
  const card = JSON.parse(text).nodes.find((node: { id: string }) => node.id === 'l000000000000001')
  expect(card.y).toBe(160)
  expect(card.x).toBe(800)
  // One line changed, everything else as it was, in Obsidian's way of writing.
  const before = board().split('\n')
  const after = text.split('\n')
  expect(after.filter((line, index) => line !== before[index])).toHaveLength(1)
  expect(after.find((line) => line.includes('l000000000000001'))).toBe(
    '\t\t{"id":"l000000000000001","type":"link","url":"https://example.com/guide","x":800,"y":160,"width":300,"height":90}',
  )
  expect(problems).toEqual([])
})

test('a group carries the cards that lie in it, and only those', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  const label = (await page.locator('.nl-group-label').boundingBox())!
  const group = (await page.locator('.react-flow__node[data-id="g000000000000001"]').boundingBox())!
  // Taken by its frame, below its name (the cards lie inside, away from the edge).
  const x = group.x + 8
  const y = group.y + 8
  expect(label.y).toBeLessThan(y)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 40, { steps: 4 })
  await page.mouse.move(x, y + 140, { steps: 8 })
  await page.mouse.up()
  await saved(page)
  const nodes = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).nodes as { id: string; x: number; y: number }[]
  const at = Object.fromEntries(nodes.map((node) => [node.id, node]))
  const moved = at.g000000000000001.y - -60
  expect(moved).toBeGreaterThan(50)
  // The text and the note lay in the group: they went along; the section and the link lay outside: they stayed.
  expect(at.t000000000000001.y).toBe(0 + moved)
  expect(at.n000000000000001.y).toBe(0 + moved)
  expect(at.n000000000000002.y).toBe(0)
  expect(at.l000000000000001.y).toBe(260)
  // Chosen, a group is renamed from the bar above it (that bar lay under the canvas and took no click).
  const frame = (await page.locator('.react-flow__node[data-id="g000000000000001"]').boundingBox())!
  await page.mouse.click(frame.x + 8, frame.y + 8)
  await page.getByRole('toolbar', { name: 'Chosen cards' }).getByRole('button', { name: 'Rename' }).click()
  const naming = page.getByRole('dialog')
  await expect(naming).toBeVisible()
  await naming.getByLabel('Name of the group').fill('Bauen')
  await naming.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.nl-group-label')).toHaveText('Bauen')
  await saved(page)
  const renamed = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).nodes as { id: string; label?: string }[]
  expect(renamed.find((node) => node.id === 'g000000000000001')!.label).toBe('Bauen')
  expect(problems).toEqual([])
})

test('a double click makes a text card that is typed in the note editor; its bar stays the same size', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  // While a card is edited, the line from it stays where it starts (its points hidden, not taken away).
  const line = page.locator('.react-flow__edge path.react-flow__edge-path').first()
  const before = await line.getAttribute('d')
  await page.locator('.react-flow__node[data-id="t000000000000001"]').dblclick()
  await expect(page.locator('.react-flow__node[data-id="t000000000000001"] .ProseMirror')).toBeVisible()
  // Measured again when the editor comes (263 then 262.99993): the same place within a pixel, not the same text.
  const numbers = (path: string | null) => (path ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number)
  const during = numbers(await line.getAttribute('d'))
  expect(during).toHaveLength(numbers(before).length)
  numbers(before).forEach((value, index) => expect(Math.abs(during[index] - value)).toBeLessThan(1))
  await page.keyboard.press('Escape')
  const pane = page.locator('.react-flow__pane')
  const area = (await pane.boundingBox())!
  await page.mouse.dblclick(area.x + 120, area.y + area.height - 140)
  const editor = page.locator('.react-flow__node .nl-editing .ProseMirror')
  await expect(editor).toBeVisible()
  // A click low in the card, below the first line, still lands in the text (it fills the card).
  const card = (await page.locator('.react-flow__node .nl-editing').boundingBox())!
  await page.mouse.click(card.x + card.width / 2, card.y + card.height - 12)
  await expect(editor).toBeFocused()
  await page.keyboard.type('A new thought')
  // The caret shows where the next letter goes, and the words can be chosen.
  const looks = await editor.evaluate((element) => ({ caret: getComputedStyle(element).caretColor, select: getComputedStyle(element).userSelect }))
  expect(looks.caret).not.toBe('rgba(0, 0, 0, 0)')
  expect(looks.select).toBe('text')
  // Words chosen: the bar over them lies in the layer outside the canvas, at its own size.
  await page.keyboard.press('Shift+Home')
  const bar = page.locator('.nl-canvas-menus .milkdown-toolbar')
  await expect(bar).toBeVisible()
  expect((await bar.boundingBox())!.height).toBeGreaterThan(30)
  await page.keyboard.press('End')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await saved(page)
  const nodes = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).nodes as { type: string; text?: string }[]
  const texts = nodes.filter((node) => node.type === 'text').map((node) => node.text)
  expect(texts, JSON.stringify(texts)).toContain('A new thought')
  // Undo takes the card's text back as one step.
  await page.getByRole('button', { name: 'Undo' }).click()
  await saved(page)
  const back = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).nodes as { text?: string }[]
  expect(back.map((node) => node.text)).not.toContain('A new thought')
  expect(problems).toEqual([])
})

test('a note opens beside the canvas; what is typed there shows on its card', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  await page.locator('.react-flow__node[data-id="n000000000000001"]').dblclick()
  const panel = page.getByRole('complementary', { name: 'Note “Material” beside the canvas' })
  await expect(panel).toBeVisible()
  const text = panel.locator('.ProseMirror')
  await expect(text).toContainText('Timber and screws.')
  await text.getByText('Timber and screws.').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' And glue.')
  await expect(panel.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.react-flow__node[data-id="n000000000000001"]')).toContainText('And glue.')
  const note = await (await page.request.get('/api/note', { params: { path: `${space}/Material.md` } })).json()
  expect(note.content).toContain('Timber and screws. And glue.')
  expect(problems).toEqual([])
})

test('a line drawn from a side of one card to a side of another is written with both sides', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  const from = page.locator('.react-flow__node[data-id="n000000000000002"]')
  const to = page.locator('.react-flow__node[data-id="l000000000000001"]')
  await from.hover()
  const handle = (await from.locator('.react-flow__handle-bottom').boundingBox())!
  await to.hover()
  // Let go on the point at the bottom: the line ends there, at the bottom (that point was chosen).
  const target = (await to.locator('.react-flow__handle-bottom').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 })
  await page.mouse.up()
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  // Let go on the card, on no point, low near its left: it ends at the side nearest the pointer, the bottom (the side
  // facing its start would be the left).
  const text = page.locator('.react-flow__node[data-id="t000000000000001"]')
  await text.hover()
  const right = (await text.locator('.react-flow__handle-right').boundingBox())!
  const middle = (await page.locator('.react-flow__node[data-id="l000000000000001"]').boundingBox())!
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2)
  await page.mouse.down()
  await page.mouse.move(middle.x + 30, middle.y + middle.height / 2 + 20, { steps: 15 })
  await page.mouse.up()
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  // Lines go around the cards in their way, at right angles with round corners: none runs over a card (groups are
  // no card in the way; lines run into them).
  const across = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.react-flow__node:not(.react-flow__node-frame)')].map((node) => node.getBoundingClientRect())
    const paths = [...document.querySelectorAll<SVGPathElement>('.react-flow__edge-path')]
    let points = 0
    let onCards = 0
    for (const path of paths) {
      const length = path.getTotalLength()
      const m = path.getScreenCTM()
      if (!m) continue
      for (let step = 1; step < 40; step++) {
        const p = path.getPointAtLength((length * step) / 40)
        const x = m.a * p.x + m.c * p.y + m.e
        const y = m.b * p.x + m.d * p.y + m.f
        points++
        if (cards.some((r) => x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2)) onCards++
      }
    }
    return { points, onCards, corners: paths.filter((path) => path.getAttribute('d')?.includes(' Q ')).length }
  })
  expect(across.points).toBeGreaterThan(0)
  expect(across.corners).toBeGreaterThan(0)
  expect(across.onCards).toBe(0)
  await saved(page)
  const edges = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).edges as Record<string, string>[]
  const drawn = edges.find((edge) => edge.fromNode === 'n000000000000002')!
  expect(drawn).toMatchObject({ fromSide: 'bottom', toNode: 'l000000000000001', toSide: 'bottom' })
  expect(Object.keys(drawn)).toEqual(['id', 'fromNode', 'fromSide', 'toNode', 'toSide'])
  const loose = edges.find((edge) => edge.fromNode === 't000000000000001' && edge.toNode === 'l000000000000001')!
  expect(loose).toMatchObject({ fromSide: 'right', toSide: 'bottom' })
  expect(problems).toEqual([])
})

test('Ctrl+A chooses every card, also before anything on the canvas was clicked, and never the text of the page', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  // Nothing clicked yet: the keys go to the page itself.
  await page.keyboard.press('Control+a')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5)
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).toBe('')
  await page.keyboard.press('Escape')
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a card taken off with the Delete key takes its line along, and one step back brings both', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await page.locator('.react-flow__node[data-id="n000000000000001"] .nl-card-head').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  // One step back: the card and its line (they were two steps, and the line stayed away).
  await page.keyboard.press('Control+z')
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await saved(page)
  expect(JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).edges).toHaveLength(1)
  // And one step forward takes both off again.
  await page.keyboard.press('Control+Shift+z')
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  await expect(page.locator('.react-flow__edge')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a note dragged from the sidebar onto the canvas lies there as a card', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await open(page, space)
  // The sidebar opens the canvas's folder; the note beside it is dragged in (the browser's own drag and drop).
  const note = page.getByTestId('sidebar-tree').locator(`li[data-path="${space}/Material.md"] > button`)
  await expect(note).toBeVisible()
  const pane = (await page.locator('.react-flow__pane').boundingBox())!
  await note.dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 160, y: pane.height - 120 } })
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  await saved(page)
  const nodes = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).nodes as { id: string; type: string; file?: string }[]
  const known = new Set(['g000000000000001', 't000000000000001', 'n000000000000001', 'n000000000000002', 'l000000000000001'])
  const added = nodes.filter((node) => !known.has(node.id))
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ type: 'file', file: 'Material.md' })
  expect(problems).toEqual([])
})

test('a note from another space lies on the canvas with that space in front, and opens beside it', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  const other = await makeSpace(page.request)
  await open(page, space)
  // The tree draws only rows near the view, and other tests add spaces: whether the space is open is asked of its own
  // row (a row not drawn is not a folded space), then the tree is scrolled to the note.
  const tree = page.getByTestId('sidebar-tree')
  const note = tree.locator(`li[data-path="${other}/Material.md"] > button`)
  const fold = async (open: boolean) => {
    await tree.evaluate((element) => element.scrollTo(0, 0))
    const button = await shownRow(page, other)
    if ((await button.getAttribute('aria-expanded')) !== String(open)) await button.click()
    await expect(button).toHaveAttribute('aria-expanded', String(open))
  }
  await fold(true)
  for (let step = 0; step < 40 && !(await note.isVisible()); step++) {
    await tree.evaluate((element) => element.scrollBy(0, element.clientHeight / 3))
    await page.waitForTimeout(50)
  }
  await expect(note).toBeVisible()
  const pane = (await page.locator('.react-flow__pane').boundingBox())!
  await note.dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 160, y: pane.height - 120 } })
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  // At once, before the server knows it: the other space's note, beside this space's own of the same name.
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Timber and screws.' })).toHaveCount(2)
  const known = new Set(['g000000000000001', 't000000000000001', 'n000000000000001', 'n000000000000002', 'l000000000000001'])
  await saved(page)
  const nodes = JSON.parse(await onDisk(page.request, `${space}/Shed.canvas`)).nodes as { id: string; type: string; file?: string }[]
  const added = nodes.filter((node) => !known.has(node.id))
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ type: 'file', file: `${other}/Material.md` })
  // Loaded again, the server says where it leads: the other space's note, which opens beside the canvas.
  await page.reload()
  const card = page.locator(`.react-flow__node[data-id="${added[0].id}"]`)
  await expect(card).toContainText('Timber and screws.')
  // It says which space it comes from; this space's own card does not.
  await expect(card.locator('.nl-card-space')).toHaveText(other)
  await expect(page.locator('.react-flow__node[data-id="n000000000000001"] .nl-card-space')).toHaveCount(0)
  await card.dblclick()
  await expect(page.getByRole('complementary', { name: 'Note “Material” beside the canvas' })).toBeVisible()
  await page.keyboard.press('Escape')
  // Looked for by name, it is found in the other space too, which its line names.
  await page.getByRole('toolbar', { name: 'Add to the canvas' }).getByRole('button', { name: /^Note/ }).click()
  const picker = page.getByRole('dialog', { name: 'Find a note to lay on the canvas' })
  await picker.getByRole('textbox').fill('Material')
  await expect(picker.getByRole('option').filter({ hasText: other })).toHaveCount(1)
  await page.keyboard.press('Escape')
  // Shown in the sidebar from the card: its space folded first, then opened down to it, the row in view and focused.
  await fold(false)
  await expect(note).toHaveCount(0)
  await card.locator('.nl-card-head').click()
  await page.getByRole('toolbar', { name: 'Chosen cards' }).getByRole('button', { name: 'Show in the sidebar' }).click()
  await expect(note).toBeFocused()
  expect(problems).toEqual([])
})

test('before a note goes to the trash, its dialogs name the canvases it lies on', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  // From the sidebar.
  await open(page, space)
  await page.getByTestId('sidebar-tree').locator(`li[data-path="${space}/Material.md"] > button`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  const dialog = page.getByRole('dialog', { name: /to the trash/ })
  await expect(dialog.getByTestId('canvas-warning')).toContainText('„Shed“')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  // From the note's own page.
  await page.goto(`/note/${encodeURIComponent(space)}/Material.md`)
  await expect(page.locator('article')).toContainText('Timber and screws.')
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: /Move to trash/ }).click()
  await expect(page.getByRole('dialog', { name: /to the trash/ }).getByTestId('canvas-warning')).toContainText('„Shed“')
  expect(problems).toEqual([])
})

test('a line that finds no way, its cards lying on each other, runs under the cards', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  const now = await (await page.request.get('/api/canvas', { params: { path: `${space}/Shed.canvas` } })).json()
  const lying = [
    '{\n\t"nodes":[',
    '\t\t{"id":"a000000000000001","type":"text","text":"Under","x":0,"y":0,"width":300,"height":200},',
    '\t\t{"id":"b000000000000001","type":"text","text":"Over","x":200,"y":60,"width":300,"height":200}',
    '\t],\n\t"edges":[',
    '\t\t{"id":"e000000000000009","fromNode":"a000000000000001","fromSide":"right","toNode":"b000000000000001","toSide":"right","label":"Hidden"}',
    '\t]\n}',
  ].join('\n')
  const put = await page.request.put('/api/canvas', { data: { path: `${space}/Shed.canvas`, content: lying, base_hash: now.hash }, headers: TAB })
  expect(put.ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path: `${space}/Shed.canvas` }, headers: TAB })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/file/${encodeURIComponent(space)}/Shed.canvas`)
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  // Where the curve crosses the card on top, the card is what is there.
  const over = await page.evaluate(() => {
    const card = document.querySelector('.react-flow__node[data-id="b000000000000001"]')!.getBoundingClientRect()
    const path = document.querySelector<SVGPathElement>('.react-flow__edge-path')!
    const m = path.getScreenCTM()!
    let inside = 0
    let cardOnTop = 0
    for (let step = 1; step < 40; step++) {
      const p = path.getPointAtLength((path.getTotalLength() * step) / 40)
      const x = m.a * p.x + m.c * p.y + m.e
      const y = m.b * p.x + m.d * p.y + m.f
      if (x <= card.left + 4 || x >= card.right - 4 || y <= card.top + 4 || y >= card.bottom - 4) continue
      inside++
      if (document.elementFromPoint(x, y)?.closest('.react-flow__node')) cardOnTop++
    }
    return { inside, cardOnTop }
  })
  expect(over.inside).toBeGreaterThan(0)
  expect(over.cardOnTop).toBe(over.inside)
  // Its label goes with it: where it lies on the card, the card is on top.
  const label = await page.evaluate(() => {
    const card = document.querySelector('.react-flow__node[data-id="b000000000000001"]')!.getBoundingClientRect()
    const box = document.querySelector('.nl-edge-label')!.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const element = document.querySelector('.nl-edge-label')!
    return {
      onCard: x > card.left && x < card.right && y > card.top && y < card.bottom,
      top: !!document.elementFromPoint(x, y)?.closest('.react-flow__node'),
      // Drawn in its line's own layer (a label in a layer of its own above everything showed on the card even so,
      // and took no clicks, so the point above looked right).
      withLine: element.closest('.react-flow__edge')?.getAttribute('data-id') ?? null,
    }
  })
  expect(label).toEqual({ onCard: true, top: true, withLine: 'e000000000000009' })
  expect(problems).toEqual([])
})

test.describe('a card in a space whoever looks may not read', () => {
  // The answer about the cards is changed on its way; the service worker would keep it from the page's routes.
  test.use({ serviceWorkers: 'block' })

  test('is shown locked, with its name and nothing of what it holds, and opens nothing', async ({ page }) => {
    const problems = collectProblems(page)
    const space = await makeSpace(page.request)
    await page.route(
      (url) => url.pathname === '/api/canvas',
      async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        await route.fulfill({ response, json: { ...body, cards: { ...body.cards, 'Material.md': null }, locked: ['Material.md'] } })
      },
    )
    await open(page, space)
    const card = page.locator('.react-flow__node[data-id="n000000000000001"]')
    await expect(card.locator('[data-locked]')).toBeVisible()
    await expect(card).toContainText('Material')
    await expect(card).toContainText('No access to this space.')
    await expect(card).not.toContainText('Timber')
    await card.dblclick()
    await expect(page.getByRole('complementary', { name: /beside the canvas/ })).toHaveCount(0)
    // The others are as they were.
    await expect(page.locator('.react-flow__node[data-id="t000000000000001"] strong')).toHaveText('Plan')
    expect(problems).toEqual([])
  })
})

test('a note names the canvas it lies on among its backlinks, and the canvas opens from there', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/note/${encodeURIComponent(space)}/Material.md`)
  const back = page.getByTestId('note-panel').locator('section').filter({ has: page.getByRole('heading', { name: /Backlinks/ }) })
  const canvas = back.getByRole('button', { name: /Shed/ })
  await expect(canvas).toContainText('Canvas')
  await expect(canvas).not.toContainText('.canvas')
  await canvas.click()
  await expect(page).toHaveURL(/\/Shed\.canvas$/)
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  expect(problems).toEqual([])
})

test('an older version of a canvas comes back from its header', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  const path = `${space}/Shed.canvas`
  // A second state, saved from another tab (the saves of one tab fold into one version).
  const other = { 'X-Nexlore-Client': 'tab-e2e-canvas01' }
  const now = await (await page.request.get('/api/canvas', { params: { path } })).json()
  const changed = now.content.replace('"label":"Planung"', '"label":"Changed"')
  expect((await page.request.put('/api/canvas', { data: { path, content: changed, base_hash: now.hash }, headers: other })).ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path }, headers: other })
  await open(page, space)
  await expect(page.locator('.nl-group-label')).toHaveText('Changed')
  await page.getByRole('button', { name: 'Versions' }).click()
  const list = page.getByRole('dialog', { name: 'Versions' })
  await list.getByRole('button', { name: 'Restore this' }).first().click()
  await page.getByRole('dialog', { name: 'Bring back this version?' }).getByRole('button', { name: 'Restore this' }).click()
  await expect(page.locator('.nl-group-label')).toHaveText('Planung')
  expect(await onDisk(page.request, path)).toBe(board())
  expect(problems).toEqual([])
})

test('a new canvas comes from the menu of a folder, empty and as Obsidian writes one', async ({ page }) => {
  const problems = collectProblems(page)
  const space = await makeSpace(page.request)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/file/${encodeURIComponent(space)}/Shed.canvas`)
  const tree = page.getByTestId('sidebar-tree')
  await tree.getByRole('button', { name: new RegExp(`^${space}( \\d+)?$`) }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New canvas …' }).click()
  await page.getByTestId('name-dialog').getByRole('textbox').fill('Ideas')
  await page.getByTestId('name-dialog').getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/Ideas\.canvas$/)
  await expect(page.locator('.react-flow__pane')).toBeVisible()
  await expect(tree.getByRole('button', { name: 'Ideas' })).toBeVisible()
  expect(await onDisk(page.request, `${space}/Ideas.canvas`)).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}')
  // Among the favorites it is named and drawn as in the tree: no ".canvas", the canvas symbol.
  await tree.getByRole('button', { name: 'Ideas' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click()
  const favorite = page.getByTestId('sidebar-favorites').locator(`[data-favorite="${space}/Ideas.canvas"] button`)
  await expect(favorite).toHaveText('Ideas')
  await expect(favorite.locator('svg')).toHaveAttribute('data-symbol', 'canvas')
  await favorite.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove from favorites' }).click()
  await expect(favorite).toHaveCount(0)
  expect(problems).toEqual([])
})
