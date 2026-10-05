/**
 * The graph through the interface, against the real backend and the prepared vault: the map of every space, the
 * clouds, a note's card, flying to a search hit, the local graph on the note page, the phone.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

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

// The tab beside the note and the spaces on the map are kept with the account, and the tests share one: back after each.
test.afterEach(async ({ page }) => {
  await page.request.put('/api/me/appearance', { data: { panel: true, panel_tab: 'links', graph_hidden: [] }, headers: { 'X-Nexlore-Client': 'tab-e2e-panel' } })
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

/** The tree draws only what is in view: other tests add spaces, so a note may first have to be scrolled to, as by hand. */
async function treeNote(page: Page, name: string) {
  const tree = page.getByTestId('sidebar-tree')
  const button = tree.getByRole('button', { name, exact: true })
  await expect(tree.getByRole('listitem').first()).toBeVisible()
  for (let step = 0; step < 40 && !(await button.isVisible()); step++) {
    await tree.evaluate((element) => element.scrollBy(0, element.clientHeight / 2))
    await page.waitForTimeout(50)
  }
  return button
}

test('a note chosen in the sidebar gets its card on the map, and the card opens it', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/')
  await (await treeNote(page, 'Plan')).click()
  const card = page.getByTestId('graph-card')
  await expect(card.getByRole('heading', { name: 'Plan' })).toBeVisible()
  await expect(card.getByText('1 backlink')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Garden' })).toBeVisible()
  await card.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/note\/Work\/Plan\.md$/)
  expect(problems).toEqual([])
})

test('a note chosen before the map has come is shown once it has', async ({ page }) => {
  // A slow server (seen on a CI machine): the sidebar is there, the map of the space is not yet.
  await page.route('**/api/graph/overview?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await route.continue()
  })
  await page.goto('/')
  await (await treeNote(page, 'Plan')).click()
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Plan' })).toBeVisible({ timeout: 15_000 })
})

test('a search hit flies to the note on the map', async ({ page }) => {
  await page.goto('/?focus=' + encodeURIComponent('Work/Ideas/Garden.md'))
  // Late in a full run the map page was so busy that the card took longer than 5 s (06.10.2026).
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Garden' })).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/$/)
})

test('the note page shows the neighbourhood, one to three links deep, and leads to the big graph', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Work/Plan.md')
  // The tab is kept with the account, sent after the click; the reload below must not cut that off.
  const kept = page.waitForResponse((answer) => answer.url().endsWith('/api/me/appearance') && answer.request().postData()?.includes('"panel_tab":"graph"') === true)
  await page.getByTestId('note-panel').getByRole('tab', { name: 'Graph' }).click()
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
  // Kept per browser, and the tab with the account.
  expect((await kept).ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('note-panel').getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('local-graph').getByRole('radio', { name: 'Depth 2' })).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('local-graph').getByRole('button', { name: 'Show in the big graph' }).click()
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Plan' })).toBeVisible()
  expect(problems).toEqual([])
})

