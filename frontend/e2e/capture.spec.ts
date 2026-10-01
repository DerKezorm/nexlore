/**
 * Quick capture: a long press on "+" opens it, Ctrl+Enter keeps the words in the inbox of the space chosen, the
 * newest on top; the space is chosen again next time; sharing to the app (`/capture?…`) brings the words along.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')
const ENTRY = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} /

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('a long press on + opens quick capture, and the words land on top of the inbox of the space', async ({ page }) => {
  const problems = collectProblems(page)
  // On a note the + makes a note beside it: never disabled there.
  await page.goto('/note/Heath/Heather.md')
  const plus = page.getByRole('button', { name: 'New note', exact: true })
  await expect(plus).toBeEnabled()
  const box = (await plus.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
  const dialog = page.getByTestId('capture-dialog')
  await expect(dialog).toBeVisible()
  // The long press is no click: no new note dialog on top.
  await expect(page.getByTestId('new-note-dialog')).toHaveCount(0)
  await dialog.getByRole('combobox', { name: 'Space' }).selectOption('Heath')
  await dialog.getByLabel('What to keep').fill('Buy seeds')
  await dialog.getByLabel('What to keep').press('Control+Enter')
  await expect(dialog.getByRole('status')).toContainText('Kept in the inbox of Heath')
  await expect(dialog.getByLabel('What to keep')).toHaveValue('')
  await dialog.getByLabel('What to keep').fill('Water the beds\nbefore noon')
  await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Kept in the inbox of Heath')
  const lines = onDisk('Heath/Inbox.md').split('\n')
  expect(lines[0]).toBe('# Inbox')
  expect(lines[2]).toMatch(ENTRY)
  expect(lines[2]).toMatch(/ Water the beds$/)
  expect(lines[3]).toBe('  before noon')
  expect(lines[4]).toMatch(/ Buy seeds$/)
  // Open leads to the inbox.
  await dialog.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/note\/Heath\/Inbox\.md/)
  await expect(dialog).toHaveCount(0)
  expect(problems).toEqual([])
})

test('sharing to the app brings the words, into the main space of the account', async ({ page }) => {
  // The main space is the account's (Settings, General), not remembered by the browser (P5.19); set back at the end.
  const headers = { 'X-Nexlore-Client': 'tab-e2e-capture0' }
  await page.request.put('/api/me/appearance', { data: { home_space: 'Moor' }, headers })
  await page.goto('/capture?title=Heron&text=Seen+at+the+pond&url=https%3A%2F%2Fexample.com%2Fheron')
  const dialog = page.getByTestId('capture-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Space' })).toHaveValue('Moor')
  await page.request.put('/api/me/appearance', { data: { home_space: '' }, headers })
  await expect(dialog.getByLabel('What to keep')).toHaveValue('Heron\nSeen at the pond\nhttps://example.com/heron')
  // Escape closes without keeping anything.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page).not.toHaveURL(/capture/)
  // Alt+Shift+N opens it too, empty.
  await page.keyboard.press('Alt+Shift+N')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('What to keep')).toHaveValue('')
  await page.keyboard.press('Escape')

  // A long press on a touch screen can end in a click on the same button: no new note dialog on top of it.
  await page.goto('/note/Heath/Heather.md')
  await page.getByRole('button', { name: 'New note', exact: true }).evaluate(async (button) => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 700))
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await expect(dialog).toBeVisible()
  // Given the time a dialog needs to come, had it been asked for.
  await page.waitForTimeout(300)
  await expect(page.getByTestId('new-note-dialog')).toHaveCount(0)
})
