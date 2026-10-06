/**
 * Confirming the trash before the question "which files does only this note use?" came back: the deletion waits for
 * the answer, so the files go along, and nothing asks after the note once it is gone (no 404). The answer is held
 * back on purpose; the service worker would answer past page.route.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-trashalong' }

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')
test.use({ serviceWorkers: 'block' })

test('the trash confirmed at once still takes the files only this note uses', async ({ page }, testInfo) => {
  const title = `Along ${testInfo.retry}${testInfo.repeatEachIndex}`
  const made = await page.request.post('/api/notes', { data: { folder: 'Work', title, content: 'With a picture.\n' }, headers: TAB })
  expect(made.status()).toBe(201)
  const note = (await made.json()).path as string
  const picture = Buffer.from(`made-up attachment of ${title}`)
  const uploaded = await page.request.post('/api/attachments', {
    params: { note, name: `${title}.txt` },
    data: picture,
    headers: { ...TAB, 'Content-Type': 'application/octet-stream' },
  })
  expect(uploaded.status()).toBe(201)
  const file = (await uploaded.json()).path as string
  expect(fs.existsSync(path.join(DATA, 'vault', ...file.split('/')))).toBe(true)
  // The note links it: only then is it a file only this note uses.
  const read = await (await page.request.get('/api/note', { params: { path: note } })).json()
  const relative = file.slice(note.lastIndexOf('/') + 1)
  const saved = await page.request.put('/api/note', {
    data: { path: note, content: `With a picture.\n\n[it](<${relative}>)\n`, base_hash: read.hash },
    headers: TAB,
  })
  expect(saved.status()).toBe(200)
  const own = await (await page.request.get('/api/files/own', { params: { path: note } })).json()
  expect(own.paths).toEqual([file])

  await page.route('**/api/files/own**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  const gone: string[] = []
  page.on('response', (response) => {
    if (response.status() === 404 && response.url().includes('/api/')) gone.push(response.url())
  })
  await page.goto('/note/' + note.split('/').map(encodeURIComponent).join('/'))
  await expect(page.locator('article')).toContainText('With a picture.')
  await page.locator('summary[aria-label="More"]').click()
  await page.getByTestId('note-menu').getByRole('button', { name: /Move to trash/ }).click()
  await page.getByRole('dialog', { name: /to the trash/ }).getByRole('button', { name: 'Move to trash' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect.poll(() => fs.existsSync(path.join(DATA, 'vault', ...file.split('/')))).toBe(false)
  expect(fs.existsSync(path.join(DATA, 'vault', ...note.split('/')))).toBe(false)
  await page.waitForLoadState('networkidle')
  expect(gone).toEqual([])
})
