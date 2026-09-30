/**
 * The map and the folder dots take their colours from the theme: another accent turns the hues, and a change of
 * theme draws the map again at once, without a reload.
 */
import { expect, test, type Page } from '@playwright/test'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function chooseTheme(page: Page, ref: string): Promise<void> {
  const themes = page.getByTestId('themes')
  const saved = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().method() === 'PUT')
  await themes.locator(`[data-theme-ref="${ref}"]`).click()
  await saved
  await expect(themes.locator(`[data-theme-ref="${ref}"]`)).toHaveAttribute('aria-pressed', 'true')
}

/** Hue of a colour `#rrggbb` or `rgb(r, g, b)`, in degrees. */
function hue(colour: string): number {
  const parts = colour.startsWith('#')
    ? [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16))
    : colour.match(/\d+/g)!.slice(0, 3).map(Number)
  const [r, g, b] = parts.map((part) => part / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}

const turned = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

test.afterEach(async ({ page }) => {
  // The account is shared: back to nexlore's own theme.
  await page.goto('/settings?tab=looks')
  await chooseTheme(page, 'nexlore')
})

test('the map and the dots of the sidebar follow the theme', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const map = page.locator('canvas[data-colours]')
  await expect(map).toHaveAttribute('data-colours', /#/)
  const before = (await map.getAttribute('data-colours'))!.split(' ')
  const dot = page.getByRole('button', { name: /^Heath/ }).locator('span').first()
  const dotBefore = await dot.evaluate((element) => getComputedStyle(element).backgroundColor)

  // A theme with a plum accent, chosen in the settings; the map is drawn again as soon as it is back.
  await page.goto('/settings?tab=looks')
  await chooseTheme(page, 'plum')
  await page.getByRole('link', { name: /Graph/ }).first().click()
  // Drawn once the spaces are there again (an empty list before).
  await expect.poll(() => map.getAttribute('data-colours')).toMatch(/^#/)
  const after = (await map.getAttribute('data-colours'))!.split(' ')
  expect(after).toHaveLength(before.length)
  const turn = turned(hue('#e879f9'), hue('#2dd4bf'))
  for (const [index, colour] of after.entries()) expect(turned(hue(colour), hue(before[index]))).toBeGreaterThan(turn - 5)
  const dotAfter = await dot.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(turned(hue(dotAfter), hue(dotBefore))).toBeGreaterThan(turn - 5)

  // Light and dark switched on the map itself: drawn again without leaving it.
  const dark = await map.getAttribute('data-colours')
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light')
    window.dispatchEvent(new Event('nexlore-theme'))
  })
  await expect(map).not.toHaveAttribute('data-colours', dark!)
  // The dots of the sidebar beside it as well.
  await expect.poll(() => dot.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(dotAfter)
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme')
    window.dispatchEvent(new Event('nexlore-theme'))
  })
  await expect(map).toHaveAttribute('data-colours', dark!)
  expect(problems).toEqual([])
})
