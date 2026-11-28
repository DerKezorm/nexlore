/**
 * Rows of the sidebar tree. The tree draws only what is near the view, and other tests add and remove spaces of the
 * shared account meanwhile: a row found a moment ago may have moved away before the click lands.
 */
import { type Page } from '@playwright/test'
import { expect } from './fixtures'

/** A row of the tree by its name; folders carry their note count after the name. */
export function row(page: Page, name: string) {
  return page.getByTestId('sidebar-tree').getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) })
}

/** A row after a long open folder is scrolled to first, as by hand. */
export async function shownRow(page: Page, name: string) {
  const tree = page.getByTestId('sidebar-tree')
  const button = row(page, name)
  await expect(tree.getByRole('listitem').first()).toBeVisible()
  // Down to the end of the tree, however long the other files made it, not a fixed number of steps.
  for (let step = 0; step < 400 && !(await button.isVisible()); step++) {
    const atEnd = await tree.evaluate((element) => {
      const before = element.scrollTop
      element.scrollBy(0, element.clientHeight / 2)
      return element.scrollTop === before
    })
    if (atEnd) break
    await page.waitForTimeout(50)
  }
  return button
}

/** Finds the row and clicks it as one step; when the tree changed under it, looks again from the top. */
export async function clickRow(page: Page, name: string, options: { button?: 'left' | 'right' } = {}) {
  let tries = 0
  await expect(async () => {
    if (tries++) await page.getByTestId('sidebar-tree').evaluate((element) => element.scrollTo(0, 0))
    await (await shownRow(page, name)).click({ ...options, timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}
