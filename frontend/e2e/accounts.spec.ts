/**
 * Accounts and rights through the interface, against the real backend: signing in and out, an invitation into a
 * space that brings a new account, a reader who cannot edit, and a public page that shows only what is shared.
 * Each test works in a space of its own, so the operator's spaces from the disk stay the operator's.
 */
import { type Browser, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

import { OPERATOR } from './global-setup'

test.skip(!!process.env.E2E_BASE_URL, 'makes accounts; not against a running instance')

const SIGNED_OUT = { cookies: [], origins: [] }

async function stranger(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: SIGNED_OUT, locale: 'en-US' })
  return context.newPage()
}

/** A space of the operator's with one note, made through the API of the signed-in page. */
async function space(page: Page, name: string, note: string, content: string) {
  await page.goto('/settings?tab=spaces')
  const headers = { 'X-Nexlore-Client': 'tab-e2espaces' }
  expect((await page.request.post('/api/spaces', { data: { name }, headers })).status()).toBe(201)
  expect((await page.request.post('/api/notes', { data: { folder: name, title: note, content }, headers })).status()).toBe(201)
}

async function inviteLink(page: Page, spaceName: string, role: 'Read' | 'Write'): Promise<string> {
  await page.goto('/settings?tab=spaces')
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
  await dora.goto('/settings?tab=spaces')
  const spaces = dora.locator('#spaces li')
  await expect(spaces).toHaveCount(1)
  await expect(spaces.first()).toContainText('Team')
  await expect(spaces.first()).toContainText('Write')
  // Nothing of the operator's other spaces, not even in the search.
  await dora.keyboard.press('Control+k')
  await dora.getByPlaceholder('Search notes …').fill('quinceapple')
  // Only the offer to make such a note in the own space, no hit from the others.
  await expect(dora.getByRole('dialog', { name: 'Search' }).getByRole('button', { name: /^(?!Close$)/ })).toHaveText([/Make the note “quinceapple”/, 'All hits on the search page'])
  // The link is used up.
  const late = await stranger(browser)
  await late.goto(new URL(link).pathname)
  await expect(late.getByRole('heading', { name: 'This invitation is not valid' })).toBeVisible()
})

test('a reader reads and cannot change anything', async ({ page, browser }) => {
  await space(page, 'Library', 'Catalogue', '# Catalogue\n\nOld maps and a sea chart.\n\n- [ ] Mend the sea chart\n')
  const link = await inviteLink(page, 'Library', 'Read')
  const reader = await accept(browser, link, 'rea')
  await reader.goto('/note/Library/Catalogue.md')
  await expect(reader.getByText('Old maps and a sea chart.')).toBeVisible()
  await expect(reader.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  // "More" holds nothing that changes the note for a reader: no rename, no move, no trash.
  await reader.locator('summary[aria-label="More"]').click()
  const menu = reader.getByTestId('note-menu')
  await expect(menu.getByRole('button', { name: 'Copy wiki link' })).toBeVisible()
  await expect(menu.getByRole('button', { name: /Rename|Move|trash/ })).toHaveCount(0)
  // The server refuses as well, whatever the page shows.
  const refused = await reader.request.put('/api/note', {
    data: { path: 'Library/Catalogue.md', content: 'mine', base_hash: '0'.repeat(64) },
    headers: { 'X-Nexlore-Client': 'tab-e2ereader' },
  })
  expect(refused.status()).toBe(403)
  // A task of the space shows, and its box says before any click that it cannot be ticked (P5.21).
  await reader.goto('/tasks')
  const box = reader.getByTestId('task-row').filter({ hasText: 'Mend the sea chart' }).getByRole('button')
  await expect(box).toBeDisabled()
  await expect(box).toHaveAccessibleName('Read only: you may not tick off tasks in this space.')
})

test('a public page shows the shared folder and nothing beyond it', async ({ page, browser }) => {
  await space(page, 'Garden', 'Roses', '# Roses\n\nPrune in March. %%my own reminder%%\n\nSee [[Tulips]] and [[Secret]].\n')
  const headers = { 'X-Nexlore-Client': 'tab-e2espaces' }
  await page.request.post('/api/folders', { data: { parent: 'Garden', name: 'Beds' }, headers })
  await page.request.post('/api/move', { data: { source: 'Garden/Roses.md', destination: 'Garden/Beds/Roses.md' }, headers })
  await page.request.post('/api/notes', { data: { folder: 'Garden/Beds', title: 'Tulips', content: '# Tulips\n\nBack to [[Roses]].\n' }, headers })
  await page.request.post('/api/notes', { data: { folder: 'Garden', title: 'Secret', content: '# Secret\n\nnot for the web\n' }, headers })

  // Closed until the operator opens it. The note first: before it is there, no button is always true.
  await page.goto('/note/Garden/Beds/Roses.md')
  await expect(page.getByText('Prune in March.')).toBeVisible()
  await page.locator('summary[aria-label="More"]').click()
  await expect(page.getByTestId('note-menu').getByRole('button', { name: 'Rename' })).toBeVisible()
  await expect(page.getByTestId('note-menu').getByRole('button', { name: 'Share' })).toHaveCount(0)
  await page.goto('/settings?tab=server&sub=shares')
  // The switch shows at once and saves after; the reload would cut the save off (seen in the CI).
  const allowed = page.waitForResponse((answer) => answer.url().endsWith('/api/settings') && answer.request().method() === 'PUT')
  await page.locator('#shares').getByLabel('Allow public pages').check()
  await expect(page.locator('#shares').getByLabel('Allow public pages')).toBeChecked()
  expect((await allowed).ok()).toBe(true)
  await page.reload()

  await page.goto('/note/Garden/Beds/Roses.md')
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: 'Share' }).click()
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
  // Read again only once the server took it back: before, the reload could come first (seen in the CI).
  const withdrawn = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().includes('/api/shares/'))
  await dialog.getByRole('button', { name: 'Withdraw' }).click()
  expect((await withdrawn).ok()).toBe(true)
  await visitor.reload()
  await expect(visitor.getByRole('heading', { name: 'This page does not exist' })).toBeVisible()
})

