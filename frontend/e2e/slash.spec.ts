/**
 * The slash menu: headings down to six and a picture of its own, and the entries used most come first in their group
 * (counted in this browser).
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const NOTE = 'Heath/Slashed.md'
const onDisk = () => fs.readFileSync(path.join(DATA, 'vault', ...NOTE.split('/')), 'utf-8')
const TAB = { 'X-Nexlore-Client': 'tab-e2e-slash0' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.beforeEach(async ({ page }) => {
  // A second try finds the note as the first one left it: back to its start.
  const now = await (await page.request.get('/api/note?path=' + encodeURIComponent(NOTE))).json()
  if (now.content !== '# Slashed\n\nFirst line.\n') {
    const put = await page.request.put('/api/note', { data: { path: NOTE, content: '# Slashed\n\nFirst line.\n', base_hash: now.hash }, headers: TAB })
    expect(put.ok()).toBe(true)
  }
})

test('the slash menu offers headings to six and a picture, and puts the entries used most first', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Slashed.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.getByText('First line.').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const menu = page.locator('.milkdown-slash-menu')
  await expect(menu).toBeVisible()
  for (const name of ['Heading 4', 'Heading 5', 'Heading 6', 'Picture']) await expect(menu.getByText(name, { exact: true })).toBeVisible()
  const firstOfText = () => menu.locator('.menu-group').first().locator('li[data-index]').first()
  await expect(firstOfText()).toHaveText(/[^a-z]Text$/)

  // A picture of its own: the picker takes pictures only.
  const chooser = page.waitForEvent('filechooser')
  await menu.getByText('Picture', { exact: true }).click()
  expect(await (await chooser).element().getAttribute('accept')).toBe('image/*')

  // Heading 4 by typing its name; it is written with four hashes.
  await page.keyboard.type('/heading 4')
  await expect(menu.getByText('Heading 4', { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  const saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await page.keyboard.type('Fourth')
  await saved
  await expect.poll(onDisk).toContain('\n#### Fourth\n')

  // Used once, Heading 4 now leads its group.
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await expect(menu).toBeVisible()
  await expect(firstOfText()).toHaveText(/Heading 4$/)
  await page.keyboard.press('Escape')
  expect(problems).toEqual([])
})
