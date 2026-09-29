/**
 * Find and replace in the editor: Ctrl+F opens the bar with the chosen words, counts and steps through the hits,
 * Ctrl+H replaces one or all, Escape puts the caret on the hit. The file changes only where words were replaced.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

async function edit(page: Page, note: string) {
  await page.goto(`/note/${note}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.ProseMirror')).toBeFocused()
}

const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 })

test('Ctrl+F counts and steps through the hits, Ctrl+H replaces one and then all, and only those lines change', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  await edit(page, 'Zoo/Find.md')
  await page.keyboard.press('Control+f')
  const bar = page.getByTestId('find-bar')
  const field = bar.getByTestId('find-input')
  await expect(field).toBeFocused()
  await field.fill('cat')
  const count = bar.getByTestId('find-count')
  // The code block is left out: its text is drawn by CodeMirror.
  await expect(count).toHaveText('1 of 3')
  await expect(page.locator('.ProseMirror .nx-find')).toHaveCount(3)
  await field.press('Enter')
  await expect(count).toHaveText('2 of 3')
  await field.press('Shift+Enter')
  await expect(count).toHaveText('1 of 3')
  await field.press('Shift+Enter')
  await expect(count).toHaveText('3 of 3')
  await bar.getByRole('button', { name: 'Match case' }).click()
  await expect(count).toHaveText('1 of 2')
  await bar.getByRole('button', { name: 'Match case' }).click()
  await field.fill('nothing like it')
  await expect(count).toHaveText('No results')
  await field.fill('cat')
  await expect(count).toHaveText('1 of 3')

  await field.press('Control+h')
  const replacement = bar.getByTestId('replace-input')
  await expect(replacement).toBeFocused()
  await replacement.fill('dog')
  await replacement.press('Enter')
  await expect(count).toHaveText('1 of 2')
  await saved(page)
  await expect.poll(() => onDisk('Zoo/Find.md'), { timeout: 10_000 }).toBe('# Find\n\nThe dog sat.\n\nA *Cat* and a cat.\n\nUntouched   spacing  here.\n\n```\ncat in code\n```\n')

  await bar.getByRole('button', { name: 'Replace all' }).click()
  await expect(bar.getByRole('status')).toHaveText('Replaced 2 matches.')
  await expect(count).toHaveText('No results')
  await saved(page)
  await expect.poll(() => onDisk('Zoo/Find.md'), { timeout: 10_000 }).toBe('# Find\n\nThe dog sat.\n\nA *dog* and a dog.\n\nUntouched   spacing  here.\n\n```\ncat in code\n```\n')
  expect(problems).toEqual([])
})

test('the chosen words go into the field, F3 steps on, and Escape puts the caret on the hit', async ({ page }) => {
  await edit(page, 'Zoo/Find keys.md')
  // "fox" chosen in the text, as a double click would.
  await page.locator('.ProseMirror').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf('fox')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 3)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      return
    }
  })
  await page.keyboard.press('Control+f')
  const bar = page.getByTestId('find-bar')
  await expect(bar.getByTestId('find-input')).toHaveValue('fox')
  await expect(bar.getByTestId('find-count')).toHaveText('1 of 3')
  await page.keyboard.press('F3')
  await expect(bar.getByTestId('find-count')).toHaveText('2 of 3')
  // F3 in the text too, while the bar is open.
  await page.locator('.ProseMirror h1').click()
  await expect(page.locator('.ProseMirror')).toBeFocused()
  await page.keyboard.press('F3')
  await expect(bar.getByTestId('find-count')).toHaveText('3 of 3')
  await bar.getByTestId('find-input').press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(page.locator('.ProseMirror')).toBeFocused()
  await expect(page.locator('.ProseMirror .nx-find')).toHaveCount(0)
  // Typing replaces the third "fox", where the search stood.
  await page.keyboard.type('cat')
  await saved(page)
  await expect.poll(() => onDisk('Zoo/Find keys.md'), { timeout: 10_000 }).toBe('# Find keys\n\nOne fox, two fox, three cat.\n')

  // Reading, the browser's own search stays: no bar.
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('find-bar')).toHaveCount(0)
})
