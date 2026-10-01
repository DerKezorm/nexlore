/** Views over notes, as Obsidian's Bases: a .base file as table and board, cells written back, a code block. */
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
test.describe.configure({ mode: 'serial' })

test('a .base file shows its notes, sorted with formulas; a cell changes the note, a card moves on the board', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/file/Zyx/Kitchen/Recipes.base')
  const table = page.getByTestId('base-table')
  await expect(table.locator('tbody tr')).toHaveCount(3)
  await expect(table.locator('tbody tr td:first-child')).toHaveText(['Shakshuka', 'Soup', 'Bread'])
  await expect(table.locator('tbody tr').nth(2)).toContainText('12')
  // A cell: typed, Enter, written into the note.
  await table.locator('tbody tr').nth(1).locator('td').nth(2).locator('span').click()
  await page.getByLabel('Value of note.status').fill('favourite')
  await page.keyboard.press('Enter')
  await expect(table.locator('tbody tr').nth(1)).toContainText('favourite')
  await page.goto('/note/Zyx/Kitchen/Soup.md')
  await expect(page.locator('article')).toContainText('Soup')
  const soup = await (await page.request.get('/api/note', { params: { path: 'Zyx/Kitchen/Soup.md' } })).json()
  expect(soup.content).toBe('---\ntags: [recipe]\nminutes: 45\nstatus: favourite\n---\n# Soup\n')
  // The board: a card dragged to another column takes its value.
  await page.goto('/file/Zyx/Kitchen/Recipes.base')
  await page.getByRole('tab', { name: 'Board' }).click()
  const board = page.getByTestId('base-board')
  await expect(board.getByRole('region')).toHaveCount(3)
  await board.getByRole('region', { name: 'planned' }).getByTestId('base-card').dragTo(board.getByRole('region', { name: 'tried' }))
  await expect(board.getByRole('region', { name: 'tried' }).getByTestId('base-card')).toHaveCount(2)
  await expect(board.getByRole('region', { name: 'planned' })).toHaveCount(0)
  expect(problems).toEqual([])
})

test('the YAML of a view is edited in place, and a base code block shows in the note', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/file/Zyx/Kitchen/Recipes.base')
  await page.getByRole('button', { name: 'Edit the YAML' }).click()
  const yaml = page.getByLabel('YAML of the view')
  await yaml.fill((await yaml.inputValue()).replace('type: table', 'type: cards'))
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('base-cards').getByTestId('base-card')).toHaveCount(3)
  await page.goto('/note/Zyx/Kitchen/Overview.md')
  const list = page.locator('article').getByTestId('base-list')
  await expect(list.getByRole('button')).toHaveText(['Shakshuka', 'Soup'])
  await list.getByRole('button', { name: 'Soup' }).click()
  await expect(page).toHaveURL(/\/note\/Zyx\/Kitchen\/Soup\.md$/)
  expect(problems).toEqual([])
})

test('a new view is made from the folder menu and lists the notes of the folder', async ({ page }) => {
  await page.goto('/note/Zyx/Kitchen/Soup.md')
  const tree = page.getByTestId('sidebar-tree')
  await tree.getByRole('button', { name: /^Kitchen( \d+)?$/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New view …' }).click()
  await page.getByTestId('name-dialog').getByRole('textbox').fill('Mine')
  await page.getByTestId('name-dialog').getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/file\/Zyx\/Kitchen\/Mine\.base$/)
  await expect(page.getByTestId('base-table').locator('tbody tr')).toHaveCount(4)
  await expect(tree.getByRole('button', { name: 'Mine' })).toBeVisible()
})
