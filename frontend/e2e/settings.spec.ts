/**
 * The settings in tabs: General first, Spaces, and Server with a row of its own for the operator; the tab is in the
 * address. An account that is not the operator neither sees Server nor reaches it by the address.
 */
import { expect, request, test } from '@playwright/test'

test.skip(!!process.env.E2E_BASE_URL, 'makes an account; not against a running instance')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-sett0' }

test('the settings are in tabs, and the address says which', async ({ page }) => {
  await page.goto('/settings')
  const tabs = page.getByRole('tablist', { name: 'Settings' })
  await expect(tabs.getByRole('tab')).toHaveText(['General', 'Look', 'Spaces', 'Server'])
  await expect(tabs.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Language of the interface')).toBeVisible()
  await expect(page.locator('#backups')).toHaveCount(0)

  await tabs.getByRole('tab', { name: 'Server' }).click()
  await expect(page).toHaveURL(/\/settings\?tab=server$/)
  const parts = page.getByRole('tablist', { name: 'Server' })
  await expect(parts.getByRole('tab')).toHaveText(['Accounts', 'Sign-in', 'Public pages', 'AI and plugins', 'Files', 'Backups', 'Languages'])
  await expect(page.locator('#accounts')).toBeVisible()

  await parts.getByRole('tab', { name: 'Backups' }).click()
  await expect(page).toHaveURL(/\/settings\?tab=server&sub=backups$/)
  await expect(page.locator('#backups')).toBeVisible()
  await expect(page.locator('#accounts')).toHaveCount(0)

  // Straight from the address, as the sidebar's "Members and settings" goes.
  await page.goto('/settings?tab=spaces')
  await expect(page.locator('#spaces')).toBeVisible()
  await expect(page.getByLabel('Language of the interface')).toHaveCount(0)
})

test('an account that is not the operator sees no Server tab, not even by the address', async ({ page, browser, baseURL }) => {
  const invite = await page.request.post('/api/invites', { data: { days: 1 }, headers: TAB })
  expect(invite.ok()).toBe(true)
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const outside = await request.newContext({ baseURL })
  expect((await outside.post(`/api/invite/${token}`, { data: { name: 'member-settings', password: 'e2e member settings password' }, headers: TAB })).ok()).toBe(true)
  const member = await browser.newContext({ storageState: await outside.storageState() })
  await outside.dispose()
  const tab = await member.newPage()
  await tab.goto('/settings?tab=server&sub=backups')
  const tabs = tab.getByRole('tablist', { name: 'Settings' })
  await expect(tabs.getByRole('tab')).toHaveText(['General', 'Look', 'Spaces'])
  await expect(tabs.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  await expect(tab.locator('#backups')).toHaveCount(0)
  await member.close()
})

test('the operator makes the guide again, and it opens at its start note', async ({ page }) => {
  await page.goto('/settings?tab=server&sub=files')
  const card = page.locator('#guide')
  await card.getByLabel('Language').selectOption('en')
  await card.getByRole('button', { name: 'Make the guide again' }).click()
  await expect(card.getByRole('status')).toContainText('Made the space “nexlore”.')
  await card.getByRole('link', { name: 'Open it' }).click()
  await expect(page.locator('article h1')).toHaveText('Welcome to nexlore')
  // Its pictures are there, and its links lead to its notes.
  await page.goto('/note/nexlore/01%20Notes%2C%20folders%20and%20spaces.md')
  await expect(page.locator('article img').first()).toHaveJSProperty('complete', true)
  expect(await page.locator('article img').first().evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(100)
  // Gone again, so the sidebar of later tests stays as it was.
  const gone = await page.request.delete('/api/files', { params: { path: 'nexlore' }, headers: { 'X-Nexlore-Client': 'tab-e2e-guide' } })
  expect(gone.ok()).toBe(true)
})
