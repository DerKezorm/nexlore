/**
 * A link to a heading (`[[Note#Heading]]`) opens the note at that heading, not at the top; `[[#Heading]]` jumps
 * inside the same note. Case does not count, as for the note's name. Reading and writing alike.
 */
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('a link to a heading of another note opens it at that heading', async ({ page }) => {
  await page.goto('/note/Heath/Pointer.md')
  await page.locator('article a.nn-wikilink', { hasText: 'Far › far DOWN' }).click()
  await expect(page).toHaveURL(/\/note\/Heath\/Far\.md#far%20DOWN$/)
  const heading = page.locator('article h2', { hasText: 'Far down' })
  await expect(heading).toBeInViewport()
  await expect(page.locator('article h1', { hasText: 'Far' })).not.toBeInViewport()
})

test('a link to a heading of the same note jumps there', async ({ page }) => {
  await page.goto('/note/Heath/Pointer.md')
  const here = page.locator('article h2', { hasText: 'Here' })
  await expect(here).not.toBeInViewport()
  // A real link to this note, not a pale one that would make a note.
  const link = page.locator('article a.nn-wikilink', { hasText: /^Here$/ })
  await expect(link).toHaveAttribute('data-note', 'Heath/Pointer.md')
  await link.click()
  await expect(here).toBeInViewport()
  await expect(page).toHaveURL(/\/note\/Heath\/Pointer\.md$/)
})

test('in the editor the link leads to the heading too', async ({ page }) => {
  await page.goto('/note/Heath/Pointer.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByTestId('editor-toolbar').waitFor()
  await page.locator('.ProseMirror .nx-wiki[data-target]', { hasText: 'Far' }).first().click()
  await expect(page).toHaveURL(/\/note\/Heath\/Far\.md#far%20DOWN$/)
  await expect(page.locator('article h2', { hasText: 'Far down' })).toBeInViewport()
})

test('the title of an embedded part opens its note at that part', async ({ page }) => {
  await page.goto('/note/Heath/Embedder.md')
  await page.locator('article .nn-embedded-title').click()
  await expect(page).toHaveURL(/#Far%20down$/)
  await expect(page.locator('article h2', { hasText: 'Far down' })).toBeInViewport()
})
