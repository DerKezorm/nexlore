/**
 * Small things of the editor from the review before 1.0.0 (block Q): Ctrl+S saves, editing starts at the end, a new
 * property takes the focus, a table's commands show in the palette only in a table.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes notes of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-small00' }

async function editNote(page: Page, title: string, content: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { folder: 'Heath', title, content }, headers: TAB })
  expect(made.status()).toBe(201)
  const path = (await made.json()).path as string
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/' + path.split('/').map(encodeURIComponent).join('/'))
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeFocused({ timeout: 15_000 })
  return path
}

const onDisk = async (page: Page, path: string) => (await (await page.request.get('/api/note?path=' + encodeURIComponent(path))).json()).content as string

test('editing starts at the end of the note, and Ctrl+S saves at once (P3.17, P3.18)', async ({ page }) => {
  const path = await editNote(page, 'Small caret', '# Title\n\nLast line.\n')
  // Whether the browser's own "save page as" was kept from opening: seen by a listener after the app's.
  await page.evaluate(() => window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 's' && event.ctrlKey) (window as unknown as { kept: boolean }).kept = event.defaultPrevented
  }))
  await page.keyboard.type(' More')
  const typed = Date.now()
  const saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await page.keyboard.press('Control+s')
  await saved
  // Sooner than the pause after typing (1.2 s) would have saved it.
  expect(Date.now() - typed).toBeLessThan(1_000)
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true)
  expect(await onDisk(page, path)).toBe('# Title\n\nLast line. More\n')
})

test('a new property takes the focus in its name field (P1.20)', async ({ page }) => {
  await editNote(page, 'Small property', 'Text.\n')
  await page.getByRole('button', { name: 'Add a property' }).click()
  await expect(page.getByRole('textbox', { name: 'Name' }).last()).toBeFocused()
})

test("a table's commands show in the palette only with the caret in a table (P4.13)", async ({ page }) => {
  await editNote(page, 'Small table', 'Before.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')
  await page.locator('.ProseMirror p', { hasText: 'Before.' }).click()
  await page.keyboard.press('Control+p')
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('Sort by this column')
  await expect(palette.getByText('Sort by this column, A to Z')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('.ProseMirror td', { hasText: '1' }).click()
  await page.keyboard.press('Control+p')
  await page.getByRole('dialog').getByRole('combobox').fill('Sort by this column')
  await expect(page.getByRole('dialog').getByText('Sort by this column, A to Z')).toBeVisible()
})

test('typed fast after Enter, a list keeps every letter where it was typed (PG-106)', async ({ page }, testInfo) => {
  // A few milliseconds between keys, as a macro or dictation types: the first letter after Enter went to the end of
  // the note, and empty items grew, in 7 of 12 tries (review before 1.0.0).
  const path = await editNote(page, `Small fast list ${testInfo.retry}${testInfo.repeatEachIndex}`, 'Start.\n')
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('1. one', { delay: 5 })
  for (const word of ['two', 'three', 'four', 'five']) {
    await page.keyboard.press('Enter')
    await page.keyboard.type(word, { delay: 5 })
  }
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('after', { delay: 5 })
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => onDisk(page, path)).toMatch(/^Start\.\n\n1\. one\n2\. two\n3\. three\n4\. four\n5\. five\n\nafter\n$/)
})
