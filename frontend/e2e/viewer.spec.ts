/**
 * Pictures over the whole page: a click while reading (a double click or the menu while writing) opens one, fitted or
 * at its own size, to zoom and move; the arrows go through the note's pictures; marked ones are saved together.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

/** The names in a ZIP file, read from its central directory. */
function zipNames(data: Buffer): string[] {
  const names: string[] = []
  let at = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = data.readUInt16LE(at + 10)
  at = data.readUInt32LE(at + 16)
  for (let index = 0; index < count; index++) {
    const length = data.readUInt16LE(at + 28)
    names.push(data.subarray(at + 46, at + 46 + length).toString('utf-8'))
    at += 46 + length + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32)
  }
  return names
}

const transform = (page: Page) => page.getByTestId('viewer-image').evaluate((image) => (image as HTMLElement).style.transform)

test('a picture read opens over the page, zooms, moves, goes on to the next, and marked ones are saved together', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Media/Gallery.md')
  const first = page.locator('article img').first()
  await expect(first).toBeVisible()
  await first.click()
  const viewer = page.getByTestId('image-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer).toContainText('sunset.png')
  await expect(viewer).toContainText('1 of 2')
  const zoom = page.getByTestId('viewer-zoom')
  // A small picture is shown at its own size; larger ones fitted.
  await expect(zoom).toHaveText('100 %')
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  await expect(zoom).toHaveText('125 %')
  await page.keyboard.press('1')
  await expect(zoom).toHaveText('100 %')
  // The wheel zooms where the mouse is; dragging moves the picture.
  const stage = (await page.getByTestId('viewer-image').boundingBox())!
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await page.mouse.wheel(0, -400)
  await expect.poll(async () => Number((await zoom.textContent())!.replace(/\D/g, ''))).toBeGreaterThan(150)
  const before = await transform(page)
  await page.mouse.down()
  await page.mouse.move(stage.x + stage.width / 2 + 80, stage.y + stage.height / 2 + 40, { steps: 5 })
  await page.mouse.up()
  expect(await transform(page)).not.toBe(before)
  // The next picture, with the arrow key; the one before comes again at its own size.
  await page.keyboard.press('ArrowRight')
  await expect(viewer).toContainText('beach.png')
  await expect(viewer).toContainText('2 of 2')
  await expect(zoom).toHaveText('100 %')
  // One saved straight.
  const single = page.waitForEvent('download')
  await viewer.getByRole('button', { name: 'Download', exact: true }).click()
  expect((await single).suggestedFilename()).toBe('beach.png')
  // Both marked (the strip below, and M for the one shown), saved as one ZIP named after the note.
  await viewer.getByRole('button', { name: 'Mark sunset.png' }).click()
  await page.keyboard.press('m')
  const both = page.waitForEvent('download')
  await viewer.getByRole('button', { name: 'Download 2 marked' }).click()
  const archive = await both
  expect(archive.suggestedFilename()).toBe('Gallery.zip')
  expect(zipNames(fs.readFileSync((await archive.path())!)).sort()).toEqual(['beach.png', 'sunset.png'])
  // Escape closes, and the page is as it was.
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(page).toHaveURL(/\/note\/Media\/Gallery\.md$/)
  expect(problems).toEqual([])
})

test('while writing, a double click on a picture or the menu opens it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Media/Gallery.md')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const picture = page.locator('.ProseMirror img').first()
  await expect(picture).toBeVisible({ timeout: 15_000 })
  await picture.dblclick()
  const viewer = page.getByTestId('image-viewer')
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  // The caret out of the embed again, so the picture shows instead of its text.
  await page.locator('.ProseMirror h1').click()
  await expect(picture).toBeVisible()
  await picture.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View picture' }).click()
  await expect(viewer).toBeVisible()
  await expect(viewer).toContainText('of 2')
  await page.keyboard.press('Escape')
})
