/**
 * Titles of pasted links: the operator's switch (it stays as set when the page is loaded again), and a web address
 * pasted into a note gets the page's title as its words. The server's own fetch is tested in the backend; here its
 * answer is played, a real one would come from the test machine's own network and be refused.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')
// A page the service worker controls sends its requests past Playwright's routes: the title's answer could not be played.
test.use({ serviceWorkers: 'block' })

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const NOTE = 'Heath/Pasted.md'
const onDisk = () => fs.readFileSync(path.join(DATA, 'vault', ...NOTE.split('/')), 'utf-8')
const TAB = { 'X-Nexlore-Client': 'tab-e2e-titles' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.afterEach(async ({ page }) => {
  // The server is shared by all tests: closed again, the note as it was.
  await page.waitForLoadState('networkidle')
  await page.request.put('/api/settings', { data: { link_titles_allowed: false, calendar_feed_allowed: false }, headers: TAB })
  const now = await (await page.request.get('/api/note?path=' + encodeURIComponent(NOTE))).json()
  if (now.content !== '# Pasted\n\nStart.\n') {
    // Refused while a lock is still held (423): said here, not found as strange text by the next test.
    const back = await page.request.put('/api/note', { data: { path: NOTE, content: '# Pasted\n\nStart.\n', base_hash: now.hash }, headers: TAB })
    expect(back.ok(), `resetting ${NOTE}: ${back.status()}`).toBe(true)
  }
})

test('the operator opens titles of pasted links, and a pasted address gets its page\'s title', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings?tab=server&sub=extensions')
  const card = page.locator('#link-titles')
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PUT')
  await card.getByLabel('Ask pages for their titles').check()
  await saved
  // Read again, the switches say what they are (the calendar's once always said off).
  await page.request.put('/api/settings', { data: { calendar_feed_allowed: true }, headers: TAB })
  await page.reload()
  await expect(page.locator('#link-titles').getByLabel('Ask pages for their titles')).toBeChecked()
  await expect(page.locator('#calendar-feed').getByRole('checkbox').first()).toBeChecked()

  const asked: string[] = []
  await page.route(/\/api\/link-title\?/, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('url') ?? '')
    return route.fulfill({ json: { title: 'Tea and Biscuits' } })
  })
  await page.goto('/note/Heath/Pasted.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  await editor.getByText('Start.').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  const written = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'https://example.com/tea')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor.getByRole('link', { name: 'Tea and Biscuits' })).toBeVisible()
  await written
  await expect.poll(onDisk).toContain('[Tea and Biscuits](https://example.com/tea)')
  expect(asked).toEqual(['https://example.com/tea'])
  // Out of the editor, so the note's lock goes with it (the next test edits it, and the reset after this one).
  const unlocked = page.waitForResponse((answer) => answer.url().includes('/api/locks') && answer.request().method() === 'DELETE')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  expect((await unlocked).ok()).toBe(true)
  expect(problems).toEqual([])
})

test('an address pasted onto chosen words makes them a link, in the app as it runs', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Pasted.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.ProseMirror')
  // The editor settles its caret a moment after it opens; a key pressed before that can get lost (the CI once chose
  // "Star" and linked it, 06.10.2026). The choice is made again until it holds the whole word.
  await expect(async () => {
    await editor.getByText('Start.').click()
    await page.keyboard.press('Home')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Start')
  }).toPass({ timeout: 10_000 })
  const written = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
  await editor.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'https://example.com/start')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editor.getByRole('link', { name: 'Start' })).toBeVisible()
  await written
  await expect.poll(onDisk).toBe('# Pasted\n\n[Start](https://example.com/start).\n')
  // The lock goes back before the reset after this test.
  const unlocked = page.waitForResponse((answer) => answer.url().includes('/api/locks') && answer.request().method() === 'DELETE')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  expect((await unlocked).ok()).toBe(true)
  expect(problems).toEqual([])
})
