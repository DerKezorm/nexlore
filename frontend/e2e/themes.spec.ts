/** Colour themes per account, made and shared; a space's theme under its notes; own CSS behind the operator's switch. */
import { expect, test, type Page } from '@playwright/test'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const accent = (page: Page, selector = ':root') =>
  page.evaluate((where) => getComputedStyle(document.querySelector(where)!).getPropertyValue('--color-accent-500').trim(), selector)

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')
test.describe.configure({ mode: 'serial' })

test('a theme is chosen, a new one made in the editor with a warning for weak text, and both stay with the account', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings?tab=looks')
  const themes = page.getByTestId('themes')
  await themes.locator('[data-theme-ref="plum"]').click()
  await expect(themes.locator('[data-theme-ref="plum"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => accent(page)).toBe('#e879f9')
  await page.reload()
  await expect.poll(() => accent(page)).toBe('#e879f9')
  // A new theme: the page shows it while it is edited; weak text is named.
  await themes.getByRole('button', { name: 'New theme' }).click()
  const editor = page.getByTestId('theme-editor')
  await editor.getByLabel('Name of the theme').fill('Signal')
  await editor.getByLabel('Accent (Dark)', { exact: true }).fill('#ff3355')
  await expect.poll(() => accent(page)).toBe('#ff3355')
  await editor.getByLabel('Text, faint (Dark)', { exact: true }).fill('#202030')
  await expect(page.getByTestId('theme-weak')).toContainText('Text, faint')
  await editor.getByLabel('Text, faint (Dark)', { exact: true }).fill('#a0a0b0')
  await expect(page.getByTestId('theme-weak')).toHaveCount(0)
  await editor.getByLabel('Share in the gallery').check()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
  const mine = themes.getByRole('button', { name: /^Signal/ })
  await expect(mine).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect.poll(() => accent(page)).toBe('#ff3355')
  // Cancelling an edit brings back the theme in force.
  await themes.getByRole('button', { name: 'New theme' }).click()
  await page.getByTestId('theme-editor').getByLabel('Accent (Dark)', { exact: true }).fill('#00ff00')
  await expect.poll(() => accent(page)).toBe('#00ff00')
  await page.getByTestId('theme-editor').getByRole('button', { name: 'Cancel' }).click()
  await expect.poll(() => accent(page)).toBe('#ff3355')
  // Back to nexlore's own.
  await themes.locator('[data-theme-ref="nexlore"]').click()
  await expect.poll(() => accent(page)).toBe('#2dd4bf')
  expect(problems).toEqual([])
})

test('a space colours its notes, and a reader who does not want that sees their own theme', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings?tab=spaces')
  await page.locator('#spaces li').filter({ hasText: 'Zyx' }).getByRole('button', { name: 'Options' }).click()
  const dialog = page.getByRole('dialog', { name: /Options of “Zyx”/ })
  await dialog.getByLabel('Theme of the notes').selectOption('ember')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByText(/Saved/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).first().click()
  await page.goto('/note/Zyx/Palette.md')
  const pane = page.locator('main[data-pane="left"]')
  await expect(pane).toHaveAttribute('data-space-theme', 'ember')
  await expect.poll(() => accent(page, 'main[data-pane="left"]')).toBe('#fb923c')
  // The header keeps the reader's own.
  await expect.poll(() => accent(page)).toBe('#2dd4bf')
  await page.goto('/settings?tab=looks')
  // Saved before leaving: the page goes on at once, the answer may still be under way (seen twice in a full run).
  const off = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().postData()?.includes('"space_themes":false') === true)
  await page.getByTestId('appearance').getByLabel(/Take the themes of spaces/).uncheck()
  await off
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('main[data-pane="left"]')).not.toHaveAttribute('data-space-theme', /.+/)
  // Back as it was.
  await page.goto('/settings?tab=looks')
  const on = page.waitForResponse((response) => response.url().includes('/api/me/appearance') && response.request().postData()?.includes('"space_themes":true') === true)
  await page.getByTestId('appearance').getByLabel(/Take the themes of spaces/).check()
  await on
  await page.goto('/settings?tab=spaces')
  await page.locator('#spaces li').filter({ hasText: 'Zyx' }).getByRole('button', { name: 'Options' }).click()
  await page.getByRole('dialog', { name: /Options of “Zyx”/ }).getByLabel('Theme of the notes').selectOption('')
  await page.getByRole('dialog', { name: /Options of “Zyx”/ }).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Options of “Zyx”/ }).getByText(/Saved/)).toBeVisible()
  expect(problems).toEqual([])
})

test('own CSS waits for the operator, refuses what could load from elsewhere, and styles the own pages', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/settings?tab=looks')
  const snippets = page.getByTestId('snippets')
  await expect(snippets).toContainText('The operator has not allowed own CSS')
  await page.goto('/settings?tab=server&sub=extensions')
  await page.locator('#css').getByRole('checkbox', { name: 'Allow own CSS' }).click()
  await page.goto('/settings?tab=looks')
  await snippets.getByRole('button', { name: 'New snippet' }).click()
  const editor = page.getByTestId('snippet-editor')
  await editor.getByLabel('CSS of the snippet').fill('.nn-prose h1 {\n  background: url(https://example.com/x.png);\n}')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Line 2: url() is not allowed here.')
  await editor.getByLabel('CSS of the snippet').fill('.nn-prose h1 { letter-spacing: 3px; }')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article.nn-prose h1')).toHaveCSS('letter-spacing', '3px')
  // Switched off: gone from the page.
  await page.goto('/settings?tab=looks')
  await snippets.getByRole('checkbox').uncheck()
  await page.goto('/note/Zyx/Palette.md')
  await expect(page.locator('article.nn-prose h1')).not.toHaveCSS('letter-spacing', '3px')
  await page.goto('/settings?tab=server&sub=extensions')
  await page.locator('#css').getByRole('checkbox', { name: 'Allow own CSS' }).click()
  // The refused snippet answered 422, as it should; the browser logs that answer.
  expect(problems.filter((problem) => !problem.includes('status of 422'))).toEqual([])
})
