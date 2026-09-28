/**
 * The sidebar's context menus (right mouse button): a new folder, moving a note into it, renaming a folder, the trash;
 * the page of a note renamed from the sidebar follows it; a folder that could not be read offers to try again; a
 * click on a folder's name opens it, on the map too.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => path.join(DATA, 'vault', ...rel.split('/'))

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  // Which address answered 404, not only that one did.
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${decodeURIComponent(response.url().replace(/^https?:\/\/[^/]+/, ''))}`)
  })
  return problems
}

/** A row of the tree by its name; folders carry their note count after the name. */
function row(page: Page, name: string) {
  return page.getByTestId('sidebar-tree').getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) })
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('the context menu makes a folder, moves a note into it, renames the folder and trashes another', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Tidy/Keep.md')

  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  const naming = page.getByTestId('name-dialog')
  await naming.getByLabel('Name').fill('Shelf')
  await naming.getByRole('button', { name: 'Create' }).click()
  await expect(row(page, 'Shelf')).toBeVisible()
  expect(fs.statSync(onDisk('Zoo/Tidy/Shelf')).isDirectory()).toBe(true)
  // In a folder that is closed: it opens, and the new folder shows.
  await row(page, 'Box').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New folder' }).click()
  await naming.getByLabel('Name').fill('Lid')
  await naming.getByRole('button', { name: 'Create' }).click()
  await expect(row(page, 'Lid')).toBeVisible()

  await row(page, 'Move me').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move …' }).click()
  const moving = page.getByTestId('move-dialog')
  await moving.getByRole('button', { name: 'Expand Tidy' }).click()
  await moving.getByRole('button', { name: 'Shelf', exact: true }).click()
  await moving.getByRole('button', { name: 'Move here' }).click()
  await expect(page.getByRole('status')).toContainText('Moved to “Zoo / Tidy / Shelf”')
  await expect.poll(() => fs.existsSync(onDisk('Zoo/Tidy/Shelf/Move me.md'))).toBe(true)
  expect(fs.existsSync(onDisk('Zoo/Tidy/Move me.md'))).toBe(false)

  await row(page, 'Shelf').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename …' }).click()
  await naming.getByLabel('Name').fill('Cupboard')
  await naming.getByRole('button', { name: 'Rename' }).click()
  await expect(row(page, 'Cupboard')).toBeVisible()
  expect(fs.existsSync(onDisk('Zoo/Tidy/Cupboard/Move me.md'))).toBe(true)

  await row(page, 'Old').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to the trash' }).click()
  const question = page.getByRole('dialog', { name: /Move the folder .Old. to the trash/ })
  await question.getByRole('button', { name: 'Move to the trash' }).click()
  await expect(row(page, 'Old')).toHaveCount(0)
  expect(fs.existsSync(onDisk('Zoo/Tidy/Old'))).toBe(false)
  // The note shown all along is still there, and nothing asked after a path that was gone.
  await expect(page.locator('article')).toContainText('See')
  expect(problems).toEqual([])
})

