/**
 * The cover flow: opened from the header at the folder of the open note, flipped with keys and letters, a folder
 * opened, a note read, a cover set from a drawn motif (kept as a hidden file in the folder), and Escape going up level
 * by level until it closes.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickRow } from './tree'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const centre = (page: Page) => page.locator('[data-testid="cover-card"][data-center]')

/** The cards glide for half a second; a click before they stand lands on the card moving under the pointer (and a
 * click on the middle card opens it), so a click on something on a card waits until nothing moves. */
async function standing(page: Page) {
  await expect.poll(() => page.getByTestId('coverflow').evaluate((flow) => flow.getAnimations({ subtree: true }).length)).toBe(0)
}

test('flips through a folder, reads a note, sets a cover and goes back up level by level', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Zz%20shelf/Alpha%20shelf.md')
  await expect(page.getByRole('heading', { name: 'Alpha shelf' }).first()).toBeVisible()
  await page.getByTestId('open-coverflow').click()
  const flow = page.getByTestId('coverflow')
  await expect(flow).toBeVisible()
  // Where the open note lies: its folder, with its subfolder first, then its notes by name.
  await expect(flow.locator('[aria-current="location"]')).toHaveText('Zz shelf')
  await expect(page.getByTestId('cover-card')).toHaveCount(3)
  await expect(centre(page)).toHaveAttribute('aria-label', 'Records')

  await page.keyboard.press('ArrowRight')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Alpha shelf')
  // A little of its text as words, without its title and without the marks of Markdown.
  await expect(centre(page)).toContainText('First words of the alpha shelf, bold and plain.')

  await page.keyboard.press('Enter')
  const reader = flow.getByRole('document')
  await expect(reader.locator('strong', { hasText: 'bold' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(reader).toHaveCount(0)

  // A letter jumps as on a shelf of records.
  await page.keyboard.press('b')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Beta shelf')

  // A cover from a drawn motif: it lands as a hidden file in the folder and stands on the card.
  await page.keyboard.press('Home')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Records')
  await standing(page)
  await centre(page).getByRole('button', { name: 'Change the cover' }).click()
  const picker = page.getByRole('dialog', { name: 'Cover for “Records”' })
  await picker.getByRole('button', { name: 'Mountains' }).click()
  const saved = page.waitForResponse((answer) => answer.url().includes('/api/cover?') && answer.request().method() === 'PUT')
  await picker.getByRole('button', { name: 'Save' }).click()
  expect((await saved).status()).toBe(200)
  await expect(picker).toHaveCount(0)
  await expect(centre(page).locator('.nn-cf-cover').first()).toHaveAttribute('style', /\/api\/cover\?path=Zoo%2FZz%20shelf%2FRecords/)
  expect(fs.existsSync(path.join(DATA, 'vault', 'Zoo', 'Zz shelf', 'Records', '.cover.webp'))).toBe(true)

  // Into the folder and back out: one comes back to the card of the folder one left.
  await page.keyboard.press('Enter')
  await expect(flow.locator('[aria-current="location"]')).toHaveText('Records')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Old record')
  await page.keyboard.press('Escape')
  await expect(flow.locator('[aria-current="location"]')).toHaveText('Zz shelf')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Records')
  await page.keyboard.press('Escape')
  await expect(flow.locator('[aria-current="location"]')).toHaveText('Zoo')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Zz shelf')
  await page.keyboard.press('Escape')
  await expect(centre(page)).toHaveAttribute('aria-label', 'Zoo')
  await page.keyboard.press('Escape')
  await expect(flow).toHaveCount(0)

  // Gone again, so a later run starts as this one did.
  fs.rmSync(path.join(DATA, 'vault', 'Zoo', 'Zz shelf', 'Records', '.cover.webp'), { force: true })
  expect(problems).toEqual([])
})

test('a folder of the sidebar opens as cover flow from its menu', async ({ page }) => {
  await page.goto('/note/Zoo/Zz%20shelf/Beta%20shelf.md')
  await clickRow(page, 'Zz shelf', { button: 'right' })
  await page.getByRole('menuitem', { name: 'Show as cover flow' }).click()
  await expect(page.getByTestId('coverflow').locator('[aria-current="location"]')).toHaveText('Zz shelf')
})
