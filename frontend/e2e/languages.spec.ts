/** The interface in its languages: shipped ones by browser language, the operator's own from the server. */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
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
  await expect(menu.getByRole('link', { name: 'Tasks' })).toBeVisible()
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
  try {
    const problems = collectProblems(page)
    await page.goto('/settings')
    const select = page.getByLabel('Language of the interface')
    await expect(select.locator('option')).toHaveText(['Deutsch', 'English', 'Español (added by the operator)'])
    // The interface speaks it at once, the account keeps it after: the reload below must not cut that off.
    const kept = page.waitForResponse((answer) => answer.url().endsWith('/api/me/language') && answer.request().method() === 'PUT')
    await select.selectOption('es')
    expect((await kept).ok()).toBe(true)
    // The settings sit in the account menu: its link says it in Spanish.
    const account = page.getByRole('banner').getByRole('button', { name: /^Account of / })
    await account.click()
    await expect(page.getByRole('link', { name: 'Ajustes' })).toBeVisible()
    await page.keyboard.press('Escape')
    // Not in the Spanish file: English instead of a raw key.
    await expect(page.getByRole('heading', { name: 'Language', level: 2, exact: true })).toBeVisible()
    await page.reload()
    await account.click()
    await expect(page.getByRole('link', { name: 'Ajustes' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    // The choice went with the account: a fresh browser of the same account starts in Spanish too.
    expect((await (await page.request.get('/api/auth/me')).json()).language).toBe('es')
    expect(problems).toEqual([])
  } finally {
    // Back to following the browser, for the tests after this one (they share the account).
    await page.request.put('/api/me/language', { data: { language: '' }, headers: { 'X-Nexlore-Client': 'tab-e2elanguage' } })
  }
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

test('the language picked in the account menu holds the first time, even when saving it takes a while', async ({ page }) => {
  const headers = { 'X-Nexlore-Client': 'tab-e2elanguage' }
  try {
    await page.request.put('/api/me/language', { data: { language: 'en' }, headers })
    // As on a slow NAS: the answer to the save comes after the page asked again who is signed in. Until 1.0.0 that
    // question answered with the old language and switched back; a second pick then seemed to work.
    await page.route('**/api/me/language', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue()
    })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { langs: string[] }).langs = seen
      new MutationObserver(() => seen.push(document.documentElement.lang)).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    })
    await page.getByRole('banner').getByRole('button', { name: /^Account of / }).click()
    const select = page.locator('select').filter({ has: page.locator('option[value="de"]') })
    await expect(select.locator('option[value="de"]')).toHaveCount(1)
    await select.selectOption('de')
    await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).language).toBe('de')
    await page.waitForTimeout(1500)
    expect(await page.evaluate(() => (window as unknown as { langs: string[] }).langs)).toEqual(['de'])
    await expect(page.getByRole('link', { name: 'Mein Konto' })).toBeVisible()
  } finally {
    await page.request.put('/api/me/language', { data: { language: '' }, headers })
  }
})
