/**
 * Links between spaces through the interface: `[[Zoo/Across target]]` written in the space `Zone` leads into `Zoo`,
 * a missing one is made where it looks, and a rename in `Zoo` rewrites the link in `Zone` and says so in its history.
 * The operator reads every space of the prepared vault (none has members); what a reader of one space only sees is
 * the backend's tests (`test_links_across.py`).
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''

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

test('a link into another space leads there, and the note there knows it', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zone/Across.md')
  const article = page.locator('article')
  await expect(article.getByText('Zoo/Across target')).toBeVisible()
  await expect(article.locator('.nn-wikilink-missing')).toHaveText(['Zoo/Across new'])
  await article.getByText('Zoo/Across target').click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Across%20target\.md$/)
  await expect(page.locator('article')).toContainText('Reached from another space.')
  // The backlink from the other space, on the right.
  await page.setViewportSize({ width: 1400, height: 900 })
  const backlinks = page.locator('section').filter({ has: page.getByRole('heading', { name: /Backlinks/ }) })
  await expect(backlinks.getByText('Across', { exact: true })).toBeVisible()
  expect(problems).toEqual([])
})

test('a missing link into another space makes the note there', async ({ page }) => {
  // In the editor a click on a missing link makes the note (M2), like Obsidian.
  await page.goto('/note/Zone/Across.md?edit=1')
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await page.locator('.ProseMirror .nx-wiki', { hasText: 'Zoo/Across new' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Across%20new\.md\?edit=1$/)
  expect(fs.existsSync(path.join(DATA, 'vault', 'Zone', 'Across new.md'))).toBe(false)
  await page.goto('/note/Zone/Across.md')
  await expect(page.locator('article .nn-wikilink-missing')).toHaveCount(0)
})

test('renaming a note rewrites the link in another space and names who did it', async ({ page }) => {
  await page.goto('/note/Zoo/Across rename.md')
  await page.getByRole('button', { name: 'Rename', exact: true }).first().click()
  await page.getByLabel('New name').fill('Across renamed')
  await page.getByRole('button', { name: 'Rename', exact: true }).last().click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Across%20renamed\.md$/)
  await expect(page.getByText('Links in 1 note now use the new name.')).toBeVisible()
  expect(onDisk('Zone/Across.md')).toContain('[[Zoo/Across renamed]]')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/note/Zone/Across.md')
  await page.getByRole('button', { name: 'Show the history' }).click()
  await expect(page.getByText('rename by tester')).toBeVisible()
})

test('the map asks for the bundles between spaces once the maps are there', async ({ page }) => {
  // The browser asks after the overviews of every space it shows: by then the maps the counts refer to exist.
  const answer = page.waitForResponse(
    async (response) => response.url().includes('/api/graph/across') && (await response.json()).links.length > 0,
  )
  await page.goto('/')
  await expect(page.getByRole('img', { name: 'Graph' })).toBeVisible()
  const across = await (await answer).json()
  expect(across.links.every((pair: number[]) => pair.length === 3 && pair[2] > 0)).toBe(true)
})