test('the sign-in page opens without a single console error', async ({ browser }) => {
  const page = await stranger(browser)
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(problems).toEqual([])
})

test('the own account comes in tabs, and a profile picture goes up, shows in the account menu and goes again', async ({ page }) => {
  // One red pixel (a PNG): the server draws a square of it anew.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
  await page.goto('/account')
  const tabs = page.getByRole('tablist', { name: 'My account' })
  await expect(tabs.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0)
  await tabs.getByRole('tab', { name: 'Security' }).click()
  await expect(page).toHaveURL(/\/account\?tab=security$/)
  await expect(page.getByTestId('second-factor')).toBeVisible()
  await tabs.getByRole('tab', { name: 'Profile' }).click()

  const menu = page.getByRole('banner').getByRole('button', { name: `Account of ${OPERATOR.name}` })
  await expect(menu.getByTestId('avatar-letter')).toHaveText(OPERATOR.name.slice(0, 1).toUpperCase())
  await page.getByLabel('Upload a picture').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByText('Picture saved.')).toBeVisible()
  const shown = menu.getByTestId('avatar')
  await expect(shown).toBeVisible()
  await expect.poll(() => shown.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(256)
  // Not a picture: said so, the old one stays.
  await page.getByLabel('Upload a picture').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') })
  await expect(page.getByText('That is not a picture nexlore takes')).toBeVisible()
  await expect(shown).toBeVisible()
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Picture removed.')).toBeVisible()
  await expect(menu.getByTestId('avatar-letter')).toBeVisible()
  // The old anchors lead to their tab.
  await page.goto('/account#mcp')
  await expect(tabs.getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'true')
})

test('a reader sees what changed since the last visit, proposes a change, and the writer takes it over', async ({ page, browser }) => {
  await space(page, 'Newsroom', 'Board', '# Board\n\nFirst line.\n')
  const reader = await accept(browser, await inviteLink(page, 'Newsroom', 'Read'), 'nora')
  await reader.goto('/note/Newsroom/Board.md')
  await expect(reader.locator('article')).toContainText('First line.')
  // The writer changes it; for the reader it is new, with a dot in the sidebar and a banner on the note.
  const headers = { 'X-Nexlore-Client': 'tab-e2enewsroom' }
  const before = await (await page.request.get('/api/note', { params: { path: 'Newsroom/Board.md' } })).json()
  expect((await page.request.put('/api/note', { data: { path: 'Newsroom/Board.md', content: '# Board\n\nSecond line.\n', base_hash: before.hash }, headers })).status()).toBe(200)
  await reader.goto('/note')
  const news = reader.getByTestId('sidebar-news')
  await expect(news).toContainText('New since your last visit · 1')
  await news.getByRole('button', { name: /New since your last visit/ }).click()
  await expect(reader.getByTestId('sidebar-tree').locator('button[data-new]')).toHaveText(['Board'])
  await news.getByRole('button', { name: 'Board' }).click()
  await expect(reader.getByRole('note').filter({ hasText: `Changed by ${OPERATOR.name} since your last visit` })).toBeVisible()
  await expect(reader.getByTestId('sidebar-news')).toHaveCount(0)
  await reader.getByRole('button', { name: 'Show the difference' }).click()
  const compare = reader.getByTestId('compare-dialog')
  await expect(compare).toContainText('First line.')
  await expect(compare).toContainText('Second line.')
  await compare.getByRole('button', { name: 'Close' }).click()
  // A reader proposes; the note stays as it is.
  await reader.getByRole('button', { name: 'Propose' }).click()
  const propose = reader.getByTestId('propose-dialog')
  await propose.getByLabel('The note as you propose it').fill('# Board\n\nSecond line.\n\nA third one, from nora.\n')
  await propose.getByLabel('Message to the writers').fill('One line more')
  await propose.getByRole('button', { name: 'Send the proposal' }).click()
  await expect(reader.getByText('Your proposal for this note waits for an answer.')).toBeVisible()
  // The writer sees it on the note, compares and takes it over.
  await page.goto('/note/Newsroom/Board.md')
  await expect(page.getByText('nora proposes a change: “One line more”')).toBeVisible()
  await page.getByRole('note').getByRole('button', { name: 'Compare' }).click()
  await page.getByTestId('compare-dialog').getByRole('button', { name: 'Take over' }).click()
  await expect(page.getByText('Proposal taken over.')).toBeVisible()
  await expect(page.locator('article')).toContainText('A third one, from nora.')
  // The reader learns what became of it.
  await reader.goto('/note')
  await reader.getByRole('button', { name: 'Account of nora' }).click()
  await expect(reader.getByTestId('menu-proposals')).toContainText(`Taken over by ${OPERATOR.name}`)
})

