/**
 * The ways out of block K7: the calendar subscription (closed until the operator opens it, the address shown once),
 * a space as a ZIP file from its menu, and the log for the operator under Server.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-outward' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

/** The names in a ZIP file, read from its central directory. */
function zipNames(data: Buffer): string[] {
  const names: string[] = []
  let at = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = data.readUInt16LE(at + 10)
  at = data.readUInt32LE(at + 16)
  for (let index = 0; index < count; index++) {
    const length = data.readUInt16LE(at + 28)
    const extra = data.readUInt16LE(at + 30)
    const comment = data.readUInt16LE(at + 32)
    names.push(data.subarray(at + 46, at + 46 + length).toString('utf-8'))
    at += 46 + length + extra + comment
  }
  return names
}

// The operator's switch and the tester's address are shared by every test: closed again after each.
test.afterEach(async ({ page }) => {
  await page.request.delete('/api/me/calendar-feed', { headers: TAB })
  await page.request.put('/api/settings', { data: { calendar_feed_allowed: false }, headers: TAB })
})

test('the calendar subscription is closed until the operator opens it, and its address serves the dated tasks', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  await page.goto('/account?tab=ai')
  const card = page.getByTestId('calendar-feed')
  await expect(card).toContainText('The operator has not switched calendar subscriptions on.')
  // The operator opens it under Server, Extensions.
  await page.goto('/settings?tab=server&sub=extensions')
  const toggle = page.getByRole('checkbox', { name: 'Allow calendar subscriptions' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.goto('/account?tab=ai')
  await card.getByRole('button', { name: 'Make an address' }).click()
  const field = card.getByRole('textbox', { name: 'Copy' })
  await expect(field).toHaveValue(/\/api\/calendar\/feed\/nxc_[\w-]+\.ics$/)
  const address = await field.inputValue()
  // Whole, as a calendar app needs it: with the server in front.
  expect(address.startsWith(baseURL!)).toBe(true)
  // No session: what a calendar app sees.
  const outside = await playwright.request.newContext({ baseURL })
  const feed = await outside.get(address)
  expect(feed.status()).toBe(200)
  expect(feed.headers()['content-type']).toContain('text/calendar')
  const text = await feed.text()
  expect(text).toContain('BEGIN:VCALENDAR')
  expect(text).toContain('SUMMARY:Cut the heather')
  // Stopped: the address is dead.
  await card.getByRole('button', { name: 'Stop' }).click()
  await expect(card).toContainText('The subscription is stopped.')
  expect((await outside.get(address)).status()).toBe(404)
  await outside.dispose()
  expect(problems).toEqual([])
})

test('a space comes as a ZIP file from its menu in the sidebar', async ({ page }) => {
  await page.goto('/note/Heath/Heather.md')
  const space = page.getByTestId('sidebar-tree').getByRole('button', { name: /^Heath( \d+)?$/ })
  await space.click({ button: 'right' })
  const waiting = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Download as ZIP' }).click()
  const download = await waiting
  expect(download.suggestedFilename()).toMatch(/^Heath-\d{4}-\d{2}-\d{2}\.zip$/)
  const names = zipNames(fs.readFileSync((await download.path())!))
  expect(names).toContain('Heath/Heather.md')
})

test('the operator reads the log under Server, narrows it, and may download it', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/settings?tab=server&sub=log')
  const lines = page.getByTestId('log-lines')
  await expect(lines.locator('div').first()).toBeVisible()
  // A line only a sign-in writes: narrowed to it.
  await page.getByLabel('Contains').fill('Signed in')
  await expect(lines.locator('div').first()).toContainText('Signed in')
  for (const text of await lines.locator('div').allInnerTexts()) expect(text).toContain('Signed in')
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/logs/download')
  expect(problems).toEqual([])
})
