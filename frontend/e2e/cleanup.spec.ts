/**
 * Mentions without a link in the column beside a note, turned into a link there; and the cleaning up page of a space:
 * lonely notes with their mentions, links to nothing made into notes.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('the cleaning up page lists what hangs loose, makes a missing note and links a mention', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/files')
  await page.getByRole('link', { name: 'Clean up' }).click()
  await expect(page).toHaveURL(/\/files\/cleanup$/)
  await page.getByRole('combobox', { name: 'Space' }).selectOption('Moor')
  const lonely = page.getByTestId('cleanup-lonely')
  const broken = page.getByTestId('cleanup-broken')
  // Pond heron has no link in or out; Walk is linked from Deep/Linked, Lost links out (to nothing).
  await expect(lonely.getByRole('listitem')).toHaveCount(2)
  await expect(lonely.getByRole('listitem').first()).toContainText('Lost')
  await expect(lonely.getByRole('listitem').nth(1)).toContainText('Pond heron')
  await expect(broken.getByRole('listitem')).toHaveCount(2)
  await expect(broken.getByRole('listitem').first()).toContainText('Bog myrtle')
  await expect(broken.getByRole('listitem').first()).toContainText('in Lost, line 3')

  // The mentions of the lonely heron: Walk names it; linked from here, it is lonely no more.
  const heron = lonely.getByRole('listitem').filter({ hasText: 'Pond heron' })
  await heron.getByRole('button', { name: 'Mentions' }).click()
  const place = heron.getByTestId('unlinked').locator('[data-mention]')
  await expect(place).toHaveCount(1)
  await expect(place).toContainText('We saw a pond heron by the water.')
  await place.getByRole('button', { name: 'Link' }).click()
  await expect(place).toHaveCount(0)
  await expect.poll(() => onDisk('Moor/Walk.md')).toBe('# Walk\n\nWe saw a [[Pond heron|pond heron]] by the water.\n')
  await expect(lonely.getByRole('listitem')).toHaveCount(1)

  // A link to nothing: made beside the note it stands in, and opened for writing.
  await broken.getByRole('listitem').filter({ hasText: 'Bog myrtle' }).getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/note\/Moor\/Bog%20myrtle\.md/)
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  expect(fs.existsSync(path.join(DATA, 'vault', 'Moor', 'Bog myrtle.md'))).toBe(true)
  expect(problems).toEqual([])
})

test('beside a note, unlinked mentions are looked for when opened and one becomes a link', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  fs.writeFileSync(path.join(DATA, 'vault', 'Moor', 'Sedge.md'), '# Sedge\n\nGrows in the wet.\n')
  fs.writeFileSync(path.join(DATA, 'vault', 'Moor', 'Bank.md'), '# Bank\n\nSedge and more sedge.\n')
  // The watcher reads the new files in; the note opens once it is known.
  await expect.poll(async () => (await page.request.get('/api/note?path=Moor%2FSedge.md')).status(), { timeout: 15_000 }).toBe(200)
  await expect.poll(async () => (await (await page.request.get('/api/mentions?path=Moor%2FSedge.md')).json()).places.length, { timeout: 15_000 }).toBe(2)
  await page.goto('/note/Moor/Sedge.md')
  const panel = page.getByTestId('note-panel')
  await panel.getByRole('tab', { name: /Links/ }).click()
  const unlinked = panel.getByTestId('unlinked')
  await unlinked.getByRole('button', { name: /Unlinked mentions/ }).click()
  await expect(unlinked.locator('[data-mention]')).toHaveCount(2)
  await expect(unlinked.getByRole('button', { name: 'Bank' })).toBeVisible()
  // The second place: written with the words as they stand.
  await unlinked.locator('[data-mention]').nth(1).getByRole('button', { name: 'Link' }).click()
  await expect.poll(() => onDisk('Moor/Bank.md')).toBe('# Bank\n\nSedge and more [[Sedge|sedge]].\n')
  // Now a backlink, and one mention left.
  const back = panel.locator('section').filter({ has: page.getByRole('heading', { name: /Backlinks/ }) })
  await expect(back.getByRole('button', { name: /Bank/ })).toBeVisible()
  await expect(unlinked.locator('[data-mention]')).toHaveCount(1)
  // Open stays open in this browser.
  await page.reload()
  await expect(panel.getByTestId('unlinked').locator('[data-mention]')).toHaveCount(1)
  expect(problems).toEqual([])
})
