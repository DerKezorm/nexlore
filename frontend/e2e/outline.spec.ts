/** Beside the note its outline; in the sidebar the tags as a tree, renamed everywhere; the notes opened last. */
import { expect, test, type Page } from '@playwright/test'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('the outline lists the headings and scrolls to one, lighting the heading in view', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/note/Zyx/Palette.md')
  const outline = page.getByTestId('outline')
  await expect(outline.getByRole('button')).toHaveText(['Palette', 'First part', 'Far down'])
  await expect(outline.getByRole('button', { name: 'Palette' })).toHaveAttribute('aria-current', 'location')
  await outline.getByRole('button', { name: 'Far down' }).click()
  await expect(page.getByRole('heading', { name: 'Far down' })).toBeInViewport()
  await expect(outline.getByRole('button', { name: 'Far down' })).toHaveAttribute('aria-current', 'location')
  expect(problems).toEqual([])
})

test('the tags as a tree: a click shows the notes, and a rename changes the text of the notes', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zyx/Palette.md')
  await page.getByRole('tab', { name: 'Tags' }).click()
  const tags = page.getByTestId('tag-tree')
  const pal = tags.getByRole('button', { name: /^# pal \d+$/ })
  await expect(pal).toBeVisible()
  await pal.click()
  // Below "pal": the tag "one", and the note that carries "pal" itself.
  const underPal = tags.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^# pal \d+$/ }) })
  await expect(underPal.getByRole('button', { name: /^# one 1$/ })).toBeVisible()
  await tags.getByRole('button', { name: 'Tagged' }).click()
  await expect(page).toHaveURL(/\/note\/Zyx\/Tagged\.md$/)
  // Remembered in this browser.
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Tags' })).toHaveAttribute('aria-selected', 'true')
  await tags.getByRole('button', { name: /^# pal \d+$/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename tag …' }).click()
  const dialog = page.getByTestId('name-dialog')
  await dialog.getByRole('textbox').fill('board')
  await dialog.getByRole('button', { name: 'Rename' }).click()
  await expect(page.getByText('Renamed in 1 note.')).toBeVisible()
  await expect(tags.getByRole('button', { name: /^# board \d+$/ })).toBeVisible()
  await expect(tags.getByRole('button', { name: /^# pal \d+$/ })).toHaveCount(0)
  // The note itself: the text says so once it is read again; "#palette" is another tag and stayed.
  await page.reload()
  await expect(page.locator('article')).toContainText('One #board/one here, and #palette stays.')
  await page.getByRole('tab', { name: 'Spaces' }).click()
  expect(problems).toEqual([])
})

test('the notes opened last are on the empty note page and in the quick switcher with nothing typed', async ({ page }) => {
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article')).toContainText('The end.')
  await page.goto('/note/Home/Shopping.md')
  await expect(page.locator('article')).toContainText('quinceapple')
  await page.goto('/note')
  const start = page.getByTestId('note-start')
  await expect(start.getByRole('heading', { name: 'Opened last' })).toBeVisible()
  await expect(start.getByRole('button').filter({ hasText: /^(Shopping|Palette)/ }).first()).toContainText('Shopping')
  await page.keyboard.press('ControlOrMeta+k')
  const first = page.getByRole('dialog', { name: 'Search' }).getByRole('button').first()
  await expect(first).toContainText('Shopping')
})

test('the reading view draws formulas, Mermaid diagrams, footnotes and the colours of code', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/note/Zyx/Rich.md')
  const article = page.locator('article')
  await expect(article.locator('.nn-math .katex')).toHaveCount(2)
  await expect(article.locator('.nn-math[data-display="true"] .katex-display')).toHaveCount(1)
  await expect(article.locator('.nn-mermaid svg')).toBeVisible({ timeout: 15000 })
  await expect(article.locator('.nn-mermaid svg')).toContainText('Start')
  await expect(article.locator('pre code .tok-keyword').first()).toHaveText('const')
  await expect(article.locator('pre code .tok-comment')).toHaveText('// the answer')
  const footnotes = article.locator('.nn-footnotes li')
  await expect(footnotes).toHaveText(['Said by nobody. ↩'])
  await article.locator('.nn-fn-ref a').click()
  await expect(footnotes.first()).toBeInViewport()
  // In the editor a Mermaid block and a formula block show what they draw below their code, as in Obsidian.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror .nn-mermaid-preview svg')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.ProseMirror .nn-math-preview .katex-display')).toHaveCount(1)
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  expect(problems).toEqual([])
})
