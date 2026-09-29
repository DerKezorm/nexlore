/**
 * Plugins through the interface (M7), in the built app under its real Content Security Policy: the operator
 * installs and lets out, the account switches on, and each plugin runs in its locked frame: the contents beside a
 * note, a query block, the Kanban board that moves a card by rewriting only its lines. The frame can reach nothing
 * but the page: no cookie, no request of its own.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-plug' }

function onDisk(rel: string): string {
  return fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')
}

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

// The tab beside the note is kept with the account, and the tests share one: back to the links after each.
test.afterEach(async ({ page }) => {
  await page.request.put('/api/me/appearance', { data: { panel: true, panel_tab: 'links' }, headers: { 'X-Nexlore-Client': 'tab-e2e-panel' } })
})

test('the operator lets plugins out in the settings, the account switches them on', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/settings?tab=server&sub=extensions')
  for (const id of ['toc', 'query', 'kanban']) {
    const card = page.getByTestId(`plugin-${id}`)
    await card.getByRole('button', { name: 'Install' }).click()
    await card.getByRole('button', { name: 'Let it out' }).click()
    await expect(card.getByText(/let out/)).toBeVisible()
    // What comes next: every account switches it on for itself, over there.
    await expect(card.getByTestId(`plugin-next-${id}`)).toContainText('every account can now switch it on')
    await expect(card.getByRole('link', { name: 'Go there' })).toHaveAttribute('href', '/account#plugins')
  }
  // Where each shows up, and an example where one helps.
  await expect(page.getByTestId('plugin-howto-toc')).toContainText('beside every note in the tab “Plugins”')
  await expect(page.getByTestId('plugin-howto-query')).toContainText('code block ```query')
  await expect(page.getByTestId('plugin-howto-query').locator('pre')).toContainText('tag: project')
  await expect(page.getByTestId('plugin-howto-kanban')).toContainText('property “kanban-plugin”')
  // The operator switches one on for themselves right here.
  const query = page.getByTestId('plugin-query')
  await query.getByRole('button', { name: 'Switch it on for me' }).click()
  await expect(query.getByText('On for you')).toBeVisible()

  await page.goto('/account?tab=plugins')
  const mine = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Plugins for me' }) })
  await expect(mine.getByRole('checkbox', { name: 'Queries' })).toBeChecked()
  await expect(mine.getByTestId('plugin-howto-query')).toContainText('code block ```query')
  for (const name of ['Contents', 'Kanban']) {
    const toggle = mine.getByRole('checkbox', { name })
    // Switched on once the server said so.
    await toggle.click()
    await expect(toggle).toBeChecked()
  }
  expect(problems).toEqual([])
})

/** Plugins with a panel sit in the tab "Plugins" beside the note. */
const PANELS = new Set(['toc', 'rediscover'])

async function frameOf(page: Page, id: string): Promise<FrameLocator> {
  if (PANELS.has(id)) {
    const tab = page.getByTestId('note-panel').getByRole('tab', { name: 'Plugins' })
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  }
  await expect(page.locator(`iframe[data-plugin="${id}"]`).first()).toBeVisible()
  return page.frameLocator(`iframe[data-plugin="${id}"]`).first()
}

test('the contents and a query run in their frames, locked up', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/note/Zoo/Sown.md')
  const toc = await frameOf(page, 'toc')
  await expect(toc.getByRole('button', { name: 'Early' })).toBeVisible()
  await expect(toc.getByText(/words · 1 minute to read/)).toBeVisible()
  const query = await frameOf(page, 'query')
  await expect(query.getByRole('button', { name: 'Sown' })).toBeVisible()
  await expect(query.getByRole('columnheader', { name: 'Folder' })).toBeVisible()
  // Locked up: the frame has no origin, no cookie, and no way to the network.
  const frame = page.frames().find((candidate) => candidate.url().includes('/api/plugins/query/frame'))!
  const inside = await frame.evaluate(async () => {
    let cookie: string
    try {
      cookie = document.cookie
    } catch {
      cookie = 'refused'
    }
    let fetched = 'went through'
    try {
      await fetch('/api/auth/me')
    } catch {
      fetched = 'refused'
    }
    return { origin: window.origin, cookie, fetched }
  })
  expect(inside).toEqual({ origin: 'null', cookie: 'refused', fetched: 'refused' })
  // A click in the frame asks the page, which opens the note.
  await query.getByRole('button', { name: 'Sown' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Sown\.md$/)
  // Nor by loading itself elsewhere with something in the address: the app's policy (frame-src) refuses the
  // navigation before any request leaves (measured, not assumed: a request would show up here).
  const leaks: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('127.0.0.1:9')) leaks.push(request.url())
  })
  const again = page.frames().find((candidate) => candidate.url().includes('/api/plugins/query/frame'))!
  await again.evaluate(() => {
    window.location.href = 'http://127.0.0.1:9/leak?words=secret'
  }).catch(() => undefined)
  await page.waitForTimeout(1500)
  expect(leaks).toEqual([])
  // The frame's own policy refuses its fetch: the console says so. Nothing else may be there.
  expect(problems.filter((text) => !/Content Security Policy|Refused to connect|Failed to fetch/i.test(text))).toEqual([])
})

