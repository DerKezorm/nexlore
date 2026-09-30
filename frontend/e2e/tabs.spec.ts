/**
 * The row of tabs: a list of all of them at its end, a tab pinned from its menu (left, no cross, a note opened from
 * it comes in a tab of its own, the middle button leaves it), and dragging puts a tab elsewhere.
 */
import { expect, test, type Page } from '@playwright/test'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const order = (page: Page) => page.getByTestId('note-tabs').locator('[data-tab]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab')))

test('tabs are listed, pinned from their menu and put elsewhere by dragging', async ({ page }) => {
  const problems = collectProblems(page)
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('tabs-set')) {
      localStorage.setItem('nexlore.tabs', JSON.stringify({ paths: ['Heath/Heather.md', 'Heath/Counted.md', 'Heath/Slashed.md'], active: 0 }))
      sessionStorage.setItem('tabs-set', '1')
    }
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  const row = page.getByTestId('note-tabs')
  await expect(row.locator('[data-tab]')).toHaveCount(3)

  // The list at the end of the row names every tab and goes to one.
  await page.getByTestId('tab-list').click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText([/Heather/, /Counted/, /Slashed/])
  await menu.getByRole('menuitem', { name: /Counted/ }).click()
  await expect(page).toHaveURL(/\/note\/Heath\/Counted\.md$/)

  // Pinned from the tab's menu: first in the row, no cross, the middle button leaves it.
  await row.locator('[data-tab="Heath/Slashed.md"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin' }).click()
  await expect.poll(() => order(page)).toEqual(['Heath/Slashed.md', 'Heath/Heather.md', 'Heath/Counted.md'])
  const pinned = row.locator('[data-tab="Heath/Slashed.md"]')
  await expect(pinned).toHaveAttribute('data-pinned', 'true')
  await expect(pinned.getByRole('button', { name: /Close/ })).toHaveCount(0)
  await pinned.getByRole('tab').click({ button: 'middle' })
  await expect(row.locator('[data-tab]')).toHaveCount(3)

  // From the pinned tab in front, another note comes in a tab of its own.
  await pinned.getByRole('tab').click()
  await expect(page).toHaveURL(/Slashed\.md$/)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Present here')
  await page.getByRole('dialog', { name: 'Search' }).getByRole('button', { name: /^Present here/ }).first().click()
  await expect(page).toHaveURL(/Present%20here\.md$/)
  await expect.poll(() => order(page)).toEqual(['Heath/Slashed.md', 'Heath/Present here.md', 'Heath/Heather.md', 'Heath/Counted.md'])

  // Dragged onto the left half of Heather: Counted goes before it.
  await row.locator('[data-tab="Heath/Counted.md"]').dragTo(row.locator('[data-tab="Heath/Heather.md"]'), { targetPosition: { x: 4, y: 8 } })
  await expect.poll(() => order(page)).toEqual(['Heath/Slashed.md', 'Heath/Present here.md', 'Heath/Counted.md', 'Heath/Heather.md'])
  // A tab that is not pinned does not get in front of a pinned one.
  await row.locator('[data-tab="Heath/Heather.md"]').dragTo(row.locator('[data-tab="Heath/Slashed.md"]'), { targetPosition: { x: 4, y: 8 } })
  await expect.poll(() => order(page)).toEqual(['Heath/Slashed.md', 'Heath/Heather.md', 'Heath/Present here.md', 'Heath/Counted.md'])

  // "Close the others" keeps the pinned one.
  await row.locator('[data-tab="Heath/Counted.md"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close the others' }).click()
  await expect.poll(() => order(page)).toEqual(['Heath/Slashed.md', 'Heath/Counted.md'])
  await expect(page).toHaveURL(/Counted\.md$/)
  expect(problems).toEqual([])
})
