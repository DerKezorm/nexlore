/** The interface in its languages: shipped ones by browser language, the operator's own from the server. */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('starts in English for an English browser, without a single console error', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/')
  const menu = page.getByRole('navigation', { name: 'Main menu' })
  await expect(menu.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Search/ })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(problems).toEqual([])
})

test.describe('a German browser', () => {
  test.use({ locale: 'de-DE' })

  test('gets German', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  })
})

test('the operator language is offered, falls back to English where it has no text, and stays after a reload', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared data directory')
  const problems = collectProblems(page)
  await page.goto('/settings')
  const select = page.getByLabel('Language of the interface')
  await expect(select.locator('option')).toHaveText(['English', 'Deutsch', 'Español (added by the operator)'])
  await select.selectOption('es')
  const menu = page.getByRole('navigation', { name: 'Main menu' })
  await expect(menu.getByRole('link', { name: 'Ajustes' })).toBeVisible()
  // Not in the Spanish file: English instead of a raw key.
  await expect(page.getByRole('heading', { name: 'Language', level: 2, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Ajustes' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  // The choice went with the account: a fresh browser of the same account starts in Spanish too.
  expect((await (await page.request.get('/api/auth/me')).json()).language).toBe('es')
  expect(problems).toEqual([])
  // Back to following the browser, for the tests after this one (they share the account).
  await page.request.put('/api/me/language', { data: { language: '' }, headers: { 'X-Nexlore-Client': 'tab-e2elanguage' } })
})

test('the template downloads as the English texts with a _meta entry', async ({ page }) => {
  await page.goto('/settings')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download template' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('nexlore-language-template.json')
  const content = JSON.parse(fs.readFileSync((await file.path())!, 'utf-8'))
  expect(content._meta.name).toBeTruthy()
  expect(content.nav.settings).toBe('Settings')
})

test('the server sends the security headers with the page', async ({ request }) => {
  const response = await request.get('/')
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(response.headers()['x-frame-options']).toBe('DENY')
  expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f]{6}$/)
})

test('a file of the operator for English lays its words over the shipped ones (P7.10)', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'writes a language file')
  const headers = { 'X-Nexlore-Client': 'tab-e2elanguage', 'Content-Type': 'application/json' }
  const put = await page.request.put('/api/locales/en', { data: JSON.stringify({ _meta: { name: 'English' }, tasks: { title: 'Chores' } }), headers })
  expect(put.status()).toBe(200)
  try {
    await page.goto('/tasks')
    await expect(page.getByRole('heading', { name: 'Chores', level: 1 })).toBeVisible()
    // Everything it leaves out stays as shipped.
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible()
  } finally {
    await page.request.delete('/api/locales/en', { headers })
  }
})
