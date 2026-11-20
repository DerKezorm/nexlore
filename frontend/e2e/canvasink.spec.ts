/**
 * The canvas as a page to write on: the pen draws over every card into the canvas's own drawing (a file card marked
 * `nexloreInk`, its box the strokes' box, made with the first stroke) and stays after a reload; strokes written on a
 * picture go along when the picture is moved; a PDF dropped from the desktop shows its pages, the card as tall as
 * they are; a picture pasted with Ctrl V lands in its own shape. Each test makes a space of its own.
 */
import { type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'makes spaces of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-cvink000' }

type Node = { id: string; type: string; file?: string; x: number; y: number; width: number; height: number; nexloreInk?: boolean }
type Stroke = { pts: [number, number, number][] }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

/** A space with an empty canvas `Board` in it. */
async function makeBoard(request: APIRequestContext): Promise<{ space: string; path: string }> {
  const space = `Pen ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
  expect((await request.post('/api/spaces', { data: { name: space }, headers: TAB })).ok()).toBe(true)
  const made = await request.post('/api/canvases', { data: { folder: space, name: 'Board' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return { space, path: (await made.json()).path }
}

async function canvasOnDisk(request: APIRequestContext, path: string): Promise<{ nodes: Node[]; edges: unknown[] }> {
  const text = (await (await request.get('/api/canvas', { params: { path } })).json()).content as string
  return text.trim() ? JSON.parse(text) : { nodes: [], edges: [] }
}

async function strokesOnDisk(request: APIRequestContext, path: string): Promise<Stroke[]> {
  return (await (await request.get('/api/ink', { params: { path } })).json()).ink.strokes
}

async function open(page: Page, space: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/file/${encodeURIComponent(space)}/Board.canvas`)
  await expect(page.locator('.react-flow')).toBeVisible()
}

/** A stroke dragged with the mouse, in pixels of the page. */
async function stroke(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...from)
  await page.mouse.down()
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * step) / 12, from[1] + ((to[1] - from[1]) * step) / 12)
  }
  await page.mouse.up()
}

