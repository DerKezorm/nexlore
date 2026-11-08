/**
 * The attachment folders as managers and the operator shape them: hidden from the sidebar from the space's menu and
 * shown again, and the pattern pasted pictures are named after, with its example. Made in a space of its own and put
 * away at the end: other tests share the account and its spaces.
 */
import { expect, test } from './fixtures'
import { clickRow, row, shownRow } from './tree'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-attachmentfolders' }

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('a manager hides the attachment folders of a space from its menu, and shows them again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // A name of its own each run: a space put away waits in the trash under its name.
  const SPACE = `Zz Clips ${Date.now() % 100000}`
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  expect((await page.request.post('/api/spaces', { data: { name: SPACE }, headers: TAB })).status()).toBe(201)
  try {
    expect((await page.request.post('/api/notes', { data: { folder: SPACE, title: 'Shelf', content: 'Things.\n' }, headers: TAB })).status()).toBe(201)
    const stored = await page.request.post('/api/attachments', { params: { note: `${SPACE}/Shelf.md`, name: 'list.txt' }, data: 'milk', headers: TAB })
    expect(stored.status()).toBe(201)

    await page.goto('/')
    // A new space may stand open already: opened only when it is not.
    await expect(await shownRow(page, SPACE)).toBeVisible()
    const expand = page.getByTestId('sidebar-tree').getByRole('listitem').filter({ has: row(page, SPACE) }).getByRole('button', { name: 'Expand' })
    if (await expand.isVisible()) await expand.click()
    await expect(await shownRow(page, 'Attachments')).toBeVisible()

    await clickRow(page, SPACE, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Hide attachment folders' }).click()
    await expect(row(page, 'Attachments')).toHaveCount(0)
    await expect(await shownRow(page, 'Shelf')).toBeVisible()

    await clickRow(page, SPACE, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Show attachment folders' }).click()
    await expect(await shownRow(page, 'Attachments')).toBeVisible()
    expect(problems).toEqual([])
  } finally {
    await page.request.delete('/api/files', { params: { path: SPACE }, headers: TAB })
  }
})

test('the operator sets how pasted pictures are named, and sees an example', async ({ page }) => {
  const before = await (await page.request.get('/api/settings/files', { headers: TAB })).json()
  try {
    await page.goto('/settings?tab=server&sub=files')
    const card = page.locator('#files')
    const pattern = card.getByLabel('Name of pasted pictures')
    await expect(pattern).toHaveValue('{note} {n}')
    await expect(card).toContainText('Example: Shopping 1.png')
    await pattern.fill('{note} {n:3}')
    await expect(card).toContainText('Example: Shopping 001.png')
    // A new folder name offers to take the folders already there along; left as it was, the offer goes.
    const folder = card.getByLabel('Attachment folder')
    await folder.fill('Clips')
    await expect(card.getByText('Rename the folders already there')).toBeVisible()
    await folder.fill('Attachments')
    await expect(card.getByText('Rename the folders already there')).toHaveCount(0)
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card).toContainText('Saved')
    expect((await (await page.request.get('/api/settings/files', { headers: TAB })).json()).pasted_name).toBe('{note} {n:3}')
    // Something the server does not know is refused with the reason.
    await pattern.fill('{title}')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card).toContainText('This name pattern does not work.')
  } finally {
    await page.request.put('/api/settings/files', { data: before, headers: TAB })
  }
})
