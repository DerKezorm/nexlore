/**
 * The vault through the interface, against the real backend with real files: reading, saving, the lock, a conflict
 * copy, search, renaming with links following, the trash. Every test works on its own notes from the prepared vault
 * (playwright.config.ts), so the order does not matter.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''

function onDisk(rel: string): string {
  return fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')
}

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('a note reads with its links resolved by the server, and a link leads on', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Work/Plan.md')
  const article = page.locator('article')
  await expect(article.getByRole('heading', { name: 'Plan' })).toBeVisible()
  await expect(article).not.toContainText('tags:')
  await expect(page.getByText('#project')).toBeVisible()
  await expect(article.locator('.nn-wikilink-missing')).toHaveText('Missing note')
  await article.getByText('Garden').click()
  await expect(page).toHaveURL(/\/note\/Work\/Ideas\/Garden\.md$/)
  await expect(page.locator('article')).toContainText('Tomatoes and basil')
  // The backlink from Plan is listed on the right (wide window only).
  await page.setViewportSize({ width: 1400, height: 900 })
  const backlinks = page.locator('section').filter({ has: page.getByRole('heading', { name: /Backlinks/ }) })
  await expect(backlinks.getByRole('button', { name: /^Plan/ })).toBeVisible()
  expect(problems).toEqual([])
})

test('typing saves by itself, and the file on disk has it', async ({ page }) => {
  await page.goto('/note/Work/Scratch.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('A line from the test.')
  await expect(page.getByRole('status')).toHaveText('Saved', { timeout: 10_000 })
  expect(onDisk('Work/Scratch.md')).toContain('A line from the test.')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.locator('article')).toContainText('A line from the test.')
})

test('a change made elsewhere while typing ends in a conflict copy, nothing is overwritten', async ({ page }) => {
  await page.goto('/note/Work/Conflict.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  // Obsidian (or anybody) writes the file while the editor is open (editing reads the note afresh when it starts).
  await expect(page.locator('.ProseMirror')).toContainText('Before.')
  fs.writeFileSync(path.join(DATA, 'vault', 'Work', 'Conflict.md'), '# Conflict\n\nChanged in Obsidian.\n')
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' my words')
  const banner = page.getByRole('alert').filter({ hasText: 'changed elsewhere' })
  await expect(banner).toBeVisible({ timeout: 10_000 })
  expect(onDisk('Work/Conflict.md')).toContain('Changed in Obsidian.')
  const copies = fs.readdirSync(path.join(DATA, 'vault', 'Work')).filter((name) => name.startsWith('Conflict (conflict '))
  expect(copies).toHaveLength(1)
  expect(onDisk(`Work/${copies[0]}`)).toContain('my words')
})

test('while one tab edits a note, another sees who and cannot edit', async ({ page, browser }) => {
  await page.goto('/note/Work/Locked.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  const other = await browser.newContext({ locale: 'en-US' })
  const second = await other.newPage()
  await second.goto('/note/Work/Locked.md')
  // The same account in a second window: said as its own other tab, not with its own name (P1.19).
  await expect(second.getByRole('alert').filter({ hasText: 'You are editing this note in another tab or window.' })).toBeVisible()
  await expect(second.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  // Done in the first tab: the lock is given back (after the click; read again only once it is).
  const unlocked = page.waitForResponse((answer) => answer.url().includes('/api/locks') && answer.request().method() === 'DELETE')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  expect((await unlocked).ok()).toBe(true)
  await second.reload()
  await expect(second.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
  await other.close()
})

test('search finds words inside notes and marks them', async ({ page }) => {
  await page.goto('/files')
  await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: 'Search notes …' }).fill('quinceap')
  const hit = page.getByRole('dialog').getByRole('button', { name: /Shopping/ })
  await expect(hit).toBeVisible()
  await expect(hit.locator('mark')).toHaveText('quinceapple')
  await hit.click()
  await expect(page).toHaveURL(/\/note\/Home\/Shopping\.md$/)
})

test('a note with # and % in its name opens', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/files')
  await page.getByRole('button', { name: /Search/ }).click()
  await page.getByRole('textbox', { name: 'Search notes …' }).fill('zebracorn')
  await page.getByRole('dialog').getByRole('button', { name: /50% C# done/ }).click()
  await expect(page.locator('article')).toContainText('The zebracorn lives here.')
  await page.reload()
  await expect(page.locator('article')).toContainText('The zebracorn lives here.')
  expect(problems).toEqual([])
})

test('going straight from one note being edited to another keeps each text where it belongs', async ({ page }) => {
  await page.goto('/note/Switch/From.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' typed just before leaving')
  // No pause for the autosave: straight to the other note in the sidebar.
  await page.getByRole('button', { name: 'To', exact: true }).click()
  await expect(page.locator('article')).toContainText('Other note.')
  await expect.poll(() => onDisk('Switch/From.md')).toContain('typed just before leaving')
  expect(onDisk('Switch/To.md')).toBe('# To\n\nOther note.\n')
  expect(fs.readdirSync(path.join(DATA, 'vault', 'Switch')).sort()).toEqual(['From.md', 'To.md'])
})

test('renaming a note carries the links to it along', async ({ page }) => {
  await page.goto('/note/Work/Rename me.md')
  // The name above the text: a click turns it into a field, Enter renames.
  await page.getByTestId('note-title').getByRole('button', { name: 'Rename “Rename me”' }).click()
  await page.getByLabel('New name').fill('Renamed note')
  await page.getByLabel('New name').press('Enter')
  await expect(page).toHaveURL(/\/note\/Work\/Renamed%20note\.md$/)
  // How many notes had their links updated, said on the renamed note.
  await expect(page.getByText('Links in 1 note now use the new name.')).toBeVisible()
  expect(onDisk('Work/Points at rename.md')).toBe('See [[Renamed note]] and [it](Renamed%20note.md).\n')
})

test('Escape closes the name field and leaves the name as it was; F2 and the menu open it too', async ({ page }) => {
  await page.goto('/note/Zoo/Embedded.md')
  await expect(page.locator('article')).toBeVisible()
  // F2 needs to know one may write here: that comes with the spaces, and Edit says so.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
  // The key is listened for right after the page is drawn; on a busy machine the first press can come before that.
  await expect(async () => {
    await page.keyboard.press('F2')
    await expect(page.getByLabel('New name')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await expect(page.getByLabel('New name')).toHaveValue('Embedded')
  await page.getByLabel('New name').press('Escape')
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: 'Rename' }).click()
  const field = page.getByLabel('New name')
  await field.fill('Something else')
  await field.press('Escape')
  await expect(field).toHaveCount(0)
  await expect(page).toHaveURL(/\/note\/Zoo\/Embedded\.md$/)
  expect(fs.existsSync(path.join(DATA, 'vault', 'Zoo', 'Embedded.md'))).toBe(true)
})

test('a deleted note waits in the trash and comes back', async ({ page }) => {
  await page.goto('/note/Work/Delete me.md')
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: /Move to trash/ }).click()
  // nexlore's own question, not the browser's; cancelling keeps the note.
  const question = page.getByRole('dialog', { name: /Move .Delete me. to the trash/ })
  await expect(question).toContainText('30 days')
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toBeHidden()
  expect(fs.existsSync(path.join(DATA, 'vault', 'Work', 'Delete me.md'))).toBe(true)
  // Leaving the deleted note, nothing asks after it any more (its copies, drafts, local graph): no 404.
  const gone: string[] = []
  page.on('response', (response) => {
    if (response.status() === 404 && response.url().includes('/api/')) gone.push(response.url())
  })
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: /Move to trash/ }).click()
  await question.getByRole('button', { name: 'Move to trash' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.waitForLoadState('networkidle')
  expect(gone).toEqual([])
  expect(fs.existsSync(path.join(DATA, 'vault', 'Work', 'Delete me.md'))).toBe(false)
  await page.goto('/files')
  const entry = page.getByRole('listitem').filter({ hasText: 'Work/Delete me.md' })
  await entry.getByRole('button', { name: 'Restore' }).click()
  await expect(entry).toHaveCount(0)
  expect(onDisk('Work/Delete me.md')).toContain('Gone soon.')
})

test('a vault taken in turns the files card to the new space at once', async ({ page }) => {
  // A ZIP made beforehand (Python's zipfile): Vault/Note.md and Vault/pic.png.
  const zip = Buffer.from('UEsDBBQAAAAAAMKxPl35aNe9EgAAABIAAAANAAAAVmF1bHQvTm90ZS5tZCMgTm90ZQoKVGFrZW4gaW4uClBLAwQUAAAAAADCsT5dV0qE/wwAAAAMAAAADQAAAFZhdWx0L3BpYy5wbmeJUE5HDQoaCmZha2VQSwECFAAUAAAAAADCsT5d+WjXvRIAAAASAAAADQAAAAAAAAAAAAAAgAEAAAAAVmF1bHQvTm90ZS5tZFBLAQIUABQAAAAAAMKxPl1XSoT/DAAAAAwAAAANAAAAAAAAAAAAAACAAT0AAABWYXVsdC9waWMucG5nUEsFBgAAAAACAAIAdgAAAHQAAAAAAA==', 'base64')
  await page.goto('/files')
  await page.getByLabel('ZIP file').setInputFiles({ name: 'vault.zip', mimeType: 'application/zip', buffer: zip })
  await page.getByLabel('Name of the new space').fill('Taken in')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByLabel('Space', { exact: true })).toHaveValue('Taken in')
})
