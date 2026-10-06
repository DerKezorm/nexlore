/**
 * Paper and PDFs (1.5): a note printed or saved as PDF through a dialog that shows its pages, a folder as one PDF,
 * and PDFs read in nexlore (the file's page, an embed in a note, beside a note, in the editor). The PDF read here is
 * made by nexlore itself from the folder Zyx/Prints: cover, contents, One, Reading list, Two (one page each).
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'

import { clickRow } from './tree'

test.skip(!!process.env.E2E_BASE_URL, 'writes a PDF into the vault; not against a running instance')

const TAB = { 'X-Nexlore-Client': 'tab-e2epdf000' }
const PDF = 'Zyx/Prints/Attachments/Prints.pdf'

/** The PDF of the folder, made once and put next to its notes. */
async function makePdf(page: Page): Promise<void> {
  const there = await page.request.get(`/api/links?path=${encodeURIComponent(PDF)}`)
  if (there.ok()) return
  const made = await page.request.post('/api/export/pdf', { headers: TAB, data: { folder: 'Zyx/Prints', options: { language: 'en' } } })
  expect(made.ok()).toBe(true)
  const up = await page.request.post(`/api/attachments?note=${encodeURIComponent('Zyx/Prints/Reading list.md')}&name=Prints.pdf`, {
    headers: TAB, data: await made.body(),
  })
  expect(up.status(), await up.text()).toBe(201)
}

/** A reader once pdf.js has the PDF: its page count, and the page it shows. */
async function reader(view: ReturnType<Page['getByTestId']>, pages = 5) {
  await expect(view).toHaveAttribute('data-pages', String(pages), { timeout: 20_000 })
  return view
}

test('a note goes to paper through a dialog that shows its pages, and every choice changes them', async ({ page }) => {
  await page.goto('/note/Zyx/Prints/One.md')
  await page.getByLabel('More', { exact: true }).click()
  await page.getByTestId('note-menu').getByRole('button', { name: 'Print …' }).click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog.getByRole('heading', { name: 'Print' })).toBeVisible()
  const first = dialog.getByTestId('export-page').first()
  await expect(first).toBeVisible({ timeout: 20_000 })
  const portrait = await first.evaluate((image: HTMLImageElement) => image.naturalWidth < image.naturalHeight)
  expect(portrait).toBe(true)
  // Landscape: the page is set again, wider than tall.
  await dialog.getByRole('radio', { name: 'Landscape' }).click()
  await expect.poll(() => first.evaluate((image: HTMLImageElement) => image.naturalWidth > image.naturalHeight), { timeout: 20_000 }).toBe(true)
  await dialog.getByRole('radio', { name: 'Portrait' }).click()
  // Saved as a file: the note's name, a PDF.
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save as PDF' }).click()])
  expect(download.suggestedFilename()).toBe('One.pdf')
  expect(fs.readFileSync(await download.path()).subarray(0, 4).toString()).toBe('%PDF')
  await expect(dialog).toBeHidden()
})

test('a folder becomes one PDF of the notes ticked', async ({ page }) => {
  await page.goto('/note/Zyx/Prints/One.md')
  await clickRow(page, 'Prints', { button: 'right' })
  await page.getByRole('menuitem', { name: 'Save as PDF …' }).click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog.getByRole('heading', { name: 'Folder as PDF' })).toBeVisible()
  const notes = dialog.getByTestId('export-notes')
  await expect(notes.getByRole('checkbox')).toHaveCount(3)
  await expect(notes).toContainText('One')
  await notes.getByRole('checkbox').nth(2).uncheck()
  await expect(dialog.getByText('2 of 3 notes')).toBeVisible()
  await expect(dialog.getByTestId('export-page').first()).toBeVisible({ timeout: 20_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save as PDF' }).click()])
  expect(download.suggestedFilename()).toBe('Prints.pdf')
  const text = fs.readFileSync(await download.path())
  expect(text.subarray(0, 4).toString()).toBe('%PDF')
})

test('a PDF opens in nexlore at the page of the address, finds words, and names the notes that link it', async ({ page }) => {
  await makePdf(page)
  await page.goto(`/file/${PDF}#page=3`)
  const view = await reader(page.getByTestId('pdf-view'))
  await expect(view).toHaveAttribute('data-page', '3')
  // Turning pages keeps the address up to date.
  await view.getByRole('button', { name: 'Next page' }).click()
  await expect(view).toHaveAttribute('data-page', '4')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#page=4')
  // Find: the one word nothing else has, on the last page.
  await view.getByRole('button', { name: 'Find in the PDF' }).click()
  await view.getByPlaceholder('Find in the PDF').fill('marmalade')
  await expect(view.getByTestId('pdf-found')).toHaveText('1 of 1', { timeout: 20_000 })
  await expect(view).toHaveAttribute('data-page', '5')
  // The note that links the PDF, with the pages it names.
  const panel = page.getByTestId('pdf-panel')
  await expect(panel.getByRole('button', { name: /Reading list/ })).toContainText('page 2 and 4')
})

test('a PDF in a note: embedded at its page, a page link opens it there, and it opens beside the note', async ({ page }) => {
  await makePdf(page)
  await page.goto('/note/Zyx/Prints/Reading list.md')
  const embed = await reader(page.locator('article [data-testid="pdf-view"]'))
  await expect(embed).toHaveAttribute('data-page', '2')
  expect(Math.round((await embed.boundingBox())!.height)).toBe(320)
  await page.locator('article').getByRole('link', { name: 'the fourth page' }).click()
  await expect(page).toHaveURL(/Prints\.pdf#page=4$/)
  await expect(await reader(page.getByTestId('pdf-view'))).toHaveAttribute('data-page', '4')
  // From the list of notes that link it: the note, with the PDF beside it.
  await page.getByTestId('pdf-panel').getByRole('button', { name: /Reading list/ }).click()
  const beside = await reader(page.getByTestId('pdf-pane').getByTestId('pdf-view'))
  // A page link in the note turns the PDF beside it, the note stays.
  await page.locator('[data-pane="left"] article').getByRole('link', { name: 'the fourth page' }).click()
  await expect(beside).toHaveAttribute('data-page', '4')
  await expect(page).toHaveURL(/\/note\/Zyx\/Prints\/Reading%20list\.md\?right=.*&rpage=4$/)
})

test('in the editor an embedded PDF is a reader too, and its tools change nothing in the note', async ({ page }) => {
  await makePdf(page)
  await page.goto('/note/Zyx/Prints/Reading list.md?edit=1')
  await expect(page.locator('.ProseMirror')).toBeVisible()
  // Editing starts at the end of the note, here inside the embed, which then shows its text: to the top first.
  // The editor puts the caret at the end a moment after it shows: until then a key to the top may be undone.
  await expect(async () => {
    await page.keyboard.press('Control+Home')
    await expect(page.locator('.nx-embed-pdf')).toHaveCount(1, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  const embed = await reader(page.locator('.nx-embed-pdf [data-testid="pdf-view"]'))
  await expect(embed).toHaveAttribute('data-page', '2')
  // A click in the reader's tools changes nothing in the note.
  await embed.getByRole('button', { name: 'Next page' }).click()
  await expect(embed).toHaveAttribute('data-page', '3')
  await expect(page.getByText('Not saved yet')).toBeHidden()
})
