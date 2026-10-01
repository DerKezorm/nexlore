/**
 * Dragging a block by its grip, in the app as it runs (review before 1.0.0, P3.5): a paragraph dropped between a
 * paragraph and a list lands between them, not inside the list's first item.
 */
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes a note of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-dragging' }
const START = 'Erster.\n\nZweiter.\n\nDritter.\n\n- Liste a\n- Liste b\n'

for (const where of ['between the paragraph and the list', 'on the lower half of the paragraph'] as const) {
  test(`a paragraph dragged ${where} stays out of the list`, async ({ page }) => {
    const title = where.startsWith('between') ? 'Drag between' : 'Drag lower'
    const made = await page.request.post('/api/notes', { data: { folder: 'Heath', title, content: START }, headers: TAB })
    expect(made.status()).toBe(201)
    const path = (await made.json()).path as string
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/note/' + path.split('/').map(encodeURIComponent).join('/'))
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const paragraph = (text: string) => page.locator('.ProseMirror > p', { hasText: text })
    await expect(paragraph('Erster.')).toBeVisible()
    const first = (await paragraph('Erster.').boundingBox())!
    const third = (await paragraph('Dritter.').boundingBox())!
    const list = (await page.locator('.ProseMirror > ul').boundingBox())!
    await page.mouse.move(first.x + 20, first.y + 8)
    const grip = page.locator('.milkdown-block-handle')
    await expect(grip).toBeVisible()
    const handle = (await grip.boundingBox())!
    const [hx, hy] = [handle.x + handle.width - 14, handle.y + handle.height / 2]
    const ty = where.startsWith('between') ? (third.y + third.height + list.y) / 2 : third.y + third.height - 4
    await page.mouse.move(hx, hy)
    await page.mouse.down()
    await page.mouse.move(hx + 10, hy + 10, { steps: 5 })
    for (let i = 1; i <= 15; i++) await page.mouse.move(hx + 20 + i * 5, hy + ((ty - hy) * i) / 15, { steps: 2 })
    await page.mouse.move(third.x + 60, ty, { steps: 3 })
    const saved = page.waitForResponse((response) => response.url().includes('/api/note') && response.request().method() === 'PUT')
    await page.mouse.up()
    await saved
    await expect
      .poll(async () => (await (await page.request.get('/api/note?path=' + encodeURIComponent(path))).json()).content)
      .toBe('Zweiter.\n\nDritter.\n\nErster.\n\n- Liste a\n- Liste b\n')
  })
}
