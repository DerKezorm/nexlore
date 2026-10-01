/**
 * "What's new" (block X3): after an update a banner under the header opens the written text of the version; closing
 * the window or putting the banner away tells the server, and it stays away. The account `tester` was made in the
 * running version, so the first answer of /api/auth/me is made older here.
 */
import { expect, test, type Page } from './fixtures'

// Otherwise the service worker answers and page.route sees nothing.
test.use({ serviceWorkers: 'block' })

async function comeFromAnOlderVersion(page: Page) {
  await page.route(
    '**/api/auth/me',
    async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), whats_new_seen: '0.0.1' } })
    },
    { times: 1 },
  )
}

test('the banner opens the window, and reading it puts it away for good', async ({ page }) => {
  const version = (await (await page.request.get('/api/auth/me')).json()).version as string
  await comeFromAnOlderVersion(page)
  await page.goto('/')
  const banner = page.getByTestId('whats-new-banner')
  await expect(banner).toContainText(`nexlore ${version} is here.`)
  await banner.getByRole('button', { name: "See what's new" }).click()
  const window = page.getByRole('dialog', { name: `What's new in nexlore ${version}` })
  await expect(window.getByRole('heading', { name: 'A display name for every account' })).toBeVisible()
  await expect(window.getByText('Account menu, My account, Profile, Display name')).toBeVisible()
  const seen = page.waitForResponse((answer) => answer.url().endsWith('/api/me/whats-new/seen') && answer.request().method() === 'POST')
  await window.getByRole('button', { name: 'Got it' }).click()
  expect((await seen).status()).toBe(200)
  await expect(window).toBeHidden()
  await expect(banner).toBeHidden()
  // Read means read: once the texts are there (the about page offers them), the banner stays away.
  await page.goto('/about')
  await expect(page.getByRole('button', { name: `What's new in nexlore ${version}` })).toBeVisible()
  await expect(banner).toBeHidden()
})

test('the banner can be put away without reading, and the about page opens the text again', async ({ page }) => {
  await comeFromAnOlderVersion(page)
  await page.goto('/')
  const banner = page.getByTestId('whats-new-banner')
  const seen = page.waitForResponse((answer) => answer.url().endsWith('/api/me/whats-new/seen'))
  await banner.getByRole('button', { name: 'Put away' }).click()
  await seen
  await expect(banner).toBeHidden()
  await page.goto('/about')
  const version = (await (await page.request.get('/api/auth/me')).json()).version as string
  await page.getByRole('button', { name: `What's new in nexlore ${version}` }).click()
  await expect(page.getByRole('dialog', { name: `What's new in nexlore ${version}` })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})
