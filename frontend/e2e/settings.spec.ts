/**
 * The settings in areas, as in nexnotes: the spaces' sidebar stays on the left, the areas have a navigation of their
 * own beside the content, "My account" for everybody and "Server" for the operator, each area at its own address. An
 * account that is not the operator neither sees Server nor reaches it by the address; the addresses of the tabs
 * before lead to their area.
 */
import { request } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'makes an account; not against a running instance')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-sett0' }

const MINE = ['Profile', 'Security', 'Appearance', 'Notes', 'Spaces', 'Notifications', 'Plugins', 'Connections']
const SERVER = ['General', 'Sign-in', 'Mail', 'Storage and backups', 'Public pages', 'AI, API and plugins', 'Accounts', 'Log']

test('the settings are in areas beside the content, and the address says which', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings')
  const nav = page.getByTestId('settings-nav')
  await expect(nav.getByRole('link')).toHaveText([...MINE, ...SERVER, 'About nexlore'])
  await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page')
  // The spaces stay in the sidebar, with "New note", the search and the way back here.
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('sidebar').getByTestId('settings-link')).toHaveAttribute('aria-current', 'page')
  // The language is a field of the profile since the shared account module (`account.language`).
  await expect(page.getByLabel('Language', { exact: true })).toBeVisible()
  await expect(page.locator('#backups')).toHaveCount(0)

  await nav.getByRole('link', { name: 'Accounts' }).click()
  await expect(page).toHaveURL(/\/settings\/accounts$/)
  await expect(page.locator('#accounts')).toBeVisible()

  await nav.getByRole('link', { name: 'Storage and backups' }).click()
  await expect(page).toHaveURL(/\/settings\/storage$/)
  await expect(page.locator('#backups')).toBeVisible()
  await expect(page.locator('#accounts')).toHaveCount(0)

  // The address of a tab before, as a saved link goes: to its area.
  await page.goto('/settings?tab=spaces')
  await expect(page).toHaveURL(/\/settings\/spaces$/)
  await expect(page.locator('#spaces')).toBeVisible()
  await expect(page.getByLabel('Language of the interface')).toHaveCount(0)
})

test('on a narrow page a choice above the content goes to the areas', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/settings/mail')
  const jump = page.getByTestId('settings-jump')
  await expect(jump).toBeVisible()
  await expect(page.getByTestId('settings-nav')).toBeHidden()
  await jump.selectOption('log')
  await expect(page).toHaveURL(/\/settings\/log$/)
})

test('an account that is not the operator sees no Server, not even by the address', async ({ page, browser, baseURL }) => {
  const invite = await page.request.post('/api/invites', { data: { days: 1 }, headers: TAB })
  expect(invite.ok()).toBe(true)
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const outside = await request.newContext({ baseURL })
  expect((await outside.post(`/api/invite/${token}`, { data: { name: 'member-settings', password: 'e2e member settings password' }, headers: TAB })).ok()).toBe(true)
  const member = await browser.newContext({ storageState: await outside.storageState() })
  await outside.dispose()
  const tab = await member.newPage()
  await tab.setViewportSize({ width: 1440, height: 900 })
  await tab.goto('/settings?tab=server&sub=backups')
  await expect(tab).toHaveURL(/\/settings\/profile$/)
  await expect(tab.getByTestId('settings-nav').getByRole('link')).toHaveText([...MINE, 'About nexlore'])
  await expect(tab.locator('#backups')).toHaveCount(0)
  await tab.goto('/settings/storage')
  await expect(tab).toHaveURL(/\/settings\/profile$/)
  await member.close()
})

test('the operator makes the guide again, and it opens at its start note', async ({ page }) => {
  await page.goto('/settings/general')
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
