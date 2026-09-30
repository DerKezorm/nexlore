/**
 * Callouts in a theme: every kind has a symbol before its title; a theme gives a kind of its own a colour and a
 * symbol, while reading and while writing, and its editor adds such a kind.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-callout' }
let made: number | null = null

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const before = (element: Locator, property: string) =>
  element.evaluate((node, name) => getComputedStyle(node, '::before').getPropertyValue(name), property)

test.afterEach(async ({ page }) => {
  // The account is shared: back to nexlore's own theme, and the one made here goes.
  await page.waitForLoadState('networkidle')
  await page.request.put('/api/me/appearance', { data: { theme: 'nexlore' }, headers: TAB })
  if (made !== null) await page.request.delete(`/api/themes/${made}`, { headers: TAB })
  made = null
})

test('a kind of callout of the theme\'s own has its colour and symbol, reading and writing', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const theme = await page.request.post('/api/themes', {
    data: { name: 'Kitchen', colours: { callouts: { recipe: { dark: '#ff8800', light: '#aa5500', icon: 'cooking' } } } },
    headers: TAB,
  })
  expect(theme.ok()).toBe(true)
  made = (await theme.json()).id
  await page.request.put('/api/me/appearance', { data: { theme: `t:${made}` }, headers: TAB })

  await page.goto('/note/Heath/Callouts.md')
  const recipe = page.locator('article .nn-callout-recipe')
  await expect(recipe).toHaveCSS('border-left-color', 'rgb(255, 136, 0)')
  const title = recipe.locator('.nn-callout-title')
  expect(await before(title, 'mask-image')).toContain('data:image/svg+xml')
  expect(await before(title, 'background-color')).toBe('rgb(255, 136, 0)')
  // A kind of Obsidian keeps its own symbol, another than the recipe's.
  const warning = page.locator('article .nn-callout-warning .nn-callout-title')
  expect(await before(warning, 'mask-image')).toContain('data:image/svg+xml')
  const recipeSymbol = await before(title, 'mask-image')
  expect(await before(warning, 'mask-image')).not.toBe(recipeSymbol)

  // While writing, the label of the kind shows the same.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const label = page.locator('.ProseMirror .nx-callout-recipe .nx-callout-label')
  await expect(label).toBeVisible()
  expect(await before(label, 'background-color')).toBe('rgb(255, 136, 0)')
  expect(await before(label, 'mask-image')).toBe(recipeSymbol)
  await page.getByRole('button', { name: 'Read', exact: true }).click()

  // The theme's editor lists the kind and adds another.
  await page.goto('/settings?tab=looks')
  await page.getByTestId('themes').locator(`[data-theme-ref="t:${made}"]`).locator('xpath=..').getByRole('button', { name: 'Change' }).click()
  const callouts = page.getByTestId('theme-callouts')
  await expect(callouts.locator('[data-kind="recipe"]')).toBeVisible()
  await callouts.getByLabel('Kind of callout').fill('Shop')
  await callouts.getByRole('button', { name: 'Add' }).click()
  await expect(callouts.locator('[data-kind="shop"]')).toBeVisible()
  expect(problems).toEqual([])
})