test('the focus fades the rest in by degrees, the wheel glides, and a note dragged stays where it is dropped', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  const canvas = page.getByTestId('graph-canvas')
  // From the first frame on: every value the fade takes, to see that it goes by degrees.
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { fades: string[] }).fades = seen
    const look = () => {
      const value = document.querySelector('[data-testid="graph-canvas"]')?.getAttribute('data-fade')
      if (value && seen[seen.length - 1] !== value) seen.push(value)
      requestAnimationFrame(look)
    }
    requestAnimationFrame(look)
  })
  await page.goto('/?focus=' + encodeURIComponent('Work/Ideas/Garden.md'))
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Garden' })).toBeVisible()
  await expect(canvas).toHaveAttribute('data-fade', '1.00')
  const fades = await page.evaluate(() => (window as unknown as { fades: string[] }).fades.map(Number))
  expect(fades.some((value) => value > 0.05 && value < 0.95)).toBe(true)
  await expect(canvas).toHaveAttribute('data-moving', 'no', { timeout: 10_000 })

  // The wheel: the zoom comes over several frames, not in one jump.
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 40)
  const zooms = await page.evaluate(async () => {
    const element = document.querySelector('[data-testid="graph-canvas"]')!
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 60, clientY: 120, bubbles: true, cancelable: true }))
    const seen: string[] = []
    for (let frame = 0; frame < 30; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const value = element.getAttribute('data-zoom')!
      if (seen[seen.length - 1] !== value) seen.push(value)
    }
    return seen
  })
  expect(zooms.length).toBeGreaterThan(3)
  await page.keyboard.press('Escape')

  // Dragged with the mouse: the note goes along, then stays where it was dropped.
  await page.goto('/?focus=' + encodeURIComponent('Work/Ideas/Garden.md'))
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Garden' })).toBeVisible()
  await expect(canvas).toHaveAttribute('data-moving', 'no', { timeout: 10_000 })
  const place = page.getByTestId('graph-places').locator('button[data-place="note"]', { hasText: /^Garden$/ })
  // The list of places follows only a map that stands still; a tile arriving late lets it swing in once more
  // (two rounds in ten, up to some seconds, measured 05.10.2026).
  await expect(place).toHaveCount(1, { timeout: 20_000 })
  await expect(canvas).toHaveAttribute('data-moving', 'no', { timeout: 10_000 })
  const where = async () => place.evaluate((button: HTMLElement) => [parseFloat(button.style.left), parseFloat(button.style.top)])
  const [x, y] = await where()
  // The map itself stays: a mouse that held nothing would move the whole map, Garden with it (a mutation passed so).
  const folder = page.getByTestId('graph-places').locator('button[data-place="group"]').first()
  await expect(folder).toHaveCount(1)
  const folderAt = async () => folder.evaluate((button: HTMLElement) => [parseFloat(button.style.left), parseFloat(button.style.top)])
  const [fx, fy] = await folderAt()
  await page.mouse.move(box.x + x, box.y + y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) await page.mouse.move(box.x + x + step * 4, box.y + y + step * 2)
  await expect(canvas).toHaveAttribute('data-moving', 'yes')
  await page.mouse.up()
  await expect(canvas).toHaveAttribute('data-moving', 'no', { timeout: 10_000 })
  // Where the mouse let go (a pixel either way: the grip is where the dot was hit, not its exact middle).
  await expect.poll(async () => {
    const [nx, ny] = await where()
    return Math.abs(nx - x - 40) <= 2 && Math.abs(ny - y - 20) <= 2
  }).toBe(true)
  const [gx, gy] = await folderAt()
  expect(Math.abs(gx - fx) + Math.abs(gy - fy)).toBeLessThan(1)
  expect(problems).toEqual([])
})

test('the glow of the map is switched off in the settings, for the own account', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.goto('/')
  await expect(canvas).toHaveAttribute('data-glow', '1.00')
  await page.goto('/settings?tab=looks')
  await page.getByRole('checkbox', { name: /Glow on the map/ }).uncheck()
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).appearance.graph_glow).toBe(false)
  try {
    await page.goto('/')
    await expect(canvas).toHaveAttribute('data-glow', '0.00')
  } finally {
    await page.request.put('/api/me/appearance', { data: { graph_glow: true }, headers: { 'X-Nexlore-Client': 'tab-e2e-glow' } })
  }
})

test('a note without links says so in its local graph', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Work/Scratch.md')
  await page.getByTestId('note-panel').getByRole('tab', { name: 'Graph' }).click()
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
  // Beside the note is a sheet from below on a phone, opened from the header of the note.
  await expect(page.getByTestId('note-panel')).toHaveCount(0)
  await page.getByRole('button', { name: 'Column beside the note' }).click()
  await expect(page.getByTestId('note-panel')).toHaveAttribute('data-place', 'bottom')
  await page.getByTestId('note-panel').getByRole('tab', { name: 'Graph' }).click()
  await expect(page.getByTestId('local-graph')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-panel')).toHaveCount(0)
})

