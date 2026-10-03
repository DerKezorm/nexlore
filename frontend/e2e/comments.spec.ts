/**
 * Comments in the margin: words chosen in the reading view get a thread in the column, with @names offered; answers,
 * closing, and the words lit in the text. The file never changes.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-comments' }

// A retry in the CI finds the threads of the first try: gone before each test.
test.beforeEach(async ({ page }) => {
  for (const note of ['Heath/Comment me.md', 'Heath/Comment gone.md', 'Heath/Comment two.md', 'Heath/Comment edit.md']) {
    const answer = await page.request.get('/api/comments?path=' + encodeURIComponent(note))
    if (!answer.ok()) continue
    for (const thread of (await answer.json()).threads)
      await page.request.delete(`/api/comments/${thread.id}?path=${encodeURIComponent(note)}`, { headers: TAB })
  }
})

// The tab beside the note is kept with the account, and the tests share one: back to the links after each.
test.afterEach(async ({ page }) => {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
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

test('resting on lit words shows their comment and leads to it; a thread picked in the column makes its words blink', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  const path = 'Heath/Comment two.md'
  const made: number[] = []
  for (const [quote, body] of [['first words', 'About the first'], ['second words', 'About the second']]) {
    const answer = await page.request.post('/api/comments', { data: { path, quote, before: 'The ', after: ' stand', body }, headers: TAB })
    made.push((await answer.json()).id)
  }
  await page.goto('/note/Heath/Comment two.md')
  await expect.poll(() => lit(page, 'nx-comment')).toBe(2)
  // The mouse on the second words: their comment, and the way to it.
  const box = await page.locator('article').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf('second words')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 12)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    throw new Error('no second words')
  })
  await page.mouse.move(box.x, box.y)
  const peek = page.getByTestId('comment-peek')
  await expect(peek).toContainText('About the second')
  await expect(peek).not.toContainText('About the first')
  // Something else scrolling leaves it alone: the sidebar scrolls by itself, keeping the open note in view while
  // folders above it load (in the full run the spaces of earlier tests did, and the preview went under the mouse).
  await page.getByTestId('sidebar-tree').evaluate((tree) => tree.scrollBy(0, 40))
  await page.waitForTimeout(200)
  await expect(peek).toContainText('About the second')
  // The note's own scrolling moves the words away from it: then it goes (the note is short, so the scroll is told).
  await page.locator('article').evaluate((article) => {
    let around = article.parentElement
    while (around && !/(auto|scroll)/.test(getComputedStyle(around).overflowY)) around = around.parentElement
    ;(around ?? document).dispatchEvent(new Event('scroll'))
  })
  // At once, not a moment later when it would go on its own anyway.
  await page.waitForTimeout(100)
  expect(await peek.count()).toBe(0)
  await page.mouse.move(box.x + 2, box.y)
  await expect(peek).toContainText('About the second')
  // The way to its button as a hand takes it, over the gap: the preview stays.
  const to = (await peek.getByRole('button', { name: 'To the comment' }).boundingBox())!
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 })
  await page.waitForTimeout(800)
  await expect(peek).toBeVisible()
  await page.mouse.down()
  await page.mouse.up()
  const panel = page.getByTestId('note-panel')
  await expect(panel.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator(`[data-thread="${made[1]}"]`)).toHaveAttribute('data-lit', 'true')
  // Away from the words: the preview goes.
  await page.mouse.move(5, 5)
  await expect(peek).toHaveCount(0)
  // While words are chosen, lit words show no preview over them.
  await choose(page, 'stand here')
  await page.mouse.move(box.x, box.y)
  await page.waitForTimeout(300)
  await expect(peek).toHaveCount(0)
  await page.evaluate(() => window.getSelection()!.removeAllRanges())
  // The first thread picked in the column: its words, and only those, blink in the text.
  await panel.locator(`[data-thread="${made[0]}"]`).getByText('About the first').click()
  await expect(panel.locator(`[data-thread="${made[0]}"]`)).toHaveAttribute('data-lit', 'true')
  await expect
    .poll(() => page.evaluate(() => [...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('nx-comment-current') ?? [])].map((range) => range.toString())))
    .toEqual(['first words'])
  expect(problems).toEqual([])
})

/** Words in the editor chosen, as a person drags over them. */
async function chooseInEditor(page: Page, words: string) {
  await page.locator('.ProseMirror').evaluate((root, wanted) => {
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

test('while writing, chosen words are commented from the button or the menu, and lit when reading again', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Comment edit.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeFocused({ timeout: 15_000 })
  const panel = page.getByTestId('note-panel')
  // The button in the bar over the chosen words (below them it covered the next line).
  await chooseInEditor(page, 'purple bells')
  await page.locator('.milkdown-toolbar').getByRole('button', { name: 'Comment', exact: true }).dispatchEvent('pointerdown')
  await expect(panel.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true')
  const box = panel.getByRole('textbox', { name: 'New comment' })
  await expect(panel.getByTestId('comments')).toContainText('purple bells')
  await box.fill('From the button')
  await box.press('Control+Enter')
  await expect(panel.locator('[data-thread]')).toHaveCount(1)
  // The editor's own menu, on chosen words.
  await page.locator('.ProseMirror').focus()
  await chooseInEditor(page, 'on the moor')
  const words = (await page.locator('.ProseMirror').evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }))
  await page.mouse.click(words.x, words.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Comment' }).click()
  await panel.getByRole('textbox', { name: 'New comment' }).fill('From the menu')
  await panel.getByRole('button', { name: 'Send' }).click()
  await expect(panel.locator('[data-thread]')).toHaveCount(2)
  // While writing, both places are marked; the mouse on one shows its comment, the way to it stays reachable.
  const marks = page.locator('.ProseMirror [data-comment-thread]')
  await expect(marks).toHaveCount(2)
  await marks.filter({ hasText: 'purple bells' }).hover()
  const peek = page.getByTestId('comment-peek')
  await expect(peek).toContainText('From the button')
  // The sidebar scrolling by itself leaves it alone here too.
  await page.getByTestId('sidebar-tree').evaluate((tree) => tree.scrollBy(0, 40))
  await page.waitForTimeout(200)
  await expect(peek).toContainText('From the button')
  const to = (await peek.getByRole('button', { name: 'To the comment' }).boundingBox())!
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 })
  await page.waitForTimeout(900)
  await expect(peek).toBeVisible()
  await page.mouse.down()
  await page.mouse.up()
  const button = panel.locator('[data-thread]').filter({ hasText: 'From the button' })
  await expect(button).toHaveAttribute('data-lit', 'true')
  // A thread picked in the column makes its words blink in the editor too.
  await panel.locator('[data-thread]').filter({ hasText: 'From the menu' }).getByText('From the menu').click()
  await expect(page.locator('.ProseMirror .nx-comment-mark-current')).toHaveText('on the moor')
  // Typing before the words moves the mark along.
  await page.locator('.ProseMirror').focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('X')
  await expect(marks.filter({ hasText: 'purple bells' })).toHaveText('purple bells')
  // Reading again: both places lit.
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect.poll(() => lit(page, 'nx-comment')).toBe(2)
  // And the reading view's menu offers it as well.
  // Freshly opened for reading (after the switch the page still glides to where writing left it).
  await page.reload()
  await expect.poll(() => lit(page, 'nx-comment')).toBe(2)
  await choose(page, 'Heather')
  // Where the chosen word stands once the page has stopped scrolling.
  const place = () =>
    page.locator('article').evaluate(() => {
      const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })
  let heading = await place()
  await expect
    .poll(async () => {
      const now = await place()
      const still = now.x === heading.x && now.y === heading.y
      heading = now
      return still
    }, { intervals: [150] })
    .toBe(true)
  await page.mouse.click(heading.x, heading.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Comment' }).click()
  await expect(panel.getByTestId('comments')).toContainText('Heather')
  await expect(panel.getByRole('textbox', { name: 'New comment' })).toBeFocused()
  expect(problems).toEqual([])
})
