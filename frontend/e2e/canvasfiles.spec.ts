/**
 * Files laid on a canvas: a PDF dropped from the desktop lands in the canvas's attachment folder and shows its pages,
 * the card as tall as they are, and folds to its first page; a picture pasted with Ctrl V comes in its own shape; far
 * out a card still big on the screen keeps what it shows. Each test makes a space of its own.
 */
import { type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'makes spaces of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-cvfile00' }

type Node = { id: string; type: string; file?: string; x: number; y: number; width: number; height: number; nexlorePages?: number }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

/** A space with an empty canvas `Board` in it. */
async function makeBoard(request: APIRequestContext): Promise<{ space: string; path: string }> {
  const space = `Lay ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
  expect((await request.post('/api/spaces', { data: { name: space }, headers: TAB })).ok()).toBe(true)
  const made = await request.post('/api/canvases', { data: { folder: space, name: 'Board' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return { space, path: (await made.json()).path }
}

async function canvasOnDisk(request: APIRequestContext, path: string): Promise<{ nodes: Node[]; edges: unknown[] }> {
  const text = (await (await request.get('/api/canvas', { params: { path } })).json()).content as string
  return text.trim() ? JSON.parse(text) : { nodes: [], edges: [] }
}

async function open(page: Page, space: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/file/${encodeURIComponent(space)}/Board.canvas`)
  await expect(page.locator('.react-flow')).toBeVisible()
}

/** A drag with the mouse, in pixels of the page. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
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

test('a PDF folds to its first page and back, kept in the canvas; folded it moves as a short card', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  const pdf = await page.request.post('/api/attachments', { params: { name: 'Three.pdf', canvas: path }, data: pdfOf(3), headers: TAB })
  expect(pdf.status()).toBe(201)
  const content = JSON.stringify({ nodes: [{ id: 'c000000000000001', type: 'file', file: 'Attachments/Three.pdf', x: 0, y: 0, width: 420, height: 900 }], edges: [] })
  const state = await (await page.request.get('/api/canvas', { params: { path } })).json()
  expect((await page.request.put('/api/canvas', { data: { path, content, base_hash: state.hash }, headers: TAB })).ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path }, headers: TAB })

  await open(page, space)
  const card = page.locator('.react-flow__node[data-id="c000000000000001"]')
  const strip = page.frameLocator('[data-testid="pdf-pages"]').locator('#strip canvas')
  const onDisk = async () => (await canvasOnDisk(page.request, path)).nodes.find((node) => node.id === 'c000000000000001')!
  await expect(strip).toHaveCount(3)
  const tall = (await card.boundingBox())!
  await card.click({ position: { x: tall.width / 2, y: 12 } })
  await page.getByRole('button', { name: 'Show the first page only' }).click()

  // One page, the card short, the choice in the canvas file.
  await expect(strip).toHaveCount(1)
  await expect.poll(async () => (await onDisk()).nexlorePages, { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await onDisk()).height, { timeout: 15_000 }).toBeLessThan(450)

  // Folded, it moves like any card.
  const short = (await card.boundingBox())!
  await drag(page, [short.x + short.width / 2, short.y + 12], [short.x + short.width / 2 + 200, short.y + 112])
  await expect.poll(async () => (await onDisk()).x, { timeout: 15_000 }).not.toBe(0)

  // Unfolded: every page again, and the field gone.
  await card.click({ position: { x: short.width / 2, y: 12 } })
  await page.getByRole('button', { name: 'Show every page' }).click()
  await expect(strip).toHaveCount(3)
  await expect.poll(async () => await onDisk(), { timeout: 15_000 }).not.toHaveProperty('nexlorePages')
  await expect.poll(async () => (await onDisk()).height, { timeout: 15_000 }).toBeGreaterThan(3 * 280)
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

test('far out a card shows its title, but one still big on the screen keeps what it shows', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, path } = await makeBoard(page.request)
  const picture = await page.request.post('/api/attachments', {
    params: { name: 'plan.png', canvas: path },
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mN8ViHCQAgwMRABhrciALQ1AYLyZG5iAAAAAElFTkSuQmCC', 'base64'),
    headers: TAB,
  })
  expect(picture.status()).toBe(201)
  const content = JSON.stringify({
    nodes: [
      { id: 'd000000000000001', type: 'file', file: 'Attachments/plan.png', x: 0, y: 0, width: 2400, height: 1600 },
      { id: 'e000000000000001', type: 'text', text: 'Small', x: 2500, y: 0, width: 260, height: 120 },
    ],
    edges: [],
  })
  const state = await (await page.request.get('/api/canvas', { params: { path } })).json()
  expect((await page.request.put('/api/canvas', { data: { path, content, base_hash: state.hash }, headers: TAB })).ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path }, headers: TAB })
  await open(page, space)
  const big = page.locator('.react-flow__node[data-id="d000000000000001"]')
  const small = page.locator('.react-flow__node[data-id="e000000000000001"]')
  await expect(big.locator('img')).toBeVisible()
  for (let step = 0; step < 30 && !(await page.locator('.nl-canvas.nl-far').count()); step++) {
    await page.getByRole('button', { name: 'Zoom out' }).click()
  }
  await expect(page.locator('.nl-canvas')).toHaveClass(/nl-far/)
  await expect(big).toHaveClass(/nl-near/)
  await expect(big.locator('img')).toBeVisible()
  await expect(small).not.toHaveClass(/nl-near/)
  await expect(small.locator('.nl-card > *').first()).toBeHidden()
  expect(problems).toEqual([])
})