test('on a low phone screen the sheet scrolls in itself, its clouds stay within reach', async ({ page }) => {
  // Many spaces made the sheet taller than the screen: its top, with the clouds, lay above it and could not be tapped.
  await page.setViewportSize({ width: 560, height: 360 })
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Graph' })).toBeVisible()
  await page.getByRole('button', { name: 'Folders' }).click()
  const sheet = page.getByRole('dialog', { name: 'Group by' })
  await expect(sheet.getByTestId('graph-spaces').getByRole('checkbox').nth(5)).toBeAttached()
  const box = await sheet.boundingBox()
  expect(box && box.y).toBeGreaterThanOrEqual(0)
  await sheet.getByRole('radio', { name: 'Tags' }).click()
  await expect(sheet).toBeHidden()
  await page.getByRole('button', { name: 'Tags' }).click()
  await sheet.getByRole('radio', { name: 'Folders' }).click()
  await expect(sheet).toBeHidden()
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
  // The last note lies beyond the first page of 500: it appears once the list is scrolled that far. Step by step:
  // the spaces after this one (sorted by name) fill the end of the list.
  for (let round = 0; round < 120; round++) {
    if (await tree.getByRole('button', { name: 'Note 619', exact: true }).isVisible()) break
    await tree.evaluate((element) => element.scrollBy(0, element.clientHeight / 2))
    await page.waitForTimeout(100)
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

test('the map shows only the spaces chosen, kept with the account, and a note from another brings its space back', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/')
  const canvas = page.getByTestId('graph-canvas')
  const shown = async () => ((await page.locator('canvas[data-colours]').getAttribute('data-colours')) ?? '').split(' ').filter(Boolean)
  await expect(canvas).toBeVisible()
  const card = page.getByTestId('graph-filters')
  const boxes = card.getByTestId('graph-spaces').getByRole('checkbox')
  await expect(boxes.first()).toBeVisible()
  // Every space listed and on the map (the list comes before the last overview).
  await expect.poll(async () => (await shown()).length > 2 && (await shown()).length === (await boxes.count())).toBe(true)
  const names = await boxes.evaluateAll((list) => list.map((box) => box.getAttribute('aria-label')))
  const all = names.length
  const work = card.getByRole('checkbox', { name: 'Show Work on the map' })
  await expect(work).toBeChecked()
  const workColour = (await shown())[names.indexOf('Show Work on the map')]

  // Only this one: the rest is left out, Work keeps its colour, nothing else is asked for.
  const asked: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/graph/overview') asked.push(url.searchParams.get('space') ?? '')
  })
  await card.getByRole('listitem').filter({ hasText: 'Work' }).first().hover()
  await card.getByRole('button', { name: 'Show only Work' }).click()
  await expect.poll(shown).toEqual([workColour])
  await expect(work).toBeChecked()
  await expect(work).toBeDisabled()
  await expect(card.getByRole('checkbox', { name: 'Show Home on the map' })).not.toBeChecked()
  await page.waitForTimeout(300)
  expect(new Set(asked)).toEqual(new Set(['Work']))

  // Kept with the account: the same after a reload.
  await page.reload()
  await expect.poll(shown).toEqual([workColour])

  // A note of a space left out, chosen in the sidebar: its space comes back and the note is shown.
  await (await treeNote(page, 'Shopping')).click()
  await expect(page.getByTestId('graph-card').getByRole('heading', { name: 'Shopping' })).toBeVisible({ timeout: 15_000 })
  await expect(card.getByRole('checkbox', { name: 'Show Home on the map' })).toBeChecked()
  await expect.poll(async () => (await shown()).length).toBe(2)

  // Show all.
  await card.getByRole('button', { name: 'Show all' }).click()
  await expect.poll(async () => (await shown()).length).toBe(all)
  await expect(card.getByRole('button', { name: 'Show all' })).toHaveCount(0)
  expect(problems).toEqual([])
})
