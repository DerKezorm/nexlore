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
    // The tree may still be filling after the first scan: looked for again until the row is there.
    await expect(async () => {
      await page.getByTestId('sidebar-tree').evaluate((element) => element.scrollTo(0, 0))
      await expect(await shownRow(page, SPACE)).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
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
    await expect(card).toContainText('Example: Attachments/Shopping 1.png')
    await pattern.fill('{note}/{note} {n:3}')
    await expect(card).toContainText('Example: Attachments/Shopping/Shopping 001.png')
    const uploaded = card.getByLabel('Name of uploaded files')
    await expect(uploaded).toHaveValue('{filename}')
    await expect(card).toContainText('Example: Attachments/Receipt.pdf')
    await uploaded.fill('{note}/{filename}')
    await expect(card).toContainText('Example: Attachments/Shopping/Receipt.pdf')
    // A new folder name offers to take the folders already there along; left as it was, the offer goes.
    const folder = card.getByLabel('Attachment folder')
    await folder.fill('Clips')
    await expect(card.getByText('Rename the folders already there')).toBeVisible()
    await folder.fill('Attachments')
    await expect(card.getByText('Rename the folders already there')).toHaveCount(0)
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card).toContainText('Saved')
    expect((await (await page.request.get('/api/settings/files', { headers: TAB })).json()).pasted_name).toBe('{note}/{note} {n:3}')
    // Something the server does not know is refused with the reason.
    await pattern.fill('{title}')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card).toContainText('This name pattern does not work.')
  } finally {
    await page.request.put('/api/settings/files', { data: before, headers: TAB })
  }
})

test('renaming a note offers to rename its own attachment folder along, in the dialog and at the title', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const SPACE = `Zz Racks ${Date.now() % 100000}`
  const before = await (await page.request.get('/api/settings/files', { headers: TAB })).json()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  expect((await page.request.post('/api/spaces', { data: { name: SPACE }, headers: TAB })).status()).toBe(201)
  try {
    expect((await page.request.put('/api/settings/files', { data: { ...before, uploaded_name: '{note}/{filename}' }, headers: TAB })).status()).toBe(200)
    expect((await page.request.post('/api/notes', { data: { folder: SPACE, title: 'Shelf', content: 'Things.\n' }, headers: TAB })).status()).toBe(201)
    const stored = await page.request.post('/api/attachments', { params: { note: `${SPACE}/Shelf.md`, name: 'list.txt' }, data: 'milk', headers: TAB })
    expect(stored.status()).toBe(201)
    const link = (await stored.json()).link as string
    const note = await (await page.request.get('/api/note', { params: { path: `${SPACE}/Shelf.md` }, headers: TAB })).json()
    expect((await page.request.put('/api/note', { data: { path: note.path, content: `See [list](${link}).\n`, base_hash: note.hash }, headers: TAB })).status()).toBe(200)
    const ownFolder = async (path: string) =>
      (await (await page.request.get('/api/files/note-folder', { params: { path }, headers: TAB })).json()).folder as string | null
    expect(await ownFolder(`${SPACE}/Shelf.md`)).toBe(`${SPACE}/Attachments/Shelf`)

    // From the sidebar: the dialog names the folder, ticked, and the folder takes the new name.
    await page.goto('/')
    await expect(async () => {
      await page.getByTestId('sidebar-tree').evaluate((element) => element.scrollTo(0, 0))
      await expect(await shownRow(page, SPACE)).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    const expand = page.getByTestId('sidebar-tree').getByRole('listitem').filter({ has: row(page, SPACE) }).getByRole('button', { name: 'Expand' })
    if (await expand.isVisible()) await expand.click()
    await clickRow(page, 'Shelf', { button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const dialog = page.getByTestId('name-dialog')
    const choice = dialog.getByTestId('rename-folder')
    await expect(choice).toContainText('Also rename its attachment folder “Attachments/Shelf”')
    await expect(choice.getByRole('checkbox')).toBeChecked()
    await dialog.getByRole('textbox').fill('Rack')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await ownFolder(`${SPACE}/Rack.md`)).toBe(`${SPACE}/Attachments/Rack`)
    const renamed = await (await page.request.get('/api/note', { params: { path: `${SPACE}/Rack.md` }, headers: TAB })).json()
    expect(renamed.content).toBe('See [list](Attachments/Rack/list.txt).\n')

    // At the title: going to the choice and back keeps the rename open, by keyboard and by mouse; it goes ahead
    // with what is ticked at the end. Ticked on the way there, unticked at the end: a rename that went ahead early
    // would have taken the folder along.
    await page.goto(`/note/${encodeURIComponent(`${SPACE}/Rack.md`)}`)
    await page.getByTestId('note-title').getByRole('button').click()
    const title = page.getByTestId('note-title')
    const box = title.getByTestId('rename-folder').getByRole('checkbox')
    await expect(title.getByTestId('rename-folder')).toContainText('“Attachments/Rack”')
    await title.getByRole('textbox').fill('Crate')
    await expect(box).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(box).toBeFocused()
    await page.keyboard.press('Space')
    await expect(box).not.toBeChecked()
    await page.keyboard.press('Shift+Tab')
    await expect(title.getByRole('textbox')).toHaveValue('Crate')
    await expect(title.getByRole('textbox')).toBeFocused()
    // A click leaves the focus in the name, so Enter still renames.
    await box.click()
    await expect(box).toBeChecked()
    await box.click()
    await expect(box).not.toBeChecked()
    await expect(title.getByRole('textbox')).toBeFocused()
    await title.getByRole('textbox').press('Enter')
    await expect(page.getByTestId('note-title')).toHaveText('Crate')
    expect(await ownFolder(`${SPACE}/Crate.md`)).toBeNull()
    const crate = await (await page.request.get('/api/note', { params: { path: `${SPACE}/Crate.md` }, headers: TAB })).json()
    expect(crate.content).toBe('See [list](Attachments/Rack/list.txt).\n')
    expect(problems).toEqual([])
  } finally {
    await page.request.put('/api/settings/files', { data: before, headers: TAB })
    await page.request.delete('/api/files', { params: { path: SPACE }, headers: TAB })
  }
})
