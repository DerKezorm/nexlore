/**
 * Moving blocks as an outliner does, in the app as it runs: Alt with the arrows moves a list item with the items
 * below it; in the file only the lines that changed place change.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const NOTE = 'Heath/Moving.md'
const START = '# Moving\n\nKeep  this   line as it is.\n\n- One\n- Two\n  - Two a\n- Three\n'
const TAB = { 'X-Nexlore-Client': 'tab-e2e-outline' }
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

test('Alt and an arrow move a list item with the items below it', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Moving.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.getByText('Two', { exact: true }).click()
  const saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await page.keyboard.press('Alt+ArrowDown')
  await saved
  // The paragraph above, with its odd spaces, is written as it was.
  await expect.poll(disk).toBe('# Moving\n\nKeep  this   line as it is.\n\n- One\n- Three\n- Two\n  - Two a\n')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  expect(problems).toEqual([])
})
