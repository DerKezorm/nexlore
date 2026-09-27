/**
 * The graph through the interface, against the real backend and the prepared vault: the map of every space, the
 * clouds, a note's card, flying to a search hit, the local graph on the note page, the phone.
 */
import { expect, test, type Page } from '@playwright/test'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test.beforeEach(async ({ page }) => {
  // Every test starts with the folder cloud, whatever the one before chose.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-cloud-set')) {
      localStorage.setItem('nexlore.graph.cloud', 'folders')
      sessionStorage.setItem('e2e-cloud-set', '1')
    }
  })
})

test('the map lists every space, and the chosen cloud stays after a reload', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Graph' })).toBeVisible()
  const clouds = page.getByRole('radiogroup', { name: 'Group by' })
  await expect(clouds.getByRole('radio', { name: 'Folders' })).toHaveAttribute('aria-checked', 'true')
  const card = page.getByTestId('graph-filters')
  for (const space of ['Work', 'Home', 'Writing', 'Media']) await expect(card.getByRole('button', { name: new RegExp(`^${space}`) })).toBeVisible()
  await clouds.getByRole('radio', { name: 'Tags' }).click()
  await expect(clouds.getByRole('radio', { name: 'Tags' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('A note with several tags stands under its first.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('radiogroup', { name: 'Group by' }).getByRole('radio', { name: 'Tags' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radiogroup', { name: 'Group by' }).getByRole('radio', { name: 'Folders' }).click()
  expect(problems).toEqual([])
})

test('a note chosen in the sidebar gets its card on the map, and the card opens it', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/')
  const tree = page.getByTestId('sidebar-tree')
  await tree.getByRole('button', { name: 'Plan', exact: true }).click()
  const card = page.getByTestId('graph-card')
  await expect(card.getByRole('heading', { name: 'Plan' })).toBeVisible()
  await expect(card.getByText('1 backlink')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Garden' })).toBeVisible()
  await card.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/note\/Work\/Plan\.md$/)
  expect(problems).toEqual([])
})

test('a search hit flies to the note on the map', async ({ page }) => {
  await page.goto('/?focus=' + encodeURIComponent('Work/Ideas/Garden.md'))
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Garden' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})

test('the note page shows the neighbourhood, one to three links deep, and leads to the big graph', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Work/Plan.md')
  const local = page.getByTestId('local-graph')
  await expect(local.getByRole('img', { name: 'Neighbourhood of the note' })).toBeVisible()
  const depths = local.getByRole('radiogroup', { name: 'How many links away' })
  await expect(depths.getByRole('radio', { name: 'Depth 1' })).toHaveAttribute('aria-checked', 'true')
  const deeper = page.waitForResponse((response) => response.url().includes('/api/graph/local') && response.url().includes('depth=2'))
  await depths.getByRole('radio', { name: 'Depth 2' }).click()
  const answer = await (await deeper).json()
  // Plan links to Garden, and Garden back: two notes, one link between them.
  expect(answer.nodes.map((node: [number, string]) => node[1]).sort()).toEqual(['Work/Ideas/Garden.md', 'Work/Plan.md'])
  await expect(depths.getByRole('radio', { name: 'Depth 2' })).toHaveAttribute('aria-checked', 'true')
  // Kept per browser.
  await page.reload()
  await expect(page.getByTestId('local-graph').getByRole('radio', { name: 'Depth 2' })).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('local-graph').getByRole('button', { name: 'Show in the big graph' }).click()
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Plan' })).toBeVisible()
  expect(problems).toEqual([])
})

test('a note without links says so in its local graph', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Work/Scratch.md')
  await expect(page.getByTestId('local-graph').getByText('No links yet.')).toBeVisible()
})

test('on a phone the clouds sit in a sheet, and nothing is wider than the screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Graph' })).toBeVisible()
  await page.getByRole('button', { name: 'Folders' }).click()
  const sheet = page.getByRole('dialog', { name: 'Group by' })
  await expect(sheet.getByRole('radio', { name: 'Folders' })).toHaveAttribute('aria-checked', 'true')
  await expect(sheet.getByText('Show daily notes')).toBeVisible()
  await sheet.getByRole('radio', { name: 'Topics' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('button', { name: 'Topics' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.goto('/note/Work/Plan.md')
  await expect(page.getByTestId('local-graph')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
})

test('two fingers zoom the map on a phone, one finger moves it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/')
  const canvas = page.getByTestId('graph-canvas')
  // The map fitted into the screen (not the camera's first value before the overview came).
  await expect(canvas).toHaveAttribute('data-zoom', /\d/)
  await expect.poll(async () => (await canvas.getAttribute('data-zoom')) ?? '0.05000').not.toBe('0.05000')
  await page.waitForTimeout(300)
  const before = Number(await canvas.getAttribute('data-zoom'))
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // Two touch pointers, moving apart to four times their distance.
  await canvas.evaluate((element, [x, y]) => {
    const send = (type: string, id: number, px: number, py: number) =>
      element.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: px, clientY: py, bubbles: true, isPrimary: id === 1 }))
    send('pointerdown', 1, x - 20, y)
    send('pointerdown', 2, x + 20, y)
    for (let step = 1; step <= 10; step++) {
      send('pointermove', 1, x - 20 - step * 6, y)
      send('pointermove', 2, x + 20 + step * 6, y)
    }
    send('pointerup', 1, x - 80, y)
    send('pointerup', 2, x + 80, y)
  }, [cx, cy])
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(before * 3.5)
  const zoomed = Number(await canvas.getAttribute('data-zoom'))
  expect(zoomed).toBeLessThan(before * 4.5)
  // One finger moves the map and does not zoom.
  await canvas.evaluate((element, [x, y]) => {
    const send = (type: string, px: number) =>
      element.dispatchEvent(new PointerEvent(type, { pointerId: 3, pointerType: 'touch', clientX: px, clientY: y, bubbles: true, isPrimary: true }))
    send('pointerdown', x)
    for (let step = 1; step <= 10; step++) send('pointermove', x + step * 10)
    send('pointerup', x + 100)
  }, [cx, cy])
  await page.waitForTimeout(200)
  expect(Number(await canvas.getAttribute('data-zoom'))).toBeCloseTo(zoomed, 5)
})

