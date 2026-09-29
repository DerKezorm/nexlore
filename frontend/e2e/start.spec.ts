/** The start page of the account: chosen under Settings → General, taken once per tab from the first page. */
import { expect, test, type Page } from '@playwright/test'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const TAB = { 'X-Nexlore-Client': 'tab-e2e-start' }

test('a note as the start page opens once per tab, the map stays one click away', async ({ page, context }) => {
  const problems = collectProblems(page)
  try {
    await page.goto('/settings')
    const card = page.locator('#start')
    await expect(card.getByRole('radio', { name: 'The map' })).toBeChecked()
    await card.getByRole('radio', { name: 'One note' }).check()
    await card.getByLabel('Find the note …').fill('Palette')
    await card.getByRole('list', { name: 'Notes found' }).getByRole('button', { name: /Palette/ }).first().click()
    await expect(card.getByTestId('start-note')).toHaveText('Zyx › Palette')
    await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).appearance.start_note).toBe('Zyx/Palette.md')

    // A new tab opens on it; the map is still there to go to, and stays.
    const other = await context.newPage()
    await other.goto('/')
    await expect(other).toHaveURL(/\/note\/Zyx\/Palette\.md$/)
    await other.getByRole('link', { name: 'Graph' }).click()
    await expect(other).toHaveURL(/\/$/)
    await other.reload()
    // Only once the spaces are there could it go anywhere: then it must still be the map.
    await expect(other.getByTestId('sidebar-tree').getByRole('listitem').first()).toBeVisible()
    await other.waitForTimeout(500)
    await expect(other).toHaveURL(/\/$/)
    // An address of its own is not overruled.
    const third = await context.newPage()
    await third.goto('/calendar')
    await expect(third).toHaveURL(/\/calendar$/)

    // The note opened last.
    await card.getByRole('radio', { name: 'The note opened last' }).check()
    await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).appearance.start).toBe('last')
    const fourth = await context.newPage()
    await fourth.goto('/note/Zyx/Tagged.md')
    await expect(fourth.locator('article')).toContainText('One')
    const fifth = await context.newPage()
    await fifth.goto('/')
    await expect(fifth).toHaveURL(/\/note\/Zyx\/Tagged\.md$/)
    expect(problems).toEqual([])
    // Back to the map for the tests after this one (they share the account).
    const reset = await page.request.put('/api/me/appearance', { data: { start: 'graph', start_note: '' }, headers: TAB })
    expect(reset.status()).toBe(200)
  } finally {
    await page.request.put('/api/me/appearance', { data: { start: 'graph', start_note: '' }, headers: TAB }).catch(() => {})
  }
})
