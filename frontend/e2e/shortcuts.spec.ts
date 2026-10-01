/**
 * Own keys for commands: set in the command palette with the keyboard beside a command, pressed anywhere the command
 * is on offer, listed and removed under Settings → General, kept with the account.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-keys0' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.afterEach(async ({ page }) => {
  // The account is shared: no own keys left behind.
  await page.waitForLoadState('networkidle')
  const reset = await page.request.put('/api/me/appearance', { data: { keys: {} }, headers: TAB })
  expect(reset.ok()).toBe(true)
})

test('keys set in the palette run the command, are refused where taken, and are removed in the settings', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  await expect(page.getByRole('heading', { name: 'Heather' }).first()).toBeVisible()

  const palette = page.getByRole('dialog', { name: 'Commands' })
  await page.keyboard.press('ControlOrMeta+p')
  await expect(palette).toBeVisible()
  await page.keyboard.type('go to tasks')
  await palette.getByRole('button', { name: 'Set keys for Go to Tasks' }).click()
  const said = palette.getByTestId('palette-keys')
  await expect(said).toContainText('Press the keys for “Go to Tasks”')
  // Taken by nexlore: refused, still listening.
  await page.keyboard.press('Control+k')
  await expect(said).toContainText('nexlore already uses these keys')
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0)
  // A letter alone would take typing.
  await page.keyboard.press('j')
  await expect(said).toContainText('Add Ctrl, Alt or Meta')
  const saved = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().method() === 'PUT')
  await page.keyboard.press('Control+Alt+j')
  expect((await saved).ok()).toBe(true)
  await expect(said).toHaveText('Ctrl + Alt + J now runs “Go to Tasks”.')
  await expect(palette.locator('kbd[data-own]')).toHaveText('Ctrl + Alt + J')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  // Pressed anywhere: the command runs; still there after a reload (with the account).
  await page.keyboard.press('Control+Alt+j')
  await expect(page).toHaveURL(/\/tasks$/)
  await page.goto('/note/Heath/Heather.md')
  await expect(page.getByRole('heading', { name: 'Heather' }).first()).toBeVisible()
  await page.keyboard.press('Control+Alt+j')
  await expect(page).toHaveURL(/\/tasks$/)

  // The same keys for another command: they move there (pressed while the palette listens, they do not run).
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('go to files')
  await palette.getByRole('button', { name: 'Set keys for Go to Files' }).click()
  const moved = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().method() === 'PUT')
  await page.keyboard.press('Control+Alt+j')
  expect((await moved).ok()).toBe(true)
  await expect(said).toHaveText('Ctrl + Alt + J now runs “Go to Files”.')
  await expect(page).toHaveURL(/\/tasks$/)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Alt+j')
  await expect(page).toHaveURL(/\/files$/)

  // Listed under Settings → General, and removed there.
  await page.goto('/settings')
  const list = page.getByTestId('own-keys')
  await expect(list.locator('li')).toHaveCount(1)
  await expect(list.locator('[data-command="go.files"]')).toContainText('Ctrl + Alt + J')
  const removed = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().method() === 'PUT')
  await list.getByRole('button', { name: 'Remove the keys for Go to Files' }).click()
  await removed
  await expect(page.getByText('No own keys yet.')).toBeVisible()
  await page.keyboard.press('Control+Alt+j')
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(/\/settings$/)
  expect(problems).toEqual([])
})
