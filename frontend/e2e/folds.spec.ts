/**
 * Folding: a heading or a list item folded while reading stays folded after a reload and while writing, "fold all"
 * and "unfold all" from the palette, and the file never changes.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const NOTE = 'Heath/Folded.md'
const onDisk = () => fs.readFileSync(path.join(DATA, 'vault', ...NOTE.split('/')), 'utf-8')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function palette(page: Page, words: string, name: RegExp) {
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type(words)
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('button', { name }).first().click()
}

test('folds while reading stay after a reload and while writing, and the file stays as it was', async ({ page }) => {
  const problems = collectProblems(page)
  const before = onDisk()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Folded.md')
  const article = page.locator('article')
  await expect(article.getByText('First text.')).toBeVisible()

  // A heading: what follows it up to the next one as high goes.
  const words = page.getByTestId('word-count')
  await expect(words).toHaveText(/\d+ words/)
  const counted = await words.textContent()
  await article.getByRole('heading', { name: 'One' }).hover()
  await article.getByRole('button', { name: 'Fold “One”' }).click()
  await expect(article.getByText('First text.')).toBeHidden()
  // Folded words are the note's words all the same.
  await page.reload()
  await expect(words).toHaveText(counted!)
  await expect(article.getByText('First text.')).toBeHidden()
  await expect(article.getByText('Deep text.')).toBeHidden()
  await expect(article.getByText('Second text.')).toBeVisible()
  // A list item: its items go, the item stays.
  await article.getByRole('button', { name: 'Fold “Parent”' }).click()
  await expect(article.getByText('Child one')).toBeHidden()
  await expect(article.getByText('Parent')).toBeVisible()

  // Still folded after a reload, and in the editor too.
  await page.reload()
  await expect(article.getByText('Second text.')).toBeVisible()
  await expect(article.getByText('First text.')).toBeHidden()
  await expect(article.getByText('Child one')).toBeHidden()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await expect(editor.getByText('Second text.')).toBeVisible()
  await expect(editor.getByText('First text.')).toBeHidden()
  await expect(editor.locator('[data-fold="h2:One#0"]')).toHaveAttribute('aria-expanded', 'false')
  // Unfolded while writing: open while reading as well.
  await editor.locator('[data-fold="h2:One#0"]').click()
  await expect(editor.getByText('First text.')).toBeVisible()
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(article.getByText('First text.')).toBeVisible()

  // Everything at once, from the palette.
  await palette(page, 'fold all', /^Fold all headings and lists/)
  await expect(article.getByText('Second text.')).toBeHidden()
  await expect(article.getByRole('heading', { name: 'Folded' })).toBeVisible()
  await palette(page, 'unfold all', /^Unfold all/)
  await expect(article.getByText('Deep text.')).toBeVisible()
  await expect(article.getByText('Child two')).toBeVisible()
  expect(onDisk()).toBe(before)
  expect(problems).toEqual([])
})