test('the operator may have the topics worked out again', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('radiogroup', { name: 'Group by' }).getByRole('radio', { name: 'Topics' }).click()
  const again = page.getByRole('button', { name: 'Work out again' })
  await expect(again).toBeVisible()
  await expect(page.getByText('from titles, tags, text and links')).toBeVisible()
  const asked = page.waitForResponse((response) => response.url().includes('/api/graph/topics') && response.request().method() === 'POST')
  await again.click()
  expect((await asked).status()).toBe(202)
  await expect(page.getByText(/Topics worked out/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('radiogroup', { name: 'Group by' }).getByRole('radio', { name: 'Folders' }).click()
})

test('a folder with more notes than a page loads the rest in the sidebar as it scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Many/Flat/Note 000.md')
  const tree = page.getByTestId('sidebar-tree')
  await expect(tree.getByRole('button', { name: 'Note 000', exact: true })).toBeVisible()
  // The last note lies beyond the first page of 500: it appears once the list is scrolled to its end.
  for (let round = 0; round < 40; round++) {
    await tree.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    if (await tree.getByRole('button', { name: 'Note 619', exact: true }).isVisible()) break
    await page.waitForTimeout(150)
  }
  await expect(tree.getByRole('button', { name: 'Note 619', exact: true })).toBeVisible()
})

test('the map moves and zooms with the keyboard', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByTestId('graph-canvas')
  // Fitted: set, and no longer the camera's first value before the overview came.
  await expect.poll(async () => (await canvas.getAttribute('data-zoom')) ?? '0.05000').not.toBe('0.05000')
  await page.waitForTimeout(300)
  const fitted = Number(await canvas.getAttribute('data-zoom'))
  await canvas.focus()
  await page.keyboard.press('+')
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(fitted * 1.5)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('0')
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeCloseTo(fitted, 3)
})
