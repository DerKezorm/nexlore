/**
 * Accounts and rights through the interface, against the real backend: signing in and out, an invitation into a
 * space that brings a new account, a reader who cannot edit, and a public page that shows only what is shared.
 * Each test works in a space of its own, so the operator's spaces from the disk stay the operator's.
 */
import { expect, test, type Browser, type Page } from '@playwright/test'

import { OPERATOR } from './global-setup'

test.skip(!!process.env.E2E_BASE_URL, 'makes accounts; not against a running instance')

const SIGNED_OUT = { cookies: [], origins: [] }

async function stranger(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: SIGNED_OUT, locale: 'en-US' })
  return context.newPage()
}

/** A space of the operator's with one note, made through the API of the signed-in page. */
async function space(page: Page, name: string, note: string, content: string) {
  await page.goto('/settings')
  const headers = { 'X-Nexlore-Client': 'tab-e2espaces' }
  expect((await page.request.post('/api/spaces', { data: { name }, headers })).status()).toBe(201)
  expect((await page.request.post('/api/notes', { data: { folder: name, title: note, content }, headers })).status()).toBe(201)
}

async function inviteLink(page: Page, spaceName: string, role: 'Read' | 'Write'): Promise<string> {
  await page.goto('/settings')
  const row = page.locator('#spaces li', { hasText: spaceName })
  await row.getByRole('button', { name: 'Members' }).click()
  const dialog = page.getByRole('dialog', { name: `Members of ${spaceName}` })
  await dialog.locator('form', { hasText: 'Create invitation link' }).getByLabel('Right').selectOption({ label: role })
  await dialog.getByRole('button', { name: 'Create invitation link' }).click()
  const link = await dialog.getByRole('textbox', { name: 'Copy' }).inputValue()
  await dialog.getByRole('button', { name: 'Close' }).click()
  return link
}

async function accept(browser: Browser, link: string, name: string): Promise<Page> {
  const page = await stranger(browser)
  await page.goto(new URL(link).pathname)
  await expect(page.getByRole('heading', { name: 'You are invited' })).toBeVisible()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Password', { exact: true }).fill('a long enough password')
  await page.getByLabel('Password again').fill('a long enough password')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('button', { name: `Account of ${name}` })).toBeVisible()
  return page
}

test('without a session the app sends to the sign-in and back', async ({ browser }) => {
  const page = await stranger(browser)
  await page.goto('/files')
  await expect(page).toHaveURL(/\/login\?next=%2Ffiles$/)
  await page.getByLabel('Name').fill(OPERATOR.name)
  await page.getByLabel('Password').fill('a wrong password here')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Name or password is wrong.')
  await page.getByLabel('Password').fill(OPERATOR.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/files$/)
  // The setup is done: its page leads to the app.
  await page.goto('/setup')
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: `Account of ${OPERATOR.name}` }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
})

test('an invitation brings a new account into exactly one space', async ({ page, browser }) => {
  await space(page, 'Team', 'Agenda', '# Agenda\n\nPlan the harvest festival.\n')
  const link = await inviteLink(page, 'Team', 'Write')
  const dora = await accept(browser, link, 'dora')
  await dora.goto('/settings')
  const spaces = dora.locator('#spaces li')
  await expect(spaces).toHaveCount(1)
  await expect(spaces.first()).toContainText('Team')
  await expect(spaces.first()).toContainText('Write')
  // Nothing of the operator's other spaces, not even in the search.
  await dora.keyboard.press('Control+k')
  await dora.getByPlaceholder('Search notes …').fill('quinceapple')
  await expect(dora.getByText('Nothing found.')).toBeVisible()
  // The link is used up.
  const late = await stranger(browser)
  await late.goto(new URL(link).pathname)
  await expect(late.getByRole('heading', { name: 'This invitation is not valid' })).toBeVisible()
})

test('a reader reads and cannot change anything', async ({ page, browser }) => {
  await space(page, 'Library', 'Catalogue', '# Catalogue\n\nOld maps and a sea chart.\n')
  const link = await inviteLink(page, 'Library', 'Read')
  const reader = await accept(browser, link, 'rea')
  await reader.goto('/note/Library/Catalogue.md')
  await expect(reader.getByText('Old maps and a sea chart.')).toBeVisible()
  await expect(reader.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  await expect(reader.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await expect(reader.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  // The server refuses as well, whatever the page shows.
  const refused = await reader.request.put('/api/note', {
    data: { path: 'Library/Catalogue.md', content: 'mine', base_hash: '0'.repeat(64) },
    headers: { 'X-Nexlore-Client': 'tab-e2ereader' },
  })
  expect(refused.status()).toBe(403)
})

test('a public page shows the shared folder and nothing beyond it', async ({ page, browser }) => {
  await space(page, 'Garden', 'Roses', '# Roses\n\nPrune in March. %%my own reminder%%\n\nSee [[Tulips]] and [[Secret]].\n')
  const headers = { 'X-Nexlore-Client': 'tab-e2espaces' }
  await page.request.post('/api/folders', { data: { parent: 'Garden', name: 'Beds' }, headers })
  await page.request.post('/api/move', { data: { source: 'Garden/Roses.md', destination: 'Garden/Beds/Roses.md' }, headers })
  await page.request.post('/api/notes', { data: { folder: 'Garden/Beds', title: 'Tulips', content: '# Tulips\n\nBack to [[Roses]].\n' }, headers })
  await page.request.post('/api/notes', { data: { folder: 'Garden', title: 'Secret', content: '# Secret\n\nnot for the web\n' }, headers })

  // Closed until the operator opens it.
  await page.goto('/note/Garden/Beds/Roses.md')
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0)
  await page.goto('/settings')
  await page.locator('#shares').getByLabel('Allow public pages').check()
  await expect(page.locator('#shares').getByLabel('Allow public pages')).toBeChecked()
  await page.reload()

  await page.goto('/note/Garden/Beds/Roses.md')
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: 'Public page' })
  await dialog.getByLabel('The folder Garden/Beds').check()
  await dialog.getByRole('button', { name: 'Create public link' }).click()
  const link = await dialog.getByRole('textbox', { name: 'Copy' }).inputValue()

  const visitor = await stranger(browser)
  await visitor.goto(new URL(link).pathname)
  const article = visitor.locator('article')
  await expect(article).toContainText('Prune in March.')
  await expect(article).not.toContainText('reminder')
  // A note of the share is a link, one outside it plain text.
  await expect(article.getByRole('link', { name: 'Tulips' })).toBeVisible()
  await expect(article.getByRole('link', { name: 'Secret' })).toHaveCount(0)
  await expect(article).toContainText('Secret')
  await article.getByRole('link', { name: 'Tulips' }).click()
  await expect(article).toContainText('Back to')
  await expect(visitor.getByRole('navigation', { name: 'Contents' }).getByRole('link')).toHaveCount(2)

  // Withdrawn, the page is gone.
  await dialog.getByRole('button', { name: 'Withdraw' }).click()
  await visitor.reload()
  await expect(visitor.getByRole('heading', { name: 'This page does not exist' })).toBeVisible()
})