test('the board moves a card by rewriting only its lines', async ({ page }) => {
  await page.goto('/note/Zoo/Board.md')
  const board = await frameOf(page, 'kanban')
  await expect(board.getByText('Dig the bed')).toBeVisible()
  await board.getByRole('button', { name: 'Move to the lane on the right' }).click()
  await expect.poll(() => onDisk('Zoo/Board.md')).toBe(
    // The two lanes as the Obsidian Kanban plugin writes them: three blank lines under an empty lane.
    '---\nkanban-plugin: basic\n---\n\n## Todo\n\n\n\n## Done\n\n- [x] Buy seeds\n- [ ] Dig the bed\n',
  )
  // The text is one click away.
  await page.getByRole('radio', { name: 'Text' }).click()
  await expect(page.locator('article')).toContainText('Dig the bed')
})

test("the latch for plugin files of one's own opens, and uploads, only after a plain warning", async ({ page }) => {
  const problems = collectProblems(page)
  const latched = async () => (await (await page.request.get('/api/settings')).json()).plugin_upload_allowed
  await page.goto('/settings?tab=server&sub=extensions')
  const toggle = page.getByRole('checkbox', { name: "Allow plugin files of one's own" })
  await toggle.click()
  const warning = page.getByRole('dialog', { name: 'Allow plugins nobody checked?' })
  await expect(warning).toContainText('WebRTC')
  await warning.getByRole('button', { name: 'Cancel' }).click()
  await expect(warning).toHaveCount(0)
  await expect(toggle).not.toBeChecked()
  expect(await latched()).toBe(false)

  await toggle.click()
  await warning.getByRole('button', { name: 'Allow anyway' }).click()
  await expect(toggle).toBeChecked()
  await expect.poll(latched).toBe(true)
  await expect(page.getByTestId('plugin-upload-warning')).toContainText('WebRTC')

  const manifest = { id: 'mine', version: '1.0.0', name: { en: 'Mine' }, permissions: ['note:read'], place: { panel: true } }
  const card = page.locator('#plugins')
  await card.getByLabel('manifest.json').setInputFiles({ name: 'manifest.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) })
  await card.getByLabel('main.js').setInputFiles({ name: 'main.js', mimeType: 'text/javascript', buffer: Buffer.from('nexlore.ready(function () {})') })
  await card.getByRole('button', { name: 'Upload', exact: true }).click()
  const asked = page.getByRole('dialog', { name: 'Upload code nobody checked?' })
  await expect(asked).toContainText('WebRTC')
  await asked.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('plugin-mine')).toHaveCount(0)
  await card.getByRole('button', { name: 'Upload', exact: true }).click()
  await asked.getByRole('button', { name: 'Upload anyway' }).click()
  await expect(page.getByTestId('plugin-mine')).toContainText('own file, not checked')

  // Away again, and the latch closed without a question.
  await page.getByTestId('plugin-mine').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('plugin-mine')).toHaveCount(0)
  await toggle.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(latched).toBe(false)
  expect(problems).toEqual([])
})

test('rediscover shows what was written a year ago today and a note at random, each opened with a click', async ({ page }) => {
  const problems = collectProblems(page)
  for (const [method, url, data] of [
    ['post', '/api/admin/plugins/rediscover/install', undefined],
    ['put', '/api/admin/plugins/rediscover', { approved: true }],
    ['put', '/api/plugins/rediscover/enabled', { enabled: true }],
  ] as const) {
    const answer = await page.request.fetch(url, { method, data, headers: TAB })
    expect(answer.ok()).toBe(true)
  }
  // A daily note of a year ago today, named as the plugin asks for it (the day in the browser's time).
  const day = await page.evaluate(() => {
    const when = new Date()
    when.setFullYear(when.getFullYear() - 1)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  })
  expect((await page.request.post('/api/notes', { data: { folder: 'Zoo', title: day }, headers: TAB })).ok()).toBe(true)

  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/note/Zoo/Sown.md')
  const panel = await frameOf(page, 'rediscover')
  await expect(panel.getByText('A year ago today')).toBeVisible()
  await panel.getByRole('button', { name: day }).click()
  await expect(page).toHaveURL(new RegExp(`/note/Zoo/${day}\\.md$`))

  // At random: some note, which opens; "Another one" asks again.
  const again = await frameOf(page, 'rediscover')
  const random = again.locator('ul').nth(1).getByRole('button')
  await expect(random).toHaveCount(1)
  await again.getByRole('button', { name: 'Another one' }).click()
  await expect(random).toHaveCount(1)
  const title = (await random.textContent())!.trim()
  expect(title.length).toBeGreaterThan(0)
  // It may be any note, even the one open: opened means the page shows a note after the click.
  await page.goto('/note/Zoo/Sown.md')
  const later = await frameOf(page, 'rediscover')
  await later.locator('ul').nth(1).getByRole('button').click()
  await expect(page).not.toHaveURL(/\/note\/Zoo\/Sown\.md$/, { timeout: 10_000 }).catch(async () => {
    // The random note was this one: nothing to go to, which is right too.
    await expect(later.locator('ul').nth(1).getByRole('button')).toHaveText('Sown')
  })
  await expect(page).toHaveURL(/\/note\//)
  expect(problems).toEqual([])
})

test('switched off again, the frames are gone', async ({ page }) => {
  for (const id of ['toc', 'query', 'kanban', 'rediscover']) {
    const answer = await page.request.put(`/api/plugins/${id}/enabled`, { data: { enabled: false }, headers: TAB })
    expect(answer.ok()).toBe(true)
  }
  await page.goto('/note/Zoo/Sown.md')
  await expect(page.locator('article')).toContainText('Peas.')
  await expect(page.locator('iframe[data-plugin]')).toHaveCount(0)
})
