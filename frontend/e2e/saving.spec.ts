/**
 * A save that fails says why and is tried again (review before 1.0.0, P3.7 and P6.3): without a network the text
 * waits in the editor and goes out as soon as the network is back; a taken right is named.
 */
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes a note of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-saving0' }

async function note(page: import('@playwright/test').Page, title: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { folder: 'Heath', title, content: 'Anfang.\n' }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).path as string
}

const onDisk = async (page: import('@playwright/test').Page, path: string) =>
  (await (await page.request.get('/api/note?path=' + encodeURIComponent(path))).json()).content as string

test('without a network the text waits and goes out once the network is back', async ({ page, context }) => {
  const path = await note(page, 'Saving offline')
  await page.goto('/note/' + path.split('/').map(encodeURIComponent).join('/'))
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.ProseMirror p', { hasText: 'Anfang.' }).click()
  await page.keyboard.press('End')
  await context.setOffline(true)
  await page.keyboard.type(' Offline geschrieben.')
  const badge = page.getByRole('status').filter({ hasText: 'Not saved' })
  await expect(badge).toContainText('No connection to the server', { timeout: 15_000 })
  await expect(badge.getByRole('button', { name: 'Try again' })).toBeVisible()
  await context.setOffline(false)
  await expect.poll(() => onDisk(page, path), { timeout: 15_000 }).toBe('Anfang. Offline geschrieben.\n')
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
})
