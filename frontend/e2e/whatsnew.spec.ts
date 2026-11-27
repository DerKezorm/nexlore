/**
 * "What's new" (the shared module wasneu since 1.17.0): after an update a banner under the header opens the written
 * text of the version; "Got it" or putting the banner away tells the server, and it stays away. The account `tester`
 * was made in the running version, so the first answer of /api/whats-new is made to come from an older one here: the
 * running version's entry unread, as after an update.
 */
import { expect, test, type Page } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

/** The first section of the written text of a version, as the window shows it (the texts are the server's). */
function firstSection(version: string): { title: string; where: string } {
  const texts = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'backend', 'app', 'whatsnew', 'en.json'), 'utf-8'))
  return texts[version].sections[0]
}

// Otherwise the service worker answers and page.route sees nothing.
test.use({ serviceWorkers: 'block' })

async function comeFromAnOlderVersion(page: Page): Promise<string> {
  const history = (await (await page.request.get('/api/whats-new/history?language=en')).json()) as { version: string; entries: { version: string }[] }
  const newest = history.entries[0]!
  await page.route(
    /\/api\/whats-new\?/,
    async (route) => {
      const response = await route.fetch()
      const answer = (await response.json()) as Record<string, unknown>
      await route.fulfill({ response, json: { ...answer, seen: '0.0.1', unread: [newest], more: false } })
    },
    { times: 1 },
  )
  return history.version
}

test('the banner opens the window, and reading it puts it away for good', async ({ page }) => {
  const version = await comeFromAnOlderVersion(page)
  await page.goto('/')
  const banner = page.getByTestId('whats-new-banner')
  await expect(banner).toContainText(`nexlore ${version} is here.`)
  await banner.getByTestId('whats-new-show').click()
  const window = page.getByTestId('whats-new-window')
  const first = firstSection(version)
  await expect(window.getByRole('heading', { name: first.title })).toBeVisible()
  await expect(window.getByText(first.where).first()).toBeVisible()
  const seen = page.waitForResponse((answer) => answer.url().endsWith('/api/whats-new/seen') && answer.request().method() === 'POST')
  await window.getByRole('button', { name: 'Got it' }).click()
  expect((await seen).status()).toBe(200)
  await expect(window).toBeHidden()
  await expect(banner).toBeHidden()
  // Read means read: the about page offers the text, and the banner stays away.
  await page.goto('/about')
  await expect(page.getByRole('button', { name: `New in nexlore ${version}` })).toBeVisible()
  await expect(banner).toBeHidden()
})

test('the banner can be put away without reading, and the about page opens the text again', async ({ page }) => {
  const version = await comeFromAnOlderVersion(page)
  await page.goto('/')
  const banner = page.getByTestId('whats-new-banner')
  const seen = page.waitForResponse((answer) => answer.url().endsWith('/api/whats-new/seen'))
  await banner.getByTestId('whats-new-put-away').click()
  await seen
  await expect(banner).toBeHidden()
  await page.goto('/about')
  await page.getByRole('button', { name: `New in nexlore ${version}` }).click()
  await expect(page.getByTestId('whats-new-window')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('whats-new-window')).toBeHidden()
})
