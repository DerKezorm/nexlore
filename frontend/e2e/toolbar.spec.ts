/**
 * The editor's toolbar through the interface: there from the start, formats what is selected and lights it, puts a
 * web link on words, hides and stays hidden, leads to the Markdown view; on a phone one row above the keyboard.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

async function edit(page: Page, note: string) {
  await page.goto(`/note/${note}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  // The first note of a run waits for the lock while the server still reads the vault, then for the editor's code.
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
}

async function select(page: Page, text: string) {
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
  }, text)
}

const saved = (page: Page) => expect(page.getByRole('status')).toHaveText('Saved', { timeout: 10_000 })

test('the toolbar is there from the start, formats the selection, lights it, and puts a web link on words', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  await edit(page, 'Zoo/Toolbar.md')
  const bar = page.getByTestId('editor-toolbar')
  await expect(bar).toHaveAttribute('data-place', 'top')
  const bold = bar.getByRole('button', { name: 'Bold' })
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await page.locator('.ProseMirror').focus()
  // The text never loses the focus to a button (on a phone the keyboard would close and open again).
  await page.locator('.ProseMirror').evaluate((root) => {
    ;(window as unknown as { blurs: number }).blurs = 0
    root.addEventListener('blur', () => (window as unknown as { blurs: number }).blurs++)
  })
  await select(page, 'word')
  await bold.click()
  await expect(bold).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.ProseMirror')).toBeFocused()
  expect(await page.evaluate(() => (window as unknown as { blurs: number }).blurs)).toBe(0)

  await select(page, 'link')
  await bar.getByRole('button', { name: 'Web link' }).click()
  const address = page.getByPlaceholder('Paste or type a link …')
  await expect(address).toBeVisible()
  await address.fill('https://example.com/')
  await address.press('Enter')

  // The second item goes under the first.
  await select(page, 'two')
  await bar.getByRole('button', { name: 'Indent' }).click()
  await saved(page)
  expect(onDisk('Zoo/Toolbar.md')).toMatch(/^# Toolbar\n\nMake this \*\*word\*\* bold\.\n\nPut a \[link\]\(https:\/\/example\.com\/\) here\.\n\n- one\n\s+- two\n$/)
  expect(problems).toEqual([])
})

test('the toolbar hides, stays hidden in this browser, comes back, and leads to the Markdown view', async ({ page }) => {
  await edit(page, 'Zoo/Toolbar hide.md')
  const bar = page.getByTestId('editor-toolbar')
  await bar.getByRole('button', { name: 'Hide the toolbar' }).click()
  await expect(bar).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await expect(bar).toHaveCount(0)
  await page.getByRole('button', { name: 'Show the toolbar' }).click()
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: 'Markdown source' }).click()
  await expect(page.getByLabel('Markdown source of the note')).toHaveValue(/# Toolbar hide/)
})

test('on a phone the toolbar is one row above the keyboard, swiped sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await edit(page, 'Zoo/Toolbar phone.md')
  const bar = page.getByTestId('editor-toolbar')
  await expect(bar).toHaveAttribute('data-place', 'keyboard')
  const box = (await bar.boundingBox())!
  // At the bottom of the window (no keyboard in a headless browser), one row high.
  expect(Math.round(box.y + box.height)).toBe(780)
  expect(box.height).toBeLessThan(50)
  // More tools than fit: the row scrolls, the page does not.
  expect(await bar.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.locator('.ProseMirror').focus()
  await select(page, 'phone.')
  await bar.getByRole('button', { name: 'Italic' }).click()
  await saved(page)
  expect(onDisk('Zoo/Toolbar phone.md')).toBe('# Toolbar phone\n\nTyped on a *phone.*\n')
})

test('the grip answers the mouse in its own column left of the text, and a block dropped there lands', async ({ page }) => {
  await edit(page, 'Zoo/Grip left.md')
  const before = onDisk('Zoo/Grip left.md')
  const first = page.locator('.ProseMirror p', { hasText: 'Left first' })
  const second = page.locator('.ProseMirror p', { hasText: 'Left second.' })
  const top = (await first.boundingBox())!
  const low = (await second.boundingBox())!
  // Where the grip stands, never over the text: it shows up there.
  const column = top.x - 30
  await page.mouse.move(column, top.y + top.height / 2)
  await page.mouse.move(column, low.y + low.height / 2, { steps: 5 })
  const grip = page.getByRole('button', { name: 'Drag to move, click to select' })
  await expect(grip).toBeVisible()
  // Beside the second paragraph, where the mouse is, not still beside the first.
  await expect
    .poll(async () => {
      const box = (await grip.boundingBox())!
      return box.y + box.height / 2 > low.y && box.y + box.height / 2 < low.y + low.height
    })
    .toBe(true)
  // Taken there and dropped there, above the first paragraph, without going over the text.
  const handle = (await grip.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(column, top.y + 2, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Left second.')
  await saved(page)
  expect(onDisk('Zoo/Grip left.md')).toBe(before.replace('Left second.\n\n', '').replace('# Grip left\n\n', '# Grip left\n\nLeft second.\n\n'))
})

test('the grip beside a block says what it does, selects the block on a click and moves it when dragged', async ({ page }) => {
  await edit(page, 'Zoo/Grip.md')
  const before = onDisk('Zoo/Grip.md')
  const second = page.locator('.ProseMirror p', { hasText: 'Second paragraph.' })
  await second.hover()
  const grip = page.getByRole('button', { name: 'Drag to move, click to select' })
  await expect(grip).toBeVisible()
  await expect(grip).toHaveAttribute('title', 'Drag to move, click to select')
  await expect(page.getByRole('button', { name: 'Add a block below' })).toHaveAttribute('title', 'Add a block below')
  await grip.click()
  await expect(second).toHaveClass(/ProseMirror-selectednode/)

  // Dragged above the first paragraph: only the order changes, every block as it was written.
  await second.hover()
  const first = page.locator('.ProseMirror p', { hasText: 'First' })
  const box = (await first.boundingBox())!
  await grip.dragTo(first, { targetPosition: { x: 20, y: 2 } })
  await expect(page.locator('.ProseMirror > p').first()).toHaveText('Second paragraph.')
  await saved(page)
  expect(onDisk('Zoo/Grip.md')).toBe(before.replace('Second paragraph.\n\n', '').replace('# Grip\n\n', '# Grip\n\nSecond paragraph.\n\n'))
  expect(box.height).toBeGreaterThan(0)
})

test('the line numbers of the file stand beside the text, follow typing, and are there in the Markdown view too', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.removeItem('nexlore.lineNumbers'))
  await edit(page, 'Zoo/Lines.md')
  const bar = page.getByTestId('editor-toolbar')
  const numbers = page.getByTestId('line-numbers').locator('.nx-line')
  await expect(numbers).toHaveCount(0)
  await bar.getByRole('button', { name: 'Line numbers of the file' }).click()
  await expect(bar.getByRole('button', { name: 'Line numbers of the file' })).toHaveAttribute('aria-pressed', 'true')
  // The front matter takes lines 1 to 3; a paragraph over two lines has the first; list items and table rows their own.
  await expect(numbers).toHaveText(['4', '6', '9', '10', '11', '13', '15', '17'])
  // Beside its block, on its first line.
  const last = (await page.locator('.ProseMirror p', { hasText: 'Last.' }).boundingBox())!
  const seventeen = (await numbers.last().boundingBox())!
  expect(Math.abs(seventeen.y + seventeen.height / 2 - (last.y + 12))).toBeLessThan(8)
  expect(seventeen.x + seventeen.width).toBeLessThan(last.x)

  // Typed: the new paragraph is line 19 of what is saved.
  await page.locator('.ProseMirror p', { hasText: 'Last.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Added.')
  await expect(numbers).toHaveText(['4', '6', '9', '10', '11', '13', '15', '17', '19'])
  await saved(page)
  expect(onDisk('Zoo/Lines.md').split('\n')[18]).toBe('Added.')

  // Remembered in this browser, and in the Markdown view one per line.
  await edit(page, 'Zoo/Lines.md')
  await expect(page.getByTestId('editor-toolbar').getByRole('button', { name: 'Line numbers of the file' })).toHaveAttribute('aria-pressed', 'true')
  await expect(numbers).toHaveText(['4', '6', '9', '10', '11', '13', '15', '17', '19'])
  await page.getByTestId('editor-toolbar').getByRole('button', { name: 'Markdown source' }).click()
  const column = page.getByTestId('source-lines')
  await expect(column).toContainText('19')
  expect((await column.innerText()).trim().split('\n')).toHaveLength(onDisk('Zoo/Lines.md').split('\n').length)
})