/** A PDF of `count` pages, each 300 x 200 points with a line of text, as small as a PDF can be. */
function pdfOf(count: number): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  const kids: string[] = []
  for (let page = 0; page < count; page++) {
    const pageId = 3 + page * 2
    kids.push(`${pageId} 0 R`)
    const stream = `BT /F1 18 Tf 20 100 Td (Page ${page + 1}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${3 + count * 2} 0 R >> >> >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const start = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** The box the server writes as the SVG's `viewBox`, and its size. */
async function svgBox(request: APIRequestContext, path: string): Promise<number[]> {
  const svg = await (await request.get('/api/file', { params: { path } })).text()
  const root = /<svg [^>]*viewBox="([-\d. ]+)" width="(\d+)" height="(\d+)"/.exec(svg)
  expect(root).not.toBeNull()
  return [...root![1].split(' ').map(Number), Number(root![2]), Number(root![3])]
}

test('the pen draws over the canvas into a layer of its own, a picture for any other program, there after a reload', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  await open(page, space)

  await page.locator('[data-dock="pen"]').click()
  await expect(page.locator('[data-dock="pen"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('ink-toolbar')).toBeVisible()
  // No paper over a canvas: it would cover the cards.
  await expect(page.locator('[data-ink-tool="paper"]')).toHaveCount(0)
  const made = page.waitForResponse((response) => response.url().endsWith('/api/inks') && response.request().method() === 'POST')
  await stroke(page, [500, 300], [800, 450])
  const { path: drawing } = await (await made).json()
  expect(drawing).toBe(`${space}/Attachments/Board 1.svg`)
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(1)

  // On the disk: the drawing with its stroke, and the canvas with a card marked as the layer, as JSON Canvas wants it.
  await expect.poll(async () => (await strokesOnDisk(page.request, drawing)).length, { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await canvasOnDisk(page.request, path)).nodes.length, { timeout: 15_000 }).toBe(1)
  // A second stroke grows the box.
  await stroke(page, [300, 600], [350, 650])
  await expect.poll(async () => (await strokesOnDisk(page.request, drawing)).length, { timeout: 15_000 }).toBe(2)
  const box = await svgBox(page.request, drawing)
  await expect
    .poll(async () => {
      const layer = (await canvasOnDisk(page.request, path)).nodes[0]
      return [layer.x, layer.y, layer.width, layer.height, layer.width, layer.height]
    }, { timeout: 15_000 })
    .toEqual(box)
  const canvas = await canvasOnDisk(page.request, path)
  const layer = canvas.nodes[0]
  // What Obsidian reads: a file card on a picture that is there, every number whole, the mark an extra field.
  expect(layer).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), type: 'file', file: 'Attachments/Board 1.svg', x: box[0], y: box[1], width: box[2], height: box[3], nexloreInk: true })
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Number.isInteger(layer[key])).toBe(true)
  expect((await page.request.get('/api/file', { params: { path: drawing } })).headers()['content-type']).toContain('image/svg+xml')
  // Every stroke inside the card's box: Obsidian shows them where they were drawn.
  for (const line of await strokesOnDisk(page.request, drawing)) {
    for (const [x, y] of line.pts) {
      expect(x).toBeGreaterThan(layer.x)
      expect(y).toBeGreaterThan(layer.y)
      expect(x).toBeLessThan(layer.x + layer.width)
      expect(y).toBeLessThan(layer.y + layer.height)
    }
  }

  // Escape ends the pen: pointers go through to the canvas again.
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-dock="pen"]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.nl-pen-layer')).toHaveAttribute('data-pen', 'off')

  // After a reload: the strokes over the canvas, the layer no card of its own.
  await page.reload()
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(2)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  // A double click on the empty canvas makes a text card: the layer above lets it through.
  await page.mouse.dblclick(1100, 200)
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await page.keyboard.press('Escape')
  // The new card lies below the layer in the file (whoever shows the layer as a picture draws it on top).
  await expect.poll(async () => (await canvasOnDisk(page.request, path)).nodes.map((node) => node.nexloreInk === true), { timeout: 15_000 }).toEqual([false, true])
  expect(problems).toEqual([])
})

test('strokes written on a picture go along when it is moved; others stay', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  // A picture on the canvas, and a layer with a stroke on it and one beside it.
  const picture = await page.request.post('/api/attachments', {
    params: { name: 'plan.png', canvas: path },
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mN8ViHCQAgwMRABhrciALQ1AYLyZG5iAAAAAElFTkSuQmCC', 'base64'),
    headers: TAB,
  })
  expect(picture.status()).toBe(201)
  expect((await picture.json()).path).toBe(`${space}/Attachments/plan.png`)
  const drawing = (await (await page.request.post('/api/inks', { data: { canvas: path }, headers: TAB })).json()).path
  const empty = await (await page.request.get('/api/ink', { params: { path: drawing } })).json()
  const on = { tool: 'pen', color: 'ink', size: 4, pts: [[60, 60, 0.5], [200, 140, 0.5]] }
  const beside = { tool: 'pen', color: 'ink', size: 4, pts: [[500, 60, 0.5], [600, 140, 0.5]] }
  const ink = await page.request.put('/api/ink', { data: { path: drawing, ink: { v: 1, bg: 'none', strokes: [on, beside] }, base_hash: empty.hash }, headers: TAB })
  expect(ink.ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path: drawing }, headers: TAB })
  const box = await svgBox(page.request, drawing)
  const content = JSON.stringify({
    nodes: [
      { id: 'a000000000000001', type: 'file', file: 'Attachments/plan.png', x: 0, y: 0, width: 300, height: 200 },
      { id: 'b000000000000001', type: 'file', file: 'Attachments/Board 1.svg', x: box[0], y: box[1], width: box[2], height: box[3], nexloreInk: true },
    ],
    edges: [],
  })
  const state = await (await page.request.get('/api/canvas', { params: { path } })).json()
  expect((await page.request.put('/api/canvas', { data: { path, content, base_hash: state.hash }, headers: TAB })).ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path }, headers: TAB })

  await open(page, space)
  const card = page.locator('.react-flow__node[data-id="a000000000000001"]')
  await expect(card).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(2)
  const at = (await card.boundingBox())!
  await stroke(page, [at.x + at.width / 2, at.y + at.height / 2], [at.x + at.width / 2 + 260, at.y + at.height / 2 + 140])

  // The picture moved on the disk, the stroke on it by as much, the other where it was; the layer's box with them.
  await expect
    .poll(async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'a000000000000001')!.x, { timeout: 15_000 })
    .not.toBe(0)
  const moved = (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'a000000000000001')!
  await expect.poll(async () => (await strokesOnDisk(page.request, drawing))[0].pts[0], { timeout: 15_000 }).toEqual([60 + moved.x, 60 + moved.y, 0.5])
  const strokes = await strokesOnDisk(page.request, drawing)
  expect(strokes[0].pts[1]).toEqual([200 + moved.x, 140 + moved.y, 0.5])
  expect(strokes[1].pts).toEqual(beside.pts)

  // A step back takes the picture and the strokes on it back together; a step forth moves both again.
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'a000000000000001')!.x, { timeout: 15_000 }).toBe(0)
  await expect.poll(async () => (await strokesOnDisk(page.request, drawing))[0].pts, { timeout: 15_000 }).toEqual(on.pts)
  expect((await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'a000000000000001')!.x).toBe(0)
  expect((await strokesOnDisk(page.request, drawing))[1].pts).toEqual(beside.pts)
  await page.keyboard.press('Control+Shift+z')
  await expect
    .poll(async () => (await strokesOnDisk(page.request, drawing))[0].pts[0], { timeout: 15_000 })
    .toEqual([60 + moved.x, 60 + moved.y, 0.5])
  expect((await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'a000000000000001')!.x).toBe(moved.x)
  const now = await svgBox(page.request, drawing)
  await expect
    .poll(async () => {
      const layer = (await canvasOnDisk(page.request, path)).nodes.find((node) => node.nexloreInk)!
      return [layer.x, layer.y, layer.width, layer.height]
    }, { timeout: 15_000 })
    .toEqual(now.slice(0, 4))
  expect(problems).toEqual([])
})

test('a PDF dropped from the desktop lands beside the canvas and shows all its pages, the card as tall as they are', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  await open(page, space)
  const base64 = pdfOf(3).toString('base64')
  await page.locator('.nl-canvas').evaluate((element, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], 'Three pages.pdf', { type: 'application/pdf' }))
    const box = element.getBoundingClientRect()
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.left + 400, clientY: box.top + 200 }))
  }, base64)
  const card = page.locator(`[data-pdf-card="${space}/Attachments/Three pages.pdf"]`)
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-pages', '3')
  await expect(page.frameLocator('[data-testid="pdf-pages"]').locator('#strip canvas')).toHaveCount(3)
  // Three landscape pages at the card's width: the card grew from a page of A4 to all three, and keeps that.
  await expect
    .poll(async () => (await canvasOnDisk(page.request, path)).nodes[0]?.height ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(3 * 280)
  const node = (await canvasOnDisk(page.request, path)).nodes[0]
  expect(node).toMatchObject({ type: 'file', file: 'Attachments/Three pages.pdf', width: 420 })
  // Nothing to scroll inside: the frame is as tall as the strip.
  const frameHeight = (await page.getByTestId('pdf-pages').boundingBox())!.height
  const stripHeight = await page.frameLocator('[data-testid="pdf-pages"]').locator('#strip').evaluate((element) => element.getBoundingClientRect().height)
  expect(Math.abs(frameHeight - stripHeight)).toBeLessThan(4)
  // A double click opens the reader, as before.
  await card.dblclick()
  await expect(page).toHaveURL(/Three%20pages\.pdf|Three pages\.pdf/)
  expect(problems).toEqual([])
})

test('Ctrl V of a picture lays it on the canvas in its own shape, named after the canvas', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  await open(page, space)
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 300 } })
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 400
    canvas.height = 200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#3b82f6'
    context.fillRect(0, 0, 400, 200)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!), 'image/png'))
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.react-flow__node img')).toBeVisible()
  await expect
    .poll(async () => (await canvasOnDisk(page.request, path)).nodes, { timeout: 15_000 })
    .toEqual([expect.objectContaining({ type: 'file', file: 'Attachments/Board 1.png', width: 400, height: 200 })])
  expect(problems).toEqual([])
})

test('a PDF folds to its first page: what is written on the others goes out of sight, moves along, and comes back', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  const pdf = await page.request.post('/api/attachments', { params: { name: 'Three.pdf', canvas: path }, data: pdfOf(3), headers: TAB })
  expect(pdf.status()).toBe(201)
  const drawing = (await (await page.request.post('/api/inks', { data: { canvas: path }, headers: TAB })).json()).path
  const empty = await (await page.request.get('/api/ink', { params: { path: drawing } })).json()
  const first = { tool: 'pen', color: 'ink', size: 4, pts: [[40, 80, 0.5], [200, 120, 0.5]] }
  const third = { tool: 'pen', color: '#e5484d', size: 4, pts: [[40, 760, 0.5], [200, 800, 0.5]] }
  const ink = await page.request.put('/api/ink', { data: { path: drawing, ink: { v: 1, bg: 'none', strokes: [first, third] }, base_hash: empty.hash }, headers: TAB })
  expect(ink.ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path: drawing }, headers: TAB })
  const box = await svgBox(page.request, drawing)
  const content = JSON.stringify({
    nodes: [
      { id: 'c000000000000001', type: 'file', file: 'Attachments/Three.pdf', x: 0, y: 0, width: 420, height: 900 },
      { id: 'b000000000000001', type: 'file', file: 'Attachments/Board 1.svg', x: box[0], y: box[1], width: box[2], height: box[3], nexloreInk: true },
    ],
    edges: [],
  })
  const state = await (await page.request.get('/api/canvas', { params: { path } })).json()
  expect((await page.request.put('/api/canvas', { data: { path, content, base_hash: state.hash }, headers: TAB })).ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path }, headers: TAB })

  await open(page, space)
  const card = page.locator('.react-flow__node[data-id="c000000000000001"]')
  await expect(page.frameLocator('[data-testid="pdf-pages"]').locator('#strip canvas')).toHaveCount(3)
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(2)
  const tall = (await card.boundingBox())!
  await card.click({ position: { x: tall.width / 2, y: 12 } })
  await page.getByRole('button', { name: 'Show the first page only' }).click()

  // One page shown, the card short, its height with all pages kept; the stroke on page three out of sight, in the file.
  await expect(page.frameLocator('[data-testid="pdf-pages"]').locator('#strip canvas')).toHaveCount(1)
  await expect
    .poll(async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001'), { timeout: 15_000 })
    .toMatchObject({ nexlorePages: 1, height: expect.any(Number) })
  await expect.poll(async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001')!.height, { timeout: 15_000 }).toBeLessThan(450)
  const folded = (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001') as Node & { nexloreUnfolded: number }
  expect(folded.nexloreUnfolded).toBeGreaterThan(800)
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(1)
  expect(await strokesOnDisk(page.request, drawing)).toHaveLength(2)
  // Drawing while it is folded keeps the stroke out of sight in the file.
  await page.locator('[data-dock="pen"]').click()
  const free = (await page.locator('.react-flow').boundingBox())!
  await stroke(page, [free.x + free.width - 300, free.y + 120], [free.x + free.width - 160, free.y + 200])
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(2)
  await expect.poll(async () => (await strokesOnDisk(page.request, drawing)).length, { timeout: 15_000 }).toBe(3)
  expect((await strokesOnDisk(page.request, drawing)).map((one) => one.pts[0])).toContainEqual([40, 760, 0.5])
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-dock="pen"]')).toHaveAttribute('aria-pressed', 'false')

  // Moved, the hidden stroke goes along with the card it belongs to.
  const short = (await card.boundingBox())!
  await stroke(page, [short.x + short.width / 2, short.y + 12], [short.x + short.width / 2 + 200, short.y + 12 + 100])
  await expect
    .poll(async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001')!.x, { timeout: 15_000 })
    .not.toBe(0)
  const moved = (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001')!
  await expect
    .poll(async () => (await strokesOnDisk(page.request, drawing)).map((one) => one.pts[0]), { timeout: 15_000 })
    .toEqual(expect.arrayContaining([[40 + moved.x, 80 + moved.y, 0.5], [40 + moved.x, 760 + moved.y, 0.5]]))

  // Unfolded: all pages again, and the stroke on page three with them.
  await card.click({ position: { x: short.width / 2, y: 12 } })
  await page.getByRole('button', { name: 'Show every page' }).click()
  await expect(page.frameLocator('[data-testid="pdf-pages"]').locator('#strip canvas')).toHaveCount(3)
  await expect(page.locator('.nl-pen-layer [data-strokes] path')).toHaveCount(3)
  await expect
    .poll(async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001'), { timeout: 15_000 })
    .not.toHaveProperty('nexlorePages')
  expect(problems).toEqual([])
})
