/**
 * The first steps from the review before 1.0.0 (block W): an account without a space is told what to do first and
 * gets a button for it, an empty sign-in names the empty field without asking the server, and after signing out
 * nothing goes out that only meets 401.
 */
import { request, type Browser, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'makes accounts of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-firststep' }
const PASSWORD = 'e2e first step password'

/** A new account from an invitation (into Heath to read, or into nexlore only), signed in on a page of its own. */
async function newcomer(page: Page, browser: Browser, baseURL: string, name: string, space: boolean): Promise<Page> {
  const invite = space
    ? await page.request.post('/api/spaces/Heath/invites', { data: { role: 'read', days: 1 }, headers: TAB })
    : await page.request.post('/api/invites', { data: { days: 1, email: '', send: false }, headers: TAB })
  expect(invite.ok()).toBe(true)
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const maker = await request.newContext({ baseURL, extraHTTPHeaders: TAB })
  expect((await maker.post(`/api/invite/${token}`, { data: { name, password: PASSWORD } })).ok()).toBe(true)
  await maker.dispose()
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const other = await context.newPage()
  await other.setViewportSize({ width: 1440, height: 900 })
  await other.goto('/login')
  await other.getByLabel('Name').fill(name)
  await other.getByLabel('Password').fill(PASSWORD)
  await other.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(other).not.toHaveURL(/\/login/)
  return other
}

const unique = (base: string, retry: number) => `${base}${retry || ''}`

test('an empty sign-in names the empty field and asks the server nothing (P1.22)', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  const asked: string[] = []
  page.on('request', (sent) => sent.url().includes('/api/auth/login') && asked.push(sent.url()))
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Enter a name.')).toBeVisible()
  await page.getByLabel('Name').fill('somebody')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Enter a password.')).toBeVisible()
  expect(asked).toEqual([])
  await context.close()
})

test('an account without a space is shown the first step, with a button for it (P1.18)', async ({ page, browser, baseURL }, testInfo) => {
  const other = await newcomer(page, browser, baseURL!, unique('firstcomer', testInfo.retry), false)
  await other.goto('/')
  const empty = other.getByTestId('graph-empty')
  await expect(empty).toContainText('No space yet.')
  await expect(other.getByTestId('sidebar-tree')).toContainText('No spaces yet.')
  // Today and New note say why they cannot be used yet.
  const plus = other.getByRole('button', { name: 'New note', exact: true }).first()
  await expect(plus).toBeDisabled()
  await expect(plus).toHaveAttribute('title', /Make one first/)
  await expect(other.getByTestId('sidebar-tree').getByRole('button', { name: 'New space' })).toBeVisible()
  await empty.getByRole('button', { name: 'New space' }).click()
  // A name that cannot be: the answer says which character (P1.24).
  const dialog = other.getByTestId('name-dialog')
  await dialog.getByRole('textbox').first().fill('Plan: one')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toContainText('The character : cannot stand in a name')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  // The page of notes offers the same first step.
  await other.goto('/note')
  await expect(other.getByTestId('note-start').getByRole('button', { name: 'New space' })).toBeVisible()
  await other.context().close()
})

test('an invitation writes the name in small letters and names an empty field (P1.22)', async ({ page, browser, baseURL }) => {
  const invite = await page.request.post('/api/invites', { data: { days: 1, email: '', send: false }, headers: TAB })
  const link = new URL((await invite.json()).link)
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const guest = await context.newPage()
  await guest.goto(link.pathname)
  const name = guest.getByLabel('Name')
  await name.fill('Neuling')
  await expect(name).toHaveValue('neuling')
  await guest.getByRole('button', { name: 'Create account' }).click()
  await expect(guest.getByText('Enter a password.')).toBeVisible()
  await context.close()
  // Without a mail server the mail field says that nothing is sent (P1.24).
  await page.goto('/settings?tab=server&sub=accounts')
  await expect(page.getByText('Without a mail server nexlore sends nothing').first()).toBeVisible()
})

test('after signing out from an open note nothing goes out that meets 401 (P1.23)', async ({ page, browser, baseURL }, testInfo) => {
  const other = await newcomer(page, browser, baseURL!, unique('leaver', testInfo.retry), true)
  await other.goto('/note/Heath/Present here.md')
  await expect(other.locator('.nn-prose')).toBeVisible()
  const refused: string[] = []
  other.on('response', (answer) => answer.status() === 401 && refused.push(answer.url()))
  await other.getByRole('button', { name: /^Account of / }).click()
  await other.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(other).toHaveURL(/\/login/)
  // Long enough for the polls of the note and the account menu to have come round once more.
  await other.waitForTimeout(6_000)
  expect(refused).toEqual([])
  await other.context().close()
})

test.describe('while the spaces load', () => {
  // page.route sees nothing the service worker answers.
  test.use({ serviceWorkers: 'block' })
  test('an account with spaces is never offered the first step (P1.18)', async ({ page }) => {
    await page.route('**/api/spaces', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/note')
    await expect(page.getByTestId('note-start')).toBeVisible()
    await expect(page.getByTestId('sidebar-tree')).toBeVisible()
    expect(await page.getByRole('button', { name: 'New space' }).count()).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('sidebar-tree').getByRole('button', { name: 'New space' })).toHaveCount(0)
    await expect(page.getByTestId('note-start').getByRole('button', { name: 'New space' })).toHaveCount(0)
  })
})
