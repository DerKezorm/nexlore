/**
 * Finding from the review before 1.0.0 (block T): the quick switcher (Enter right after typing, the arrows, Escape and
 * Tab), tags and search hits that lead somewhere, live search, the sidebar following changes from outside, dragging
 * and the arrows in the sidebar.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'writes notes of its own')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-finding00' }

async function note(page: Page, folder: string, title: string, content: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { folder, title, content }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).path as string
}

const url = (at: string) => '/note/' + at.split('/').map(encodeURIComponent).join('/')

test('Enter right after typing opens what was typed, not what the list showed before (P4.1)', async ({ page }) => {
  await note(page, 'Heath', 'Quokka finding', 'A small marsupial.\n')
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  // Typed and sent at once: the list still shows the notes opened last.
  await page.keyboard.insertText('Quokka finding')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/note\/Heath\/Quokka%20finding\.md/)
})

test('the arrows keep the chosen line in sight; Escape closes from anywhere in it and Tab stays in it (P4.4, P8.5)', async ({ page }) => {
  for (let index = 0; index < 14; index++) await note(page, 'Heath', `Walrus row ${String(index).padStart(2, '0')}`, `Walrus ${index}.\n`)
  await page.setViewportSize({ width: 1200, height: 520 })
  await page.goto('/tasks')
  const opener = page.getByRole('button', { name: 'Search', exact: true })
  await opener.click()
  const switcher = page.getByRole('dialog', { name: 'Search' })
  await page.keyboard.type('Walrus row')
  // All fourteen first: arrows on a list still loading walk the old one.
  await expect.poll(() => switcher.getByRole('list').getByRole('button', { name: /Walrus row/ }).count()).toBeGreaterThanOrEqual(14)
  for (let step = 0; step < 12; step++) await page.keyboard.press('ArrowDown')
  await expect(switcher.locator('[data-active="true"]')).toBeInViewport()
  // Inside the list, which scrolls by itself: the chosen line lies within its box.
  const list = switcher.getByRole('list')
  const inside = await list.evaluate((box) => {
    const chosen = box.querySelector('[data-active="true"]')!.getBoundingClientRect()
    const frame = box.getBoundingClientRect()
    return { scrolled: box.scrollTop, within: chosen.top >= frame.top - 1 && chosen.bottom <= frame.bottom + 1, tall: box.scrollHeight > box.clientHeight }
  })
  expect(inside).toEqual({ scrolled: expect.any(Number), within: true, tall: true })
  expect(inside.scrolled).toBeGreaterThan(0)
  // Tab goes round inside, never to the page behind.
  for (let step = 0; step < 25; step++) await page.keyboard.press('Tab')
  expect(await switcher.evaluate((box) => box.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(switcher).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('a tag in a note shows the notes with that tag; a line of the search page opens the note there (P4.7, P4.8)', async ({ page }) => {
  const filler = Array.from({ length: 80 }, (_, index) => `Filler line ${index}.`).join('\n\n')
  const at = await note(page, 'Heath', 'Tagged finding', `Seen with #mudskipper here.\n\n${filler}\n\nThe gharial basks far below.\n`)
  await page.goto(url(at))
  await page.locator('.nn-prose [data-tag="mudskipper"]').click()
  await expect(page).toHaveURL(/\/search\?q=tag%3Amudskipper/)
  await expect(page.getByTestId('search-page').getByText('Tagged finding')).toBeVisible()
  await page.goto('/search?q=gharial')
  await page.getByTestId('search-page').getByRole('link', { name: /gharial basks/ }).click()
  await expect(page).toHaveURL(/hit=gharial/)
  const mark = page.locator('.nn-prose mark.nn-hit')
  await expect(mark).toHaveText(/gharial/i)
  await expect(mark).toBeInViewport()
})

test('the search page searches while typing (P4.17)', async ({ page }) => {
  await note(page, 'Heath', 'Live finding', 'The axolotl smiles.\n')
  await page.goto('/search')
  await page.getByRole('searchbox').pressSequentially('axolotl', { delay: 30 })
  await expect(page.getByTestId('search-page').getByText('Live finding')).toBeVisible()
  await expect(page).toHaveURL(/q=axolotl/)
})

test('the sidebar shows a note added outside the app without a reload (P4.9)', async ({ page }) => {
  test.skip(!DATA, 'needs the data directory')
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(url(await note(page, 'Heath', 'Outside finding base', 'x\n')))
  const tree = page.getByTestId('sidebar-tree')
  await expect(tree.getByRole('button', { name: 'Outside finding base' })).toBeVisible()
  fs.writeFileSync(path.join(DATA, 'vault', 'Heath', 'Outside finding new.md'), 'Made by another program.\n')
  await expect(tree.getByRole('button', { name: 'Outside finding new' })).toBeVisible({ timeout: 40_000 })
})

test('a note dragged onto a folder moves there; the arrows walk the tree (P4.16)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // A space of its own, first by name: at the top of the sidebar, whatever else the tests made.
  expect((await page.request.post('/api/spaces', { data: { name: 'Aadrag' }, headers: TAB })).status()).toBe(201)
  try {
    await page.request.post('/api/folders', { data: { parent: 'Aadrag', name: 'Drop finding', existing_ok: true }, headers: TAB })
    const at = await note(page, 'Aadrag', 'Dragged finding', 'x\n')
    await page.goto(url(at))
    const tree = page.getByTestId('sidebar-tree')
    const dragged = tree.getByRole('button', { name: 'Dragged finding' })
    const folder = tree.getByTestId('sidebar-folder').filter({ hasText: 'Drop finding' })
    await expect(dragged).toBeVisible()
    await expect(folder).toBeVisible()
    await dragged.dragTo(folder)
    await expect
      .poll(async () => (await page.request.get('/api/note?path=' + encodeURIComponent('Aadrag/Drop finding/Dragged finding.md'))).status())
      .toBe(200)
    // The arrows: from a row to the next one (on a page drawn after the move).
    await page.goto(url('Aadrag/Drop finding/Dragged finding.md'))
    const first = tree.locator('li[data-path] > button').first()
    await expect(first).toBeVisible()
    await first.focus()
    const before = await first.textContent()
    await page.keyboard.press('ArrowDown')
    const now = await page.evaluate(() => document.activeElement?.textContent ?? '')
    expect(now).not.toBe(before)
    expect(await tree.evaluate((box) => box.contains(document.activeElement))).toBe(true)
  } finally {
    await page.request.delete('/api/files?path=Aadrag', { headers: TAB })
  }
})
