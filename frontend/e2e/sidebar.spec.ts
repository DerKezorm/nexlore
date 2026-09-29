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
  // The lists above the tree (news, the notes opened last) come from the server and push it down when they do.
  await page.waitForLoadState('networkidle')
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
  await expect(page.getByTestId('note-start').getByRole('heading', { name: 'Your notes' })).toBeVisible()
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
  // Its symbol and colour right away, from the same choice as later in the menu.
  await naming.getByRole('button', { name: 'Star' }).click()
  await naming.getByLabel('Search symbols').fill('fahrrad')
  await naming.getByTestId('look-found').getByRole('button', { name: 'bike', exact: true }).click()
  await naming.getByRole('button', { name: 'Red' }).click()
  await naming.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('status')).toHaveText('Space “Aa plot” made.')
  await expect(row(page, 'Aa plot')).toBeVisible()
  const plot = page.getByTestId('sidebar-tree').locator('li', { has: page.getByRole('button', { name: /^Aa plot \d+$/ }) })
  await expect(plot.locator('[data-look="l:bike"]')).toHaveCSS('color', 'rgb(251, 113, 133)')
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
  // Saved and the spaces read again: under the load of the whole run that took longer than five seconds once.
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect(tidy.locator('[data-look]')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('the open note stays in sight while the folders above it are read after it', async ({ page }) => {
  // Every listing but that of the note's own space comes late: their rows arrive above the note once it is shown.
  await page.route('**/api/folder?**', async (route) => {
    const asked = new URL(route.request().url()).searchParams.get('path') ?? ''
    if (!asked.startsWith('Zone')) await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.goto('/note/Zone/Across.md')
  const across = page.getByTestId('sidebar-tree').getByRole('button', { name: 'Across', exact: true })
  await expect(across).toBeInViewport()
  // The late listings are in (the space above has its notes), and the note is still where it was seen.
  await expect(page.getByTestId('sidebar-tree').getByRole('button', { name: 'Linking', exact: true })).toBeAttached({ timeout: 10_000 })
  await expect(across).toBeInViewport()
})

test('favorites: the star on a note and the menu of a folder put them on top of the sidebar, for good', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Menu.md')
  const star = page.getByRole('button', { name: 'Favorite', exact: true })
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  const favorites = page.getByTestId('sidebar-favorites')
  await expect(favorites.getByRole('button', { name: 'Menu' })).toBeVisible()
  // The tree draws only the rows near what it shows: after a full run of other tests the folder lay beyond them.
  // The switcher's "/" brings it into view, as a person would.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Search' }).locator('input')).toBeFocused()
  await page.keyboard.type('/Tidy')
  await expect(page.getByRole('dialog', { name: 'Search' }).getByRole('button').first()).toHaveText(/Tidy/)
  await page.keyboard.press('Enter')
  await expect(row(page, 'Tidy')).toBeFocused()
  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add to favorites' }).click()
  await expect(favorites.getByRole('button')).toHaveText(['Menu', 'Tidy'])
  // Kept on the server: after a reload, and on any other device.
  await page.reload()
  await expect(favorites.getByRole('button')).toHaveText(['Menu', 'Tidy'])
  // A favorite folder opens in the tree.
  await favorites.getByRole('button', { name: 'Tidy' }).click()
  await expect(page.getByTestId('sidebar-tree').getByRole('button', { name: /^Tidy \d+$/ })).toHaveAttribute('aria-expanded', 'true')
  // Out again: from the favorite's own menu, and with the star.
  await favorites.getByRole('button', { name: 'Tidy' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove from favorites' }).click()
  await expect(favorites.getByRole('button')).toHaveText(['Menu'])
  await star.click()
  await expect(page.getByTestId('sidebar-favorites')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('tabs: a note opens in a tab of its own with Ctrl or from the menu, and closing one shows its neighbour', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Menu.md')
  await expect(page.locator('article')).toContainText('Make this word bold.')
  const tabs = page.getByTestId('note-tabs')
  // One note open: no row of tabs.
  await expect(tabs).toHaveCount(0)
  await row(page, 'Linked').click({ modifiers: ['ControlOrMeta'] })
  await expect(page).toHaveURL(/\/note\/Zoo\/Linked\.md$/)
  await expect(tabs.getByRole('tab')).toHaveText(['Menu', 'Linked'])
  await expect(tabs.getByRole('tab', { name: 'Linked' })).toHaveAttribute('aria-selected', 'true')
  // A plain click shows a note in the tab in front.
  await row(page, 'Reading').click()
  await expect(tabs.getByRole('tab')).toHaveText(['Menu', 'Reading'])
  await row(page, 'Menu').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in a new tab' }).click()
  await expect(tabs.getByRole('tab', { name: 'Menu' })).toHaveAttribute('aria-selected', 'true')
  // Kept in this browser.
  await page.reload()
  await expect(tabs.getByRole('tab')).toHaveText(['Menu', 'Reading'])
  // A slow machine (seen on a CI runner): the tab is closed before the row was drawn again after the click.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 30 })
  await tabs.getByRole('tab', { name: 'Reading' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Reading\.md$/)
  // Closing the tab in front shows its neighbour; one tab left is no row any more.
  await tabs.getByRole('button', { name: 'Close “Reading”' }).click()
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await expect(page).toHaveURL(/\/note\/Zoo\/Menu\.md$/)
  await expect(tabs).toHaveCount(0)
  expect(problems).toEqual([])
})

test('two notes side by side: the right one follows its own links, the left one keeps it, and it closes', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/note/Zoo/Menu.md')
  await expect(page.locator('[data-pane="left"] article')).toContainText('Make this word bold.')
  await row(page, 'Linked').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open to the right' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Menu\.md\?right=Zoo%2FLinked\.md$/)
  const right = page.locator('[data-pane="right"]')
  await expect(right.locator('article')).toContainText('Call')
  // A link on the right changes the right side only.
  await right.locator('article a[data-note]').first().click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Menu\.md\?right=Zoo%2FBoard\.md$/)
  await expect(page.locator('[data-pane="left"] article')).toContainText('Make this word bold.')
  // A link on the left moves the left side on, and the right one stays.
  await page.locator('[data-pane="left"] article a[data-note]').first().click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Across%20target\.md\?right=Zoo%2FBoard\.md$/)
  // So does the sidebar.
  await row(page, 'Reading').click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Reading\.md\?right=Zoo%2FBoard\.md$/)
  await expect(right).toBeVisible()
  // The same note on both sides: the right one only reads.
  await page.goto('/note/Zoo/Reading.md?right=Zoo%2FReading.md')
  await expect(right.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  await expect(page.locator('[data-pane="left"]').getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
  await right.getByRole('button', { name: 'Close this side' }).click()
  await expect(page).toHaveURL(/\/note\/Zoo\/Reading\.md$/)
  await expect(right).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a Lucide symbol is found by a German word and stands in the sidebar', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zoo/Tidy/Keep.md')
  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Symbol and colour …' }).click()
  const dialog = page.getByTestId('look-dialog')
  await dialog.getByRole('searchbox', { name: 'Search symbols' }).fill('Auto')
  await dialog.getByTestId('look-found').getByRole('button', { name: 'car', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  const tidy = page.getByTestId('sidebar-tree').locator('li', { has: page.getByRole('button', { name: /^Tidy \d+$/ }) })
  await expect(tidy.locator('[data-look="l:car"] path').first()).toBeAttached()
  // Kept after a reload, where the symbols' data is loaded anew.
  await page.reload()
  await expect(tidy.locator('[data-look="l:car"] path').first()).toBeAttached()
  // Back to none.
  await row(page, 'Tidy').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Symbol and colour …' }).click()
  await dialog.getByRole('button', { name: 'None' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect(tidy.locator('[data-look]')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('on a phone "Notes" and the empty note page open the list as a sheet, and the search is in the header', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/note')
  const start = page.getByTestId('note-start')
  await expect(start).toBeVisible()
  await expect(start).not.toContainText('Ctrl')
  const header = page.locator('header')
  // Four daily places, today, new, search and the account fit; files and settings moved into the account menu.
  await expect(header.getByRole('button', { name: 'Search' })).toBeInViewport()
  await expect(header.getByRole('link', { name: 'Settings' })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar).toBeHidden()
  await start.getByRole('button', { name: 'All notes' }).click()
  await expect(sidebar).toBeVisible()
  await row(page, 'Shopping').click()
  await expect(page).toHaveURL(/\/note\/Home\/Shopping\.md$/)
  await expect(sidebar).toBeHidden()
  // On a note "Notes" opens the list without leaving it; Escape closes it.
  await header.getByRole('link', { name: 'Notes' }).click()
  await expect(sidebar).toBeVisible()
  await expect(page).toHaveURL(/\/note\/Home\/Shopping\.md$/)
  await page.keyboard.press('Escape')
  await expect(sidebar).toBeHidden()
  // From another page it goes to the notes with the list open.
  await page.goto('/tasks')
  await header.getByRole('link', { name: 'Notes' }).click()
  await expect(page).toHaveURL(/\/note$/)
  await expect(sidebar).toBeVisible()
  await sidebar.getByRole('button', { name: 'Close' }).click()
  await expect(sidebar).toBeHidden()
  await header.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Account of / }).click()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
  expect(problems).toEqual([])
})

test('on a wide screen the sidebar stays in place and "Notes" is a plain link', async ({ page }) => {
  await page.goto('/note')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('note-start').getByRole('button', { name: 'All notes' })).toBeHidden()
  await page.goto('/tasks')
  await page.locator('header').getByRole('link', { name: 'Notes' }).click()
  await expect(page).toHaveURL(/\/note$/)
  await expect(page.getByTestId('sidebar-scrim')).toHaveCount(0)
})

test('an open folder without notes says so and offers the first one', async ({ page }) => {
  const problems = collectProblems(page)
  const made = await page.request.post('/api/folders', { data: { parent: 'Zoo', name: 'Blank' }, headers: { 'X-Nexlore-Client': 'tab-e2e-blank' } })
  expect(made.status()).toBe(201)
  await page.goto('/note/Zoo/Menu.md')
  await expect(page.locator('article')).toContainText('Make this word bold.')
  // The folder has no file yet, so the switcher cannot find it: opened by hand in the tree.
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.keyboard.type('/zoo')
  await expect(page.getByRole('dialog', { name: 'Search' }).getByRole('button').first()).toHaveText(/Zoo\s*Space/)
  await page.keyboard.press('Enter')
  await expect(row(page, 'Zoo')).toBeFocused()
  await row(page, 'Blank').click()
  const empty = page.getByTestId('sidebar-tree').getByTestId('sidebar-empty')
  await expect(empty).toContainText('No notes here yet.')
  await empty.getByRole('button', { name: 'New note' }).click()
  await expect(page.getByRole('dialog', { name: /New note in/ })).toContainText('Blank')
  await page.keyboard.press('Escape')
  expect(problems).toEqual([])
})
