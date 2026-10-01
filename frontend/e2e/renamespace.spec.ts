/**
 * Renaming a space (block Y2) from the menu of its row: the open note follows, the sidebar shows the new name, and a
 * link in another space that names it in front follows on disk. Made here and put away at the end: other tests share
 * the account and its spaces.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-renamespace' }

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function row(page: Page, name: string) {
  return page.getByTestId('sidebar-tree').getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) })
}

async function shownRow(page: Page, name: string) {
  const tree = page.getByTestId('sidebar-tree')
  const button = row(page, name)
  await expect(tree.getByRole('listitem').first()).toBeVisible()
  for (let step = 0; step < 40 && !(await button.isVisible()); step++) {
    await tree.evaluate((element) => element.scrollBy(0, element.clientHeight / 2))
    await page.waitForTimeout(50)
  }
  return button
}

test('a manager renames a space from its menu, and what names it follows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  for (const name of ['Zz Old field', 'Zz Elsewhere']) {
    expect((await page.request.post('/api/spaces', { data: { name }, headers: TAB })).status()).toBe(201)
  }
  expect((await page.request.post('/api/notes', { data: { folder: 'Zz Old field', title: 'Corn', content: 'Rows of corn.\n' }, headers: TAB })).status()).toBe(201)
  expect((await page.request.post('/api/notes', { data: { folder: 'Zz Elsewhere', title: 'Note', content: 'See [[Zz Old field/Corn]].\n' }, headers: TAB })).status()).toBe(201)
  try {
    await page.goto('/note/Zz Old field/Corn.md')
    await expect(page.locator('article')).toContainText('Rows of corn.')
    await (await shownRow(page, 'Zz Old field')).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename …' }).click()
    const naming = page.getByTestId('name-dialog')
    await expect(naming).toContainText('Links that name the space in front')
    await naming.getByLabel('Name').fill('Zz New field')
    await naming.getByRole('button', { name: 'Rename' }).click()
    await expect(page).toHaveURL(/\/note\/Zz%20New%20field\/Corn\.md$/)
    await expect(page.locator('article')).toContainText('Rows of corn.')
    await expect(await shownRow(page, 'Zz New field')).toBeVisible()
    await expect(row(page, 'Zz Old field')).toHaveCount(0)
    expect(fs.existsSync(path.join(DATA, 'vault', 'Zz New field', 'Corn.md'))).toBe(true)
    await expect
      .poll(() => fs.readFileSync(path.join(DATA, 'vault', 'Zz Elsewhere', 'Note.md'), 'utf-8'))
      .toBe('See [[Zz New field/Corn]].\n')
    expect(problems).toEqual([])
  } finally {
    for (const name of ['Zz Old field', 'Zz New field', 'Zz Elsewhere']) {
      await page.request.delete('/api/files', { params: { path: name }, headers: TAB })
    }
  }
})
