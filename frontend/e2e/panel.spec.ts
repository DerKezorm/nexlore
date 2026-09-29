/** The header of a note in one line, the column beside it in tabs, and the sidebar folded to a strip of symbols. */
import { expect, test, type Page } from '@playwright/test'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-panel' }
const look = async (page: Page) => (await (await page.request.get('/api/auth/me')).json()).appearance

// Column and sidebar are kept with the account, and the tests share one: back as they were after each.
test.afterEach(async ({ page }) => {
  // Saves of the look go one after the other: the last may still wait behind another, and would land after this.
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.request.put('/api/me/appearance', { data: { panel: true, panel_tab: 'links', sidebar: 'open' }, headers: TAB })
})

test('the column beside a note: tabs, hidden and shown with the account, a sheet below 1280 pixels', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Zyx/Target twice.md')
  const panel = page.getByTestId('note-panel')
  await expect(panel).toHaveAttribute('data-place', 'column')
  // The note that links here twice is there once, with how often and the line it does it in, as text.
  const back = panel.locator('section').filter({ has: page.getByRole('heading', { name: /Backlinks/ }) })
  await expect(back.getByRole('button')).toHaveCount(1)
  await expect(back.getByRole('button')).toContainText('Twice')
  await expect(back.getByRole('button')).toContainText('×2')
  await expect(back.getByRole('button')).toContainText('First Target twice here.')
  // Versions come at once in their tab.
  await panel.getByRole('tab', { name: 'Versions' }).click()
  await expect(panel.getByTestId('versions')).toBeVisible()
  await expect(panel.getByTestId('versions')).not.toContainText('Loading')
  // Hidden with the button in the header, for the account.
  const toggle = page.getByRole('button', { name: 'Column beside the note' })
  await toggle.click()
  await expect(panel).toHaveCount(0)
  await expect.poll(async () => (await look(page)).panel).toBe(false)
  await page.reload()
  await expect(page.locator('article')).toContainText('Linked from one note')
  await expect(panel).toHaveCount(0)
  // Alt+R brings it back, on the tab it was on.
  await page.keyboard.press('Alt+r')
  await expect(panel).toHaveAttribute('data-place', 'column')
  await expect(panel.getByRole('tab', { name: 'Versions' })).toHaveAttribute('aria-selected', 'true')
  // Narrower: no column; the button brings a sheet, Escape takes it away.
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect(panel).toHaveCount(0)
  await toggle.click()
  await expect(panel).toHaveAttribute('data-place', 'sheet')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  expect(problems).toEqual([])
})

test('the header of a note stays one line on a phone, and its path leads to the folder', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/note/Zyx/Kitchen/Bread.md')
  const bar = page.getByTestId('note-toolbar')
  const crumbs = page.getByTestId('note-crumbs')
  await expect(crumbs.getByRole('button')).toHaveText(['Zyx', 'Kitchen'])
  // One line: as high as one row of buttons (it broke into two before, and the space shrank to one letter).
  expect((await bar.boundingBox())!.height).toBeLessThan(56)
  for (const name of ['Zyx', 'Kitchen']) {
    const box = (await crumbs.getByRole('button', { name }).boundingBox())!
    expect(box.width).toBeGreaterThan(24)
  }
  // Nothing runs over: neither the path under the buttons nor the row out of the screen.
  expect(await bar.evaluate((node) => {
    const path = node.querySelector('[data-testid="note-crumbs"]')!
    return path.scrollWidth <= path.clientWidth + 1 && node.scrollWidth <= node.clientWidth + 1
  })).toBe(true)
  await expect(page.getByTestId('note-title')).toHaveText('Bread')
  await crumbs.getByRole('button', { name: 'Kitchen' }).click()
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-sheet', 'true')
  await expect(page.getByTestId('sidebar-tree').getByRole('button', { name: /^Kitchen( \d+)?$/ })).toBeFocused()
  expect(problems).toEqual([])
})

test('the sidebar folds to symbols and back, keeps it with the account, and lists the notes opened last', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article')).toContainText('The end.')
  await page.goto('/note/Zyx/Tagged.md')
  await expect(page.locator('article')).toContainText('One')
  const recent = page.getByTestId('sidebar-recent').getByRole('button').filter({ hasNotText: 'Recent' })
  await expect(recent.first()).toHaveText('Tagged')
  await expect(recent.nth(1)).toHaveText('Palette')
  // Lines under open folders; the number of notes only under the pointer.
  await expect(page.getByTestId('tree-guide').first()).toBeAttached()
  // A row of its own: the list draws only what is in view, and scrolling to the first one would draw it anew.
  const count = page.getByTestId('sidebar-tree').locator('li[data-path="Zyx/Kitchen"]').getByTestId('folder-count')
  await expect(count).toHaveCSS('opacity', '0')
  await count.locator('..').hover()
  await expect(count).toHaveCSS('opacity', '1')
  // Folded: a strip of symbols, with the account.
  await page.getByRole('button', { name: 'Fold the sidebar (Alt+B)' }).click()
  await expect(page.getByTestId('sidebar-rail')).toBeVisible()
  await expect(page.getByTestId('sidebar')).toHaveCount(0)
  await expect.poll(async () => (await look(page)).sidebar).toBe('rail')
  // Unfolded on the same page, the tree draws as many rows as fit, not only the ten it draws ahead (seen on a test server).
  await page.getByTestId('sidebar-rail').getByRole('button', { name: 'Unfold the sidebar (Alt+B)' }).click()
  await expect.poll(() => page.getByTestId('sidebar-tree').locator('li').count()).toBeGreaterThan(14)
  await page.getByRole('button', { name: 'Fold the sidebar (Alt+B)' }).click()
  await expect.poll(async () => (await look(page)).sidebar).toBe('rail')
  await page.reload()
  await expect(page.getByTestId('sidebar-rail')).toBeVisible()
  // A symbol opens it where it leads; Alt+B folds and unfolds.
  await page.getByTestId('sidebar-rail').getByRole('button', { name: 'Tags' }).click()
  await expect(page.getByRole('tab', { name: 'Tags' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Spaces' }).click()
  await page.keyboard.press('Alt+b')
  await expect(page.getByTestId('sidebar-rail')).toBeVisible()
  await page.keyboard.press('Alt+b')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect.poll(async () => (await look(page)).sidebar).toBe('open')
  // Unfolded, the tree draws as many rows as fit, not only the ten it draws ahead.
  await expect.poll(() => page.getByTestId('sidebar-tree').locator('li').count()).toBeGreaterThan(14)
  expect(problems).toEqual([])
})

test('folding and unfolding quickly keeps what was meant last, even when the first save is slow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Zyx/Tagged.md')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  // The save that folds takes its time; sent side by side, it used to arrive last and win.
  await page.route('**/api/me/appearance', async (route) => {
    if (route.request().postData()?.includes('"rail"')) await new Promise((done) => setTimeout(done, 800))
    await route.continue()
  })
  await page.keyboard.press('Alt+b')
  await page.keyboard.press('Alt+b')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await page.waitForTimeout(1500)
  expect((await look(page)).sidebar).toBe('open')
  await expect(page.getByTestId('sidebar')).toBeVisible()
})