test('a note renamed from the sidebar while it is open takes its page along', async ({ page }) => {
  const gone: string[] = []
  page.on('response', (response) => {
    if (response.status() === 404 && response.url().includes('/api/')) gone.push(response.url())
  })
  await page.goto('/note/Zoo/Tidy/Open me.md')
  await expect(page.locator('article')).toContainText('Being read')
  await row(page, 'Open me').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename …' }).click()
  const naming = page.getByTestId('name-dialog')
  await expect(naming.getByLabel('Name')).toHaveValue('Open me')
  await naming.getByLabel('Name').fill('Opened')
  await naming.getByRole('button', { name: 'Rename' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Tidy\/Opened\.md$/)
  await expect(page.locator('article')).toContainText('Being read')
  // The link in Keep followed.
  await expect.poll(() => fs.readFileSync(onDisk('Zoo/Tidy/Keep.md'), 'utf-8')).toContain('[[Opened]]')
  await page.waitForLoadState('networkidle')
  expect(gone).toEqual([])
})

test('a folder that could not be read says so and is read again on request', async ({ page }) => {
  let failed = false
  await page.route(
    (url) => url.pathname === '/api/folder' && url.searchParams.get('path') === 'Zoo/Tidy/Box',
    (route) => {
      if (failed) return route.continue()
      failed = true
      return route.abort('failed')
    },
  )
  await page.goto('/note/Zoo/Tidy/Keep.md')
  await row(page, 'Box').click()
  const tree = page.getByTestId('sidebar-tree')
  await expect(tree.getByText('Could not be loaded.')).toBeVisible()
  await tree.getByRole('button', { name: 'Try again' }).click()
  await expect(row(page, 'Inside')).toBeVisible()
})

test('a click on a folder name opens it on the map as well, and the menu flies there', async ({ page }) => {
  await page.goto('/')
  const tree = page.getByTestId('sidebar-tree')
  // A folder below a space: closed at first. Its name is the button without a label of its own.
  const name = tree.locator('button[aria-expanded="false"]:not([aria-label])').first()
  await expect(name).toBeVisible()
  const text = (await name.innerText()).split('\n')[0].trim()
  await name.click()
  await expect(tree.getByRole('button', { name: new RegExp(`^${text} \\d+$`) })).toHaveAttribute('aria-expanded', 'true')
  await expect(page).toHaveURL(/\/$/)
  // "Show in the graph" from the menu of another page lands on the map.
  await page.goto('/note/Zoo/Tidy/Keep.md')
  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Show in the graph' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('navigation', { name: 'Position in the graph' })).toContainText('Tidy')
})

test("the editor's context menu formats, turns a paragraph into a heading, and opens a linked note", async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Menu.md?edit=1')
  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible()
  await editor.getByText('Make this word bold.').dblclick({ position: { x: 60, y: 8 } })
  const word = await page.evaluate(() => window.getSelection()?.toString().trim())
  expect(word).toBeTruthy()
  await editor.getByText('Make this word bold.').click({ button: 'right', position: { x: 60, y: 8 } })
  await page.getByRole('menuitem', { name: 'Format' }).hover()
  await page.getByRole('menuitem', { name: /^Bold/ }).click()
  await expect.poll(() => fs.readFileSync(onDisk('Zoo/Menu.md'), 'utf-8'), { timeout: 10_000 }).toContain(`**${word}**`)

  await editor.getByText('A line to become a heading.').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Paragraph' }).click()
  await page.getByRole('menuitem', { name: 'Heading 2' }).click()
  await expect.poll(() => fs.readFileSync(onDisk('Zoo/Menu.md'), 'utf-8'), { timeout: 10_000 }).toContain('## A line to become a heading.')

  await editor.locator('.nx-wiki[data-target="Across target"]').first().click({ button: 'right' })
  // The right button opens the menu, not the link.
  await expect(page).toHaveURL(/\/note\/Zoo\/Menu\.md/)
  await page.getByRole('menuitem', { name: 'Open the note' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Across%20target\.md$/)
  expect(problems).toEqual([])
})

test('the notes page without a note asks nothing it cannot answer', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note')
  await expect(page.getByText('Pick a note on the left, or search with Ctrl K.')).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(problems).toEqual([])
})

test('the + beside SPACES makes a space, which its maker manages', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note')
  await page.getByRole('button', { name: 'New space' }).click()
  const naming = page.getByTestId('name-dialog')
  await expect(naming).toContainText('You manage it')
  await naming.getByLabel('Name').fill('Aa plot')
  await naming.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('status')).toContainText('Space “Aa plot” made.')
  await expect(row(page, 'Aa plot')).toBeVisible()
  expect(fs.statSync(onDisk('Aa plot')).isDirectory()).toBe(true)
  await row(page, 'Aa plot').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Members and settings' })).toBeVisible()
  expect(problems).toEqual([])
})

test('a folder gets a symbol and a colour of its own, and the folders in it take the colour', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Tidy/Keep.md')
  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Symbol and colour …' }).click()
  const dialog = page.getByTestId('look-dialog')
  await dialog.getByRole('button', { name: 'Star' }).click()
  await dialog.getByRole('button', { name: 'Red' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toContainText('Symbol and colour saved.')
  const tidy = page.getByTestId('sidebar-tree').locator('li', { has: page.getByRole('button', { name: /^Tidy \d+$/ }) })
  await expect(tidy.locator('[data-look="star"]')).toHaveCSS('color', 'rgb(251, 113, 133)')
  // A folder in it: the colour, as a dot (no symbol of its own).
  const box = page.getByTestId('sidebar-tree').locator('li', { has: page.getByRole('button', { name: /^Box \d+$/ }) })
  await expect(box.locator('span.rounded-full')).toHaveCSS('background-color', 'rgb(251, 113, 133)')
  // Back to what nexlore works out.
  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Symbol and colour …' }).click()
  await dialog.getByRole('button', { name: 'None' }).click()
  await dialog.getByRole('button', { name: 'Automatic' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(tidy.locator('[data-look]')).toHaveCount(0)
  expect(problems).toEqual([])
})
