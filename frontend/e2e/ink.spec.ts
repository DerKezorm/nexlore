/**
 * Drawing with the pen (`.svg` with its strokes inside): a drawing made from the editor's toolbar or "/" lands in the
 * note where the caret is and opens for drawing; a stroke drawn with the mouse is saved after a pause and there after
 * a reload; the eraser takes it, a step back brings it again; the drawing's own page draws too; any other SVG stays a
 * link. Each test makes a space of its own (a name per run: a deleted space keeps its name in the trash).
 */
import { type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'makes spaces of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-ink0000' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

/** A space with one note in it. */
async function makeNote(request: APIRequestContext): Promise<{ space: string; note: string }> {
  const space = `Ink ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
  expect((await request.post('/api/spaces', { data: { name: space }, headers: TAB })).ok()).toBe(true)
  const made = await request.post('/api/notes', { data: { folder: space, title: 'Network', content: '# Network\n\nFirst line.\n' }, headers: TAB })
  expect(made.ok()).toBe(true)
  return { space, note: (await made.json()).path }
}

const noteUrl = (path: string) => '/note/' + path.split('/').map(encodeURIComponent).join('/')

async function drawingOnDisk(request: APIRequestContext, path: string): Promise<{ strokes: unknown[]; view?: unknown }> {
  const answer = await request.get('/api/ink', { params: { path } })
  expect(answer.ok()).toBe(true)
  return (await answer.json()).ink
}

async function noteOnDisk(request: APIRequestContext, path: string): Promise<string> {
  return (await (await request.get('/api/note', { params: { path } })).json()).content
}

/** A stroke dragged with the mouse across a surface, from one share of its size to another. */
async function stroke(page: Page, surface: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await surface.boundingBox())!
  const at = (share: [number, number]) => [box.x + box.width * share[0], box.y + box.height * share[1]] as const
  await page.mouse.move(...at(from))
  await page.mouse.down()
  for (let step = 1; step <= 12; step++) {
    const share: [number, number] = [from[0] + ((to[0] - from[0]) * step) / 12, from[1] + ((to[1] - from[1]) * step) / 12]
    await page.mouse.move(...at(share))
  }
  await page.mouse.up()
}

/** Into the editor, on a new empty line under the first one. */
async function newLine(page: Page, note: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(noteUrl(note) + '?edit=1')
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  await editor.getByText('First line.').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
}

test('a drawing made from the toolbar is drawn in, saved, there after a reload, erased and brought back', async ({ page }) => {
  const problems = collectProblems(page)
  const { note } = await makeNote(page.request)
  await newLine(page, note)
  const made = page.waitForResponse((response) => response.url().endsWith('/api/inks') && response.request().method() === 'POST')
  await page.getByTestId('editor-toolbar').locator('[data-tool="drawing"]').click()
  const { path, embed } = await (await made).json()
  expect(path).toMatch(/\.svg$/)

  // It opens for drawing at once, where the caret was.
  const block = page.locator(`[data-ink-block="${path}"]`)
  await expect(block).toHaveAttribute('data-editing', '')
  await expect(block.getByTestId('ink-toolbar')).toBeVisible()
  await expect.poll(() => noteOnDisk(page.request, note), { timeout: 15_000 }).toContain(`First line.\n\n${embed}`)

  // A stroke with the mouse, saved after a pause.
  const surface = block.locator('[data-ink-surface]')
  await stroke(page, surface, [0.2, 0.3], [0.7, 0.6])
  await expect(block.locator('[data-strokes] path')).toHaveCount(1)
  await expect.poll(async () => (await drawingOnDisk(page.request, path)).strokes.length, { timeout: 15_000 }).toBe(1)
  // Done keeps the view in the file.
  await block.locator('[data-ink-tool="done"]').click()
  await expect(block).not.toHaveAttribute('data-editing', '')
  await expect.poll(async () => (await drawingOnDisk(page.request, path)).view, { timeout: 15_000 }).toBeTruthy()

  // There after a reload, in the reading view.
  await page.goto(noteUrl(note))
  const shown = page.locator(`article [data-ink-block="${path}"]`)
  await expect(shown.locator('[data-strokes] path')).toHaveCount(1)

  // The eraser (E) takes it; a step back (Ctrl Z) brings it again.
  await shown.hover()
  await shown.locator('[data-ink-act="draw"]').click()
  await expect(shown).toHaveAttribute('data-editing', '')
  await page.keyboard.press('e')
  await expect(shown.locator('[data-ink-surface]')).toHaveAttribute('data-tool', 'eraser')
  await stroke(page, shown.locator('[data-ink-surface]'), [0.05, 0.5], [0.95, 0.5])
  await stroke(page, shown.locator('[data-ink-surface]'), [0.5, 0.05], [0.5, 0.95])
  await expect(shown.locator('[data-strokes] path')).toHaveCount(0)
  await expect.poll(async () => (await drawingOnDisk(page.request, path)).strokes.length, { timeout: 15_000 }).toBe(0)
  await page.keyboard.press('Control+z')
  await expect(shown.locator('[data-strokes] path')).toHaveCount(1)
  await expect.poll(async () => (await drawingOnDisk(page.request, path)).strokes.length, { timeout: 15_000 }).toBe(1)
  await page.keyboard.press('Escape')
  await expect(shown).not.toHaveAttribute('data-editing', '')

  // Open large: the drawing's own page, which draws too.
  await shown.hover()
  await shown.locator('[data-ink-act="open"]').click()
  await expect(page).toHaveURL(/\/file\/.*\.svg$/)
  const big = page.locator('[data-ink-page] [data-ink-surface]')
  await expect(big.locator('[data-strokes] path')).toHaveCount(1)
  await expect(page.locator('[data-ink-page]').getByRole('button', { name: /Network/ })).toBeVisible()
  await page.keyboard.press('p')
  await stroke(page, big, [0.1, 0.1], [0.3, 0.2])
  await expect(big.locator('[data-strokes] path')).toHaveCount(2)
  await expect.poll(async () => (await drawingOnDisk(page.request, path)).strokes.length, { timeout: 15_000 }).toBe(2)
  await expect(page.locator('[data-ink-page] [data-ink-saved="saved"]')).toBeVisible({ timeout: 10_000 })
  expect(problems).toEqual([])
})

test('"/" makes a drawing too, and the canvas shows one on its card', async ({ page }) => {
  const problems = collectProblems(page)
  const { space, note } = await makeNote(page.request)
  await newLine(page, note)
  const made = page.waitForResponse((response) => response.url().endsWith('/api/inks') && response.request().method() === 'POST')
  await page.keyboard.type('/drawing')
  const menu = page.locator('.milkdown-slash-menu')
  await expect(menu.getByText('Drawing', { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  const { path } = await (await made).json()
  const block = page.locator(`[data-ink-block="${path}"]`)
  await expect(block).toHaveAttribute('data-editing', '')
  await stroke(page, block.locator('[data-ink-surface]'), [0.3, 0.3], [0.6, 0.7])
  await expect.poll(async () => (await drawingOnDisk(page.request, path)).strokes.length, { timeout: 15_000 }).toBe(1)

  // On a canvas, a card shows it whole; a double click opens its page.
  const canvas = await page.request.post('/api/canvases', { data: { folder: space, name: 'Board' }, headers: TAB })
  expect(canvas.ok()).toBe(true)
  const empty = await canvas.json()
  const content = JSON.stringify({ nodes: [{ id: 'd000000000000001', type: 'file', file: path.slice(space.length + 1), x: 0, y: 0, width: 400, height: 300 }], edges: [] })
  expect((await page.request.put('/api/canvas', { data: { path: empty.path, content, base_hash: empty.hash }, headers: TAB })).ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path: empty.path }, headers: TAB })
  await page.goto('/file/' + empty.path.split('/').map(encodeURIComponent).join('/'))
  const card = page.locator('.react-flow__node[data-id="d000000000000001"]')
  await expect(card.locator('[data-ink-picture] [data-strokes] path')).toHaveCount(1)
  await card.dblclick()
  await expect(page.locator('[data-ink-page]')).toBeVisible()
  expect(problems).toEqual([])
})

test('an SVG that is no drawing stays a link, and its page the page of a file', async ({ page }) => {
  const { space, note } = await makeNote(page.request)
  const plain = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const up = await page.request.post(`/api/attachments?note=${encodeURIComponent(note)}&name=logo.svg`, { headers: TAB, data: plain })
  expect(up.status(), await up.text()).toBe(201)
  const uploaded = (await up.json()).path as string
  const current = await (await page.request.get('/api/note', { params: { path: note } })).json()
  const saved = await page.request.put('/api/note', { data: { path: note, content: current.content + '\n![[logo.svg]]\n', base_hash: current.hash }, headers: TAB })
  expect(saved.ok()).toBe(true)
  await page.request.delete('/api/locks', { params: { path: note }, headers: TAB })
  await page.goto(noteUrl(note))
  const link = page.locator('article a.nn-filelink[data-file]', { hasText: 'logo.svg' })
  await expect(link).toBeVisible()
  await expect(page.locator('article [data-ink-block]')).toHaveCount(0)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/file/${encodeURIComponent(space)}/`))
  await expect(page.getByRole('link', { name: 'Download' })).toBeVisible()
  await expect(page.locator('[data-ink-page]')).toHaveCount(0)
  expect(uploaded.endsWith('.svg')).toBe(true)
})