test('the only manager is asked before giving the space up, and the dialog closes instead of failing', async ({ page: operator, browser }) => {
  await space(operator, 'Harbour', 'Tides', '# Tides\n\nHigh water at noon.\n')
  const link = await inviteLink(operator, 'Harbour', 'Read')
  const person = await accept(browser, link, 'lona')
  const headers = { 'X-Nexlore-Client': 'tab-e2elona0' }
  expect((await person.request.post('/api/spaces', { data: { name: 'Lonely' }, headers })).status()).toBe(201)
  await person.goto('/settings?tab=spaces')
  await person.locator('#spaces li', { hasText: 'Lonely' }).getByRole('button', { name: 'Members' }).click()
  const dialog = person.getByRole('dialog', { name: 'Members of Lonely' })
  await dialog.getByLabel('Right of lona').selectOption({ label: 'Read' })
  await expect(dialog.getByRole('alert')).toContainText('only one who may manage')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.getByLabel('Right of lona')).toHaveValue('manage')
  await dialog.getByLabel('Right of lona').selectOption({ label: 'Read' })
  await dialog.getByRole('button', { name: 'Give it up anyway' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(person.getByText('Your right in this space does not allow that.')).toHaveCount(0)
})

test('a member taken out of a space sees the open note go instead of asking in vain', async ({ page, browser }) => {
  await space(page, 'Dunes', 'Sand', '# Sand\n\nFine grains.\n')
  const link = await inviteLink(page, 'Dunes', 'Read')
  const reader = await accept(browser, link, 'dune')
  await reader.goto('/note/Dunes/Sand.md')
  await expect(reader.getByText('Fine grains.')).toBeVisible()
  const headers = { 'X-Nexlore-Client': 'tab-e2edunes' }
  expect((await page.request.delete('/api/spaces/Dunes/members/dune', { headers })).status()).toBe(204)
  await expect(reader.getByText('This note does not exist.')).toBeVisible({ timeout: 15_000 })
  await expect(reader.getByTestId('sidebar-tree').getByText('Dunes', { exact: true })).toHaveCount(0)
})

test('naming an account invites it, and it joins only by accepting under New', async ({ page, browser }) => {
  await space(page, 'Orchard', 'Apples', '# Apples\n\nBoskoop and Cox.\n')
  await space(page, 'Meadow', 'Grass', '# Grass\n\nTall.\n')
  const person = await accept(browser, await inviteLink(page, 'Meadow', 'Read'), 'pia')
  await page.goto('/settings?tab=spaces')
  await page.locator('#spaces li', { hasText: 'Orchard' }).getByRole('button', { name: 'Members' }).click()
  const dialog = page.getByRole('dialog', { name: 'Members of Orchard' })
  await dialog.getByLabel('Name of an account').fill('pia')
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('finds the invitation under “New”')
  await expect(dialog.getByLabel('Right of pia')).toHaveCount(0)
  await person.goto('/')
  const news = person.getByTestId('sidebar-news')
  await news.getByRole('button', { name: /New since your last visit/ }).click()
  await expect(news.locator('[data-notice="invite"]')).toContainText('invites you into “Orchard”')
  await expect(person.getByTestId('sidebar-tree').getByText('Orchard', { exact: true })).toHaveCount(0)
  await news.getByRole('button', { name: 'Accept' }).click()
  await expect(person.getByTestId('sidebar-tree').getByText('Orchard', { exact: true })).toBeVisible()
})
