/**
 * The line under a note: words and characters of what is shown (embedded notes left out), counted again while
 * typing, and those of the words chosen.
 */
import { expect, test, type Page } from '@playwright/test'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('the words of a note are counted while reading and writing, and those chosen', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const line = page.getByTestId('word-count')

  // An embedded note does not count: "Counted embed" and "Two words".
  await page.goto('/note/Heath/Counted%20embed.md')
  await expect(page.locator('article .nn-embedded-body')).toContainText('Five words')
  await expect(line).toHaveText('4 words · 23 characters')

  // "Counted" and "Five words stand here now." (7 and 26 characters).
  await page.goto('/note/Heath/Counted.md')
  await expect(line).toHaveText('6 words · 33 characters')
  await page.locator('article p').evaluate((paragraph) => {
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await expect(line).toHaveText('Selected: 5 words · 26 characters')

  // While writing: counted again as words come.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await expect(editor).toContainText('Five words')
  await expect(line).toHaveText('6 words · 33 characters')
  await editor.getByText('Five words stand here now.').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' One more')
  await expect(line).toHaveText('8 words · 42 characters')
  // Back as it was, so the next run finds the note unchanged.
  for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace')
  await expect(line).toHaveText('6 words · 33 characters')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.locator('article p')).toHaveText('Five words stand here now.')
  expect(problems).toEqual([])
})
