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

test('the operator lets plugins out in the settings, the account switches them on', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/settings')
  for (const id of ['toc', 'query', 'kanban']) {
    const card = page.getByTestId(`plugin-${id}`)
    await card.getByRole('button', { name: 'Install' }).click()
    await card.getByRole('button', { name: 'Let it out' }).click()
    await expect(card.getByText(/let out/)).toBeVisible()
  }
  await page.goto('/account')
  const mine = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Plugins for me' }) })
  for (const name of ['Contents', 'Queries', 'Kanban']) {
    const toggle = mine.getByRole('checkbox', { name })
    // Switched on once the server said so.
    await toggle.click()
    await expect(toggle).toBeChecked()
  }
  expect(problems).toEqual([])
})

async function frameOf(page: Page, id: string): Promise<FrameLocator> {
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
  await page.goto('/settings')
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

test('switched off again, the frames are gone', async ({ page }) => {
  for (const id of ['toc', 'query', 'kanban']) {
    const answer = await page.request.put(`/api/plugins/${id}/enabled`, { data: { enabled: false }, headers: TAB })
    expect(answer.ok()).toBe(true)
  }
  await page.goto('/note/Zoo/Sown.md')
  await expect(page.locator('article')).toContainText('Peas.')
  await expect(page.locator('iframe[data-plugin]')).toHaveCount(0)
})
