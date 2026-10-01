/**
 * Favorites beyond notes and folders: a heading kept from the outline opens its note scrolled there, a search kept on
 * the search page opens it again, and favorites sit in groups chosen from their menu.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-marks0' }
const HEADING = 'Heath/Marked.md#Far below'
const SEARCH = '?heather'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.afterEach(async ({ page }) => {
  // The account is shared: its favorites and the column's tab as they were.
  await page.waitForLoadState('networkidle')
  for (const path of [HEADING, SEARCH]) await page.request.put('/api/favorites', { data: { path, on: false }, headers: TAB })
  await page.request.put('/api/me/appearance', { data: { panel: true, panel_tab: 'links' }, headers: TAB })
})

test('a heading and a search are kept as favorites, open where they were, and sit in a group', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/note/Heath/Marked.md')
  await page.getByTestId('note-panel').getByRole('tab', { name: 'Outline' }).click()
  const outline = page.getByTestId('outline')
  const kept = page.waitForResponse((response) => response.url().endsWith('/api/favorites') && response.request().method() === 'GET')
  await outline.getByRole('button', { name: 'Add “Far below” to the favorites' }).click()
  await kept
  await expect(outline.getByRole('button', { name: 'Remove “Far below” from the favorites' })).toHaveAttribute('aria-pressed', 'true')
  const favorites = page.getByTestId('sidebar-favorites')
  const heading = favorites.locator(`[data-favorite="${HEADING}"]`)
  await expect(heading).toContainText('Far below')

  // From another note: the heading's note opens, scrolled to it.
  await page.goto('/note/Heath/Heather.md')
  await heading.getByRole('button').click()
  await expect(page).toHaveURL(/\/note\/Heath\/Marked\.md#Far%20below$/)
  await expect(page.locator('article').getByRole('heading', { name: 'Far below' })).toBeInViewport()

  // A search kept on the search page, opened again from the sidebar.
  await page.goto('/search?q=heather')
  const star = page.getByTestId('search-favorite')
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/note/Heath/Heather.md')
  const search = favorites.locator(`[data-favorite="${SEARCH}"]`)
  await expect(search).toContainText('heather')
  await search.getByRole('button').click()
  await expect(page).toHaveURL(/\/search\?q=heather$/)

  // Into a group of their own, from the menu: a new one, then the second into the same.
  await page.goto('/note/Heath/Heather.md')
  await heading.getByRole('button').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Group' }).click()
  await page.getByRole('menuitem', { name: 'New group …' }).click()
  const dialog = page.getByRole('dialog', { name: 'A group for “Far below”' })
  await dialog.getByLabel('Name of the group').fill('Reading  list')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(favorites.getByTestId('favorite-group')).toHaveText(['Reading list'])
  await search.getByRole('button').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Group' }).click()
  await page.getByRole('menuitem', { name: 'Reading list' }).click()
  // Both under the group's name, after the favorites without one.
  const order = () => favorites.locator('li').evaluateAll((items) => items.map((item) => item.getAttribute('data-favorite') ?? `group:${item.textContent}`))
  await expect.poll(async () => (await order()).slice(-3)).toEqual(['group:Reading list', HEADING, SEARCH])
  expect(problems).toEqual([])
})
