/**
 * Tables from the toolbar's table menu, in the app as it runs: rows sorted by a column, a column aligned; in the
 * file only the table changes.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const NOTE = 'Heath/Table.md'
const START = '# Table\n\nKeep  this   line.\n\n| Item | Price |\n| --- | --- |\n| Tea | 10 |\n| Cake | 2 |\n'
const TAB = { 'X-Nexlore-Client': 'tab-e2e-tables' }
const disk = () => fs.readFileSync(path.join(DATA, 'vault', ...NOTE.split('/')), 'utf-8')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.afterEach(async ({ page }) => {
  await page.waitForLoadState('networkidle')
  const now = await (await page.request.get('/api/note?path=' + encodeURIComponent(NOTE))).json()
  if (now.content !== START) await page.request.put('/api/note', { data: { path: NOTE, content: START, base_hash: now.hash }, headers: TAB })
})

test('the table menu sorts the rows by a column and aligns it', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Table.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.getByText('10', { exact: true }).click()
  const toolbar = page.getByRole('toolbar')
  await toolbar.getByRole('button', { name: 'Table', exact: true }).click()
  let saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await page.getByRole('menuitem', { name: 'Sort by this column, A to Z' }).click()
  await saved
  await expect.poll(disk).toBe('# Table\n\nKeep  this   line.\n\n| Item | Price |\n| --- | --- |\n| Cake | 2 |\n| Tea | 10 |\n')
  await toolbar.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Align the column' }).click()
  saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await page.getByRole('menuitem', { name: 'Right', exact: true }).click()
  await saved
  await expect.poll(disk).toContain('| Item | Price |\n| --- | --: |\n')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  expect(problems).toEqual([])
})
