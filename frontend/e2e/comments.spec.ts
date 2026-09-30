/**
 * Comments in the margin: words chosen in the reading view get a thread in the column, with @names offered; answers,
 * closing, and the words lit in the text. The file never changes.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-comments' }

// A retry in the CI finds the threads of the first try: gone before each test.
test.beforeEach(async ({ page }) => {
  for (const note of ['Heath/Comment me.md', 'Heath/Comment gone.md']) {
    const answer = await page.request.get('/api/comments?path=' + encodeURIComponent(note))
    if (!answer.ok()) continue
    for (const thread of (await answer.json()).threads)
      await page.request.delete(`/api/comments/${thread.id}?path=${encodeURIComponent(note)}`, { headers: TAB })
  }
})

// The tab beside the note is kept with the account, and the tests share one: back to the links after each.
test.afterEach(async ({ page }) => {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.request.put('/api/me/appearance', { data: { panel: true, panel_tab: 'links' }, headers: TAB })
})

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function choose(page: Page, words: string) {
  await page.locator('article').evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(wanted)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      return
    }
    throw new Error(`not found: ${wanted}`)
  }, words)
}

const lit = (page: Page, name: string) =>
  page.evaluate((key) => (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(key)?.size ?? 0, name)

test('words chosen while reading get a thread beside them, with @names, answers and closing, and the file stays', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const before = onDisk('Heath/Comment me.md')
  await page.goto('/note/Heath/Comment me.md')
  await expect(page.locator('article')).toContainText('blooms in August')
  await choose(page, 'blooms in August')
  await page.getByTestId('comment-here').click()
  const panel = page.getByTestId('note-panel')
  await expect(panel.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true')
  const box = panel.getByRole('textbox', { name: 'New comment' })
  await expect(box).toBeFocused()
  await box.pressSequentially('Is it @te')
  await expect(panel.getByRole('option', { name: '@tester' })).toBeVisible()
  // Enter takes the name, and the next letter comes before the next frame, as on the slow CI machine where the caret
  // then jumped back behind that letter ("@tester ure?s").
  await box.evaluate(async (field) => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    // React draws the name in a microtask; the letter comes right after, long before the next frame.
    await Promise.resolve()
    await Promise.resolve()
    document.execCommand('insertText', false, 's')
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await box.pressSequentially('ure?')
  await box.press('Control+Enter')
  const thread = panel.locator('[data-thread]')
  await expect(thread).toHaveCount(1)
  await expect(thread).toContainText('blooms in August')
  await expect(thread.locator('[data-comment]')).toContainText('Is it @tester sure?')
  await expect.poll(() => lit(page, 'nx-comment')).toBe(1)
  // An answer.
  await thread.getByRole('button', { name: 'Reply' }).click()
  await panel.getByRole('textbox', { name: 'Reply' }).fill('Yes, every year.')
  await thread.getByRole('button', { name: 'Send' }).click()
  await expect(thread.locator('[data-comment]')).toHaveCount(2)
  // The words lead back to their place.
  await thread.getByRole('button', { name: 'blooms in August' }).click()
  await expect.poll(() => lit(page, 'nx-comment-current')).toBe(1)
  // Closed: folded away, no longer lit.
  await thread.getByRole('button', { name: 'Resolve' }).click()
  await expect(panel.getByRole('button', { name: '1 resolved thread' })).toBeVisible()
  await expect(panel.locator('[data-thread]')).toHaveCount(0)
  await expect.poll(() => lit(page, 'nx-comment')).toBe(0)
  // Kept after a reload, still closed; the note's file never changed.
  await page.reload()
  await panel.getByRole('button', { name: '1 resolved thread' }).click()
  await expect(panel.locator('[data-thread]')).toHaveCount(1)
  expect(onDisk('Heath/Comment me.md')).toBe(before)
  expect(problems).toEqual([])
})

test('a thread whose words left the text says so', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Comment gone.md')
  await choose(page, 'soon changed')
  await page.getByTestId('comment-here').click()
  const panel = page.getByTestId('note-panel')
  await panel.getByRole('textbox', { name: 'New comment' }).fill('About these words')
  await panel.getByRole('button', { name: 'Send' }).click()
  await expect(panel.locator('[data-thread]')).toHaveCount(1)
  fs.writeFileSync(path.join(DATA, 'vault', 'Heath', 'Comment gone.md'), '# Comment gone\n\nAll different now.\n')
  await expect.poll(async () => (await (await page.request.get('/api/note?path=Heath%2FComment%20gone.md')).json()).content, { timeout: 15_000 }).toContain('All different')
  await page.reload()
  await expect(panel.locator('[data-thread]')).toContainText('The words are no longer in the text.')
})

test('a thread naming the account comes up among what is new, and leads to its note', async ({ page }) => {
  // Somebody else names the account: the server's answer, as another account's comment would make it.
  await page.route('**/api/news', async (route) => {
    const real = await (await route.fetch()).json()
    await route.fulfill({
      json: { ...real, mentions: [{ thread: 7, path: 'Heath/Comment me.md', title: 'Comment me', author: 'dora', at: '2026-09-30T00:00:00Z', excerpt: '@tester have a look' }] },
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  const news = page.getByTestId('sidebar-news')
  await expect(news).toBeVisible()
  await news.getByRole('button', { name: /^New/ }).click()
  const mention = news.locator('[data-mention="7"]')
  await expect(mention).toContainText('dora names you in Comment me')
  await mention.click()
  await expect(page).toHaveURL(/\/note\/Heath\/Comment%20me\.md/)
})
