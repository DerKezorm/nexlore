/**
 * A note named by the minute, from the command palette: made where a new note goes (the open note's folder),
 * opened for writing; a second one in the same minute is numbered.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-zettel' }

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const made: string[] = []

test.afterEach(async ({ page }) => {
  // Into the trash again: other tests count what is in Heath.
  // Away from the note first, so its editor lets go of it.
  await page.goto('/files')
  await page.waitForLoadState('networkidle')
  for (const note of made.splice(0)) {
    const gone = await page.request.delete('/api/files?path=' + encodeURIComponent(note), { headers: TAB })
    expect(gone.ok(), `${note}: ${gone.status()}`).toBe(true)
  }
})

async function zettel(page: Page): Promise<string> {
  const before = page.url()
  // The command is there once the spaces are (it goes where a new note goes); the palette reads its list when opened.
  await expect(page.getByRole('banner').getByRole('button', { name: 'New note' })).toBeEnabled()
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('named by the time')
  await expect(page.getByRole('dialog', { name: 'Commands' }).getByRole('button', { name: /^New note named by the time/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.url()).not.toBe(before)
  await expect(page).toHaveURL(/\/note\/Heath\/\d{12}(%20\d)?\.md/)
  const note = decodeURIComponent(new URL(page.url()).pathname.slice('/note/'.length))
  made.push(note)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  return note
}

test('a note named by the minute is made beside the open one and opened for writing', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  await expect(page.getByRole('heading', { name: 'Heather' }).first()).toBeVisible()
  const first = await zettel(page)
  expect(first).toMatch(/^Heath\/\d{12}\.md$/)
  // The minute of the browser's clock, as the name says.
  const stamp = first.slice('Heath/'.length, -3)
  const now = new Date()
  const minutes = (when: string) => new Date(+when.slice(0, 4), +when.slice(4, 6) - 1, +when.slice(6, 8), +when.slice(8, 10), +when.slice(10, 12)).getTime()
  expect(Math.abs(now.getTime() - minutes(stamp))).toBeLessThan(2 * 60_000)
  expect(fs.existsSync(path.join(DATA, 'vault', ...first.split('/')))).toBe(true)

  // Another in the same minute (if the clock did not just turn over): numbered, not the same file.
  const second = await zettel(page)
  expect(second).not.toBe(first)
  if (second.slice('Heath/'.length, 'Heath/'.length + 12) === stamp) expect(second).toBe(`Heath/${stamp} 2.md`)
  expect(problems).toEqual([])
})
