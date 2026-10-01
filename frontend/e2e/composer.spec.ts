/**
 * The note composer: chosen words into a note of their own with a link in their place, and a note merged into
 * another (its text at the end, links to it following, it into the trash).
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const disk = (rel: string) => path.join(DATA, 'vault', ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(disk(rel), 'utf-8')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('chosen words go into a note of their own, a link in their place', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Extract.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.getByText('Move these words away.').click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await editor.getByText('Move these words away.').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Into a new note' }).click()
  const dialog = page.getByRole('dialog', { name: 'The chosen words into a note of their own' })
  await expect(dialog.getByLabel('Name of the new note')).toHaveValue('Move these words away.')
  await dialog.getByLabel('Name of the new note').fill('Moved away')
  const saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await saved
  await expect.poll(() => read('Heath/Extract.md')).toBe('# Extract\n\nKeep this.\n\n[[Moved away]]\n')
  expect(read('Heath/Moved away.md')).toBe('Move these words away.\n')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.locator('article a.nn-wikilink', { hasText: 'Moved away' })).toBeVisible()
  expect(problems).toEqual([])
})

test('a note merged into another: its text at the end, links follow, it goes', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Merge%20from.md')
  await expect(page.locator('article')).toContainText('From words.')
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: 'Merge with another note …' }).click()
  const dialog = page.getByTestId('merge-dialog')
  await dialog.getByLabel('Find the note by its name').first().fill('Merge into')
  await dialog.getByRole('option', { name: /Merge into/ }).click()
  await expect(dialog.getByTestId('merge-explain')).toContainText('“Merge from” goes to the end of “Merge into”')
  await dialog.getByRole('button', { name: 'Merge' }).click()
  await expect(page).toHaveURL(/\/note\/Heath\/Merge%20into\.md$/)
  await expect(page.locator('article')).toContainText('From words.')
  expect(read('Heath/Merge into.md')).toBe('# Merge into\n\nInto words.\n\n# Merge from\n\nFrom words.\n')
  expect(read('Heath/Merge link.md')).toBe('See [[Merge into]].\n')
  expect(fs.existsSync(disk('Heath/Merge from.md'))).toBe(false)
  expect(problems).toEqual([])
})
