/** How nexlore looks for the account: fonts, size, width, light or dark; kept with the account, applied everywhere. */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('the look is chosen under settings, shows at once, and comes back with the account in a new browser', async ({ page, browser }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings?tab=looks')
  const card = page.getByTestId('appearance')
  await card.getByRole('radio', { name: /Literata/ }).click()
  await card.getByRole('radiogroup', { name: 'Width of the text' }).getByRole('radio', { name: 'Narrow' }).click()
  // Saved behind what is shown: leaving the page before the answer (a slow CI machine did) would read the old look.
  const saved = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().postData()?.includes('"size":18') === true)
  await card.getByLabel('Text size').fill('18')
  const sample = page.getByTestId('appearance-sample')
  await expect(sample).toHaveCSS('font-size', '18px')
  await expect.poll(() => sample.evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Literata')
  // A note: the same letters, size and width; the font's files came from nexlore itself.
  await saved
  await page.goto('/note/Zyx/Palette.md')
  const prose = page.locator('article.nn-prose')
  await expect(prose).toHaveCSS('font-size', '18px')
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Literata Variable"'))).toBe(true)
  const body = page.getByTestId('note-body')
  expect(await body.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(36 * 16 + 5.5 * 16 + 1)
  // A note that asks to be wide with cssclasses gets the classes, and the width of the window.
  await page.goto('/note/Zyx/Wide.md')
  await expect(body).toHaveClass(/\bwide\b/)
  await expect(body).toHaveClass(/\bmy-look\b/)
  expect(await body.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(700)
  // Another browser, the same account: the look travels with it; "as the system" follows the device.
  const state = await page.context().storageState()
  const other = await browser.newContext({ storageState: state, colorScheme: 'light', viewport: { width: 1440, height: 900 } })
  const second = await other.newPage()
  await second.goto('/settings?tab=looks')
  await expect(second.getByTestId('appearance').getByRole('radio', { name: /Literata/ })).toHaveAttribute('aria-checked', 'true')
  await second.getByTestId('appearance').getByRole('radio', { name: 'As the system' }).click()
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light')
  await other.close()
  // Back to how it was, for the other tests.
  await page.goto('/settings?tab=looks')
  const again = page.getByTestId('appearance')
  await again.getByRole('radio', { name: 'Dark' }).click()
  await again.getByRole('radiogroup', { name: 'Text of notes' }).getByRole('radio', { name: /Inter/ }).click()
  await again.getByRole('radiogroup', { name: 'Width of the text' }).getByRole('radio', { name: 'Normal' }).click()
  await again.getByLabel('Text size').fill('16')
  await expect(page.getByTestId('appearance-sample')).toHaveCSS('font-size', '16px')
  expect(problems).toEqual([])
})
