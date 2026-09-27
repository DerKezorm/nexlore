/**
 * Attachments through the interface, against the real backend: a pasted picture lands beside its note and shows,
 * a dropped PDF becomes a link, embedded pictures show in the editor and when reading, a file has its own page, the
 * files page lists attachments, and the text of a PDF is found.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const file = (rel: string) => path.join(DATA, 'vault', ...rel.split('/'))
const onDisk = (rel: string) => fs.readFileSync(file(rel), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

async function edit(page: Page, note: string) {
  await page.goto(`/note/${note}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
}

async function saved(page: Page) {
  await expect(page.getByRole('status')).toHaveText('Saved', { timeout: 10_000 })
}

/** Hands files to the editor the way the browser does on paste or drop. */
async function hand(page: Page, kind: 'paste' | 'drop', files: { name: string; type: string; base64: string }[]) {
  await page.locator('.ProseMirror').evaluate(
    (root, { kind, files }) => {
      const transfer = new DataTransfer()
      for (const item of files) {
        const bytes = Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0))
        transfer.items.add(new File([bytes], item.name, { type: item.type }))
      }
      const paragraph = [...root.querySelectorAll('p')].find((element) => element.textContent?.includes('Start.'))!
      const box = paragraph.getBoundingClientRect()
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.right - 2, clientY: box.top + box.height / 2 })
      paragraph.dispatchEvent(event)
    },
    { kind, files },
  )
}

// Content of their own: the same bytes as a file of the space would be linked to that file instead (tested below).
const GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mPUOBHFQAgwMRABhrciAIVBAVrdp34QAAAAAElFTkSuQmCC'
const PDF = Buffer.concat([fs.readFileSync(file('Media/leaflet.pdf')), Buffer.from('% price list\n')]).toString('base64')
const LATER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mPs0VjAQAgwMRABhrciAJDbAWSHbO2AAAAAAElFTkSuQmCC'
const SAME_AS_SUNSET = fs.readFileSync(file('Media/sunset.png')).toString('base64')

test('a pasted picture lands beside its note, named after it, and shows', async ({ page }) => {
  await edit(page, 'Media/Paste here.md')
  await page.locator('.ProseMirror p', { hasText: 'Start.' }).click()
  await page.keyboard.press('End')
  await hand(page, 'paste', [{ name: 'image.png', type: 'image/png', base64: GREEN_PNG }])
  const picture = page.locator('.ProseMirror img[data-nx-src]')
  await expect(picture).toHaveAttribute('data-nx-src', 'Anhänge/Paste%20here%201.png')
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(12)
  await saved(page)
  expect(onDisk('Media/Paste here.md')).toContain('![](Anhänge/Paste%20here%201.png)')
  expect(fs.existsSync(file('Media/Anhänge/Paste here 1.png'))).toBe(true)
  await expect(page.getByRole('note')).toContainText('File added.')
  // Reading, the picture comes from the server too.
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  const shown = page.locator('article img')
  await expect.poll(() => shown.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(12)
})

test('a picture the space holds already is linked, not stored again', async ({ page }) => {
  await edit(page, 'Media/Paste here.md')
  await page.locator('.ProseMirror p', { hasText: 'Start.' }).click()
  await hand(page, 'paste', [{ name: 'image.png', type: 'image/png', base64: SAME_AS_SUNSET }])
  await expect(page.locator('.ProseMirror img[data-nx-src="sunset.png"]')).toBeVisible()
  await expect(page.getByRole('note')).toContainText('The space held the same file already')
  await saved(page)
  expect(fs.readdirSync(path.join(DATA, 'vault', 'Media', 'Anhänge')).filter((name) => name.startsWith('Paste here'))).toHaveLength(1)
})

test('a dropped PDF becomes a link to it, and the link leads to its page', async ({ page }) => {
  await edit(page, 'Media/Drop here.md')
  await hand(page, 'drop', [{ name: 'Price list.pdf', type: 'application/pdf', base64: PDF }])
  await expect(page.locator('.ProseMirror a', { hasText: 'Price list.pdf' })).toBeVisible()
  await saved(page)
  expect(onDisk('Media/Drop here.md')).toContain('[Price list.pdf](Anhänge/Price%20list.pdf)')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await page.locator('article a', { hasText: 'Price list.pdf' }).click()
  await expect(page).toHaveURL(/\/file\/Media\/Anh%C3%A4nge\/Price%20list\.pdf$/)
  await expect(page.getByRole('heading', { name: 'Price list.pdf' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /download=1/)
  const usedIn = page.locator('section', { has: page.getByRole('heading', { name: 'Used in' }) })
  await expect(usedIn.getByRole('button', { name: /Drop here/ })).toBeVisible()
})

test('embedded pictures show in the editor and when reading; a click brings the text back', async ({ page }) => {
  await page.goto('/note/Media/Gallery.md')
  const reading = page.locator('article img')
  await expect(reading).toHaveCount(2)
  for (const image of await reading.all()) await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(12)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const embedded = page.locator('.ProseMirror .nx-embed-media')
  await expect.poll(() => embedded.evaluate((element: HTMLImageElement) => element.naturalWidth), { timeout: 10_000 }).toBe(12)
  const markdownImage = page.locator('.ProseMirror img[data-nx-src]')
  await expect.poll(() => markdownImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(12)
  // A click on the picture puts the cursor into the embed: its text shows for editing, the picture steps aside.
  await embedded.click()
  await expect(page.locator('.ProseMirror .nx-wiki-editing')).toHaveText('sunset.png')
  await expect(embedded).toHaveCount(0)
  // Clicking a link to a file never makes a note of that name: it opens the file's page.
  await page.locator('.ProseMirror .nx-wiki', { hasText: 'leaflet' }).click()
  await expect(page).toHaveURL(/\/file\/Media\/leaflet\.pdf$/)
  expect(fs.existsSync(file('Media/leaflet.pdf.md'))).toBe(false)
})

test('a note whose name ends like a file stays a note', async ({ page }) => {
  await edit(page, 'Media/Versions.md')
  const link = page.locator('.ProseMirror .nx-wiki', { hasText: 'v1.2' })
  await expect(link).not.toHaveClass(/nx-wiki-missing/)
  await link.click()
  await expect(page).toHaveURL(/\/note\/Media\/v1\.2\.md$/)
})

test('an embed typed before its file was uploaded shows the picture once it is', async ({ page }) => {
  await edit(page, 'Media/Later.md')
  await page.locator('.ProseMirror p', { hasText: 'Start.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' ![[later.png]]')
  await page.keyboard.press('Enter')
  await expect(page.locator('.ProseMirror .nx-wiki-missing', { hasText: 'later.png' })).toBeVisible()
  await hand(page, 'paste', [{ name: 'later.png', type: 'image/png', base64: LATER_PNG }])
  await expect.poll(() => page.locator('.ProseMirror .nx-embed-media').evaluate((image: HTMLImageElement) => image.naturalWidth), { timeout: 10_000 }).toBe(12)
})

test('the files page lists attachments with how often they are used, and search finds the text of a PDF', async ({ page }) => {
  await page.goto('/files')
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Attachments' }) })
  await card.getByLabel('Space').selectOption('Media')
  await expect(card.getByRole('link', { name: 'Anhänge/beach.png' })).toBeVisible()
  await expect(card.locator('li', { hasText: 'beach.png' })).toContainText('in 1 note')
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: /Search/ }).fill('kingfisher')
  await page.getByRole('button', { name: /leaflet/ }).click()
  await expect(page).toHaveURL(/\/file\/Media\/leaflet\.pdf$/)
})
