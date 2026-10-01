/**
 * A note being written when the page goes (a reload, a closed tab): the last words are saved and the lock is let go,
 * also when the service worker controls the page (then a request sent while the page unloads was lost).
 */
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const NOTE = 'Heath/Counted.md'
const START = '# Counted\n\nFive words stand here now.\n'
const TAB = { 'X-Nexlore-Client': 'tab-e2e-closed' }
const disk = () => fs.readFileSync(path.join(DATA, 'vault', ...NOTE.split('/')), 'utf-8')
const lock = async (page: import('@playwright/test').Page) =>
  (await (await page.request.get('/api/note/state?path=' + encodeURIComponent(NOTE))).json()).lock

test.afterEach(async ({ page }) => {
  const now = await (await page.request.get('/api/note?path=' + encodeURIComponent(NOTE))).json()
  if (now.content !== START) await page.request.put('/api/note', { data: { path: NOTE, content: START, base_hash: now.hash }, headers: TAB })
})

test('the last words are saved and the lock let go when the page goes, under the service worker too', async ({ page }) => {
  await page.goto('/note/Heath/Counted.md')
  // Loaded again: now the service worker controls the page.
  await page.goto('/note/Heath/Counted.md')
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(true)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.getByText('Five words stand here now.').click()
  await expect.poll(() => lock(page)).not.toBeNull()
  await page.keyboard.press('End')
  await page.keyboard.type(' Not lost.')
  // Away at once, before the pause after typing saves.
  await page.goto('/files')
  await expect.poll(disk).toBe('# Counted\n\nFive words stand here now. Not lost.\n')
  await expect.poll(() => lock(page), { timeout: 10_000 }).toBeNull()
})
