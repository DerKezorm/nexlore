/**
 * The command palette on Ctrl+P and what the quick switcher on Ctrl+K learned: aliases, making a note of the name
 * typed, the headings of the note in front after "#".
 */
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

test('the palette runs the commands of the app, the note and the editor', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article')).toContainText('The end.')
  // The own right in the space is known once the spaces are loaded; the palette offers what it allows.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
  const palette = page.getByRole('dialog', { name: 'Commands' })
  await page.keyboard.press('ControlOrMeta+p')
  await expect(palette).toBeVisible()
  await page.keyboard.type('edit the')
  await expect(palette.getByRole('option')).toHaveText([/Edit the note/])
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // While writing (the editor loads a moment later), its formats are there too, with their keys.
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('bold')
  await expect(palette.getByRole('option').first()).toContainText('Bold')
  await expect(palette.getByRole('option').first()).toContainText('Editor')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('stop editing')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // A place of the app; the command used last comes first next time.
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('go to calendar')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/calendar$/)
  await page.keyboard.press('ControlOrMeta+p')
  await expect(palette.getByRole('option').first()).toContainText('Go to Calendar')
  await page.keyboard.type('zzzz')
  await expect(palette).toContainText('No command fits.')
  await page.keyboard.press('Escape')
  expect(problems).toEqual([])
})

test('the quick switcher finds a note by its alias, lists the headings after # and makes a note of the name typed', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article')).toContainText('The end.')
  const switcher = page.getByRole('dialog', { name: 'Search' })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('command de')
  const alias = switcher.getByRole('button', { name: /Palette/ }).first()
  await expect(alias).toContainText('as “Command deck”')
  // The headings of the note in front, found by a word; choosing one scrolls there.
  await page.getByPlaceholder(/Search/).fill('#far')
  await expect(switcher.getByRole('list').getByRole('button')).toHaveText([/Far down/])
  await expect(page.getByRole('heading', { name: 'Far down' })).not.toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(switcher).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Far down' })).toBeInViewport()
  // No note of that name: the last row makes it, in the folder of the note in front.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Made from the switcher')
  const make = switcher.getByRole('button', { name: /Make the note “Made from the switcher”/ })
  await expect(make).toContainText('New in Zyx')
  await make.click()
  await expect(page).toHaveURL(/\/note\/Zyx\/Made%20from%20the%20switcher\.md$/)
  // Now it is there: the switcher offers it instead of making it again; Shift+Enter makes nothing twice either.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Made from the switcher')
  await expect(switcher.getByRole('button', { name: /Made from the switcher/ }).first()).toContainText('Zyx')
  await expect(switcher.getByRole('button', { name: /Make the note/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(problems).toEqual([])
})

test('a slash in the quick switcher finds folders; the sidebar opens, scrolls to and focuses the one chosen', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const switcher = page.getByRole('dialog', { name: 'Search' })
  const tree = page.getByTestId('sidebar-tree')
  const kitchen = tree.getByRole('button', { name: /^Kitchen( \d+)?$/ })
  // From a page without a sidebar: to the map, where the sidebar shows it (Zyx comes last, far below).
  await page.goto('/calendar')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.keyboard.type('/kitch')
  await expect(switcher.getByRole('list').getByRole('button')).toHaveText([/Kitchen\s*Zyx/])
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/(\?folder=Zyx%2FKitchen)?$/)
  await expect(kitchen).toBeFocused()
  await expect(kitchen).toHaveAttribute('aria-expanded', 'true')
  await expect(kitchen).toBeInViewport()
  // On a note, with the tags in front: the sidebar turns to the spaces for it.
  await page.goto('/note/Zyx/Palette.md')
  await page.getByRole('tab', { name: 'Tags' }).click()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.keyboard.type('/zyx')
  await expect(switcher.getByRole('list').getByRole('button').first()).toHaveText(/Zyx\s*Space/)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'Spaces' })).toHaveAttribute('aria-selected', 'true')
  await expect(tree.getByRole('button', { name: /^Zyx( \d+)?$/ })).toBeFocused()
  // No folder of the name.
  await page.keyboard.press('ControlOrMeta+k')
  // Typed only once the field has the keys: before, the letters went nowhere (seen in a full run).
  await expect(switcher.locator('input')).toBeFocused()
  await page.keyboard.type('/qqqq')
  await expect(switcher).toContainText('No folder of that name.')
  await expect(switcher.getByRole('button', { name: /Make the note/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(problems).toEqual([])
})

test('the search page takes operators, shows the lines a note was found in, and its filters write the search', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article')).toContainText('The end.')
  // From the quick switcher to all hits.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('quinceapple')
  await page.getByRole('button', { name: 'All hits on the search page' }).click()
  await expect(page).toHaveURL(/\/search\?q=quinceapple$/)
  const shopping = page.getByTestId('search-page').getByRole('listitem').filter({ hasText: 'Shopping' })
  await expect(shopping).toContainText('Milk, flour and quinceapple jam.')
  await expect(shopping.locator('mark')).toHaveText('quinceapple')
  // A filter writes into the search; a chip takes a piece out again.
  await page.getByTestId('search-page').getByLabel('Home', { exact: true }).click()
  await expect(page.getByTestId('search-page').getByLabel('Home', { exact: true })).toBeChecked()
  await expect(page).toHaveURL(/q=quinceapple\+space%3AHome$/)
  await expect(shopping).toBeVisible()
  await page.getByRole('button', { name: 'Take “quinceapple” out' }).click()
  await expect(page).toHaveURL(/q=space%3AHome$/)
  await expect(page.getByTestId('search-page').getByRole('link', { name: /^50% C# done/ })).toBeVisible()
  // Typed with operators, and Ctrl+Shift+F from anywhere.
  await page.goto('/tasks')
  await expect(page.getByTestId('tasks-page')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await expect(page).toHaveURL(/\/search$/)
  await page.getByLabel('Search with operators').fill('tag:sown -nothing')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('search-page').getByRole('link', { name: 'Sown Zoo' })).toBeVisible()
  await page.getByRole('button', { name: 'How to search' }).click()
  await expect(page.getByTestId('search-help')).toContainText('[status:open]')
  expect(problems).toEqual([])
})
