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
    await expect(page.getByRole('heading', { name: 'Profil', level: 1 })).toBeVisible()
    await expect(page.getByTestId('settings-nav')).toContainText('Mein Konto')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  })
})

test('the operator language is offered, falls back to English where it has no text, and stays after a reload', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared data directory')
  try {
    const problems = collectProblems(page)
    await page.goto('/settings')
    // The language is a field of the profile (the shared account module), empty follows the browser.
    const select = page.getByTestId('profile-card').getByLabel('Language', { exact: true })
    await expect(select.locator('option')).toHaveText(['As the browser', 'Deutsch', 'English', 'Español (added by the operator)'])
    // The interface speaks it at once, the account keeps it after: the reload below must not cut that off.
    const kept = page.waitForResponse((answer) => answer.url().endsWith('/api/me/language') && answer.request().method() === 'PUT')
    await select.selectOption('es')
    expect((await kept).ok()).toBe(true)
    // The way to the settings at the foot of the sidebar says it in Spanish.
    const account = page.getByRole('link', { name: / · Ajustes$/ })
    await expect(account).toBeVisible()
    // Not in the Spanish file: English instead of a raw key.
    await expect(page.getByRole('heading', { name: 'Profile', level: 2, exact: true })).toBeVisible()
    await page.reload()
    await expect(account).toBeVisible()
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
  // Beside the languages the operator added (it stood beside the own language in the profile before).
  await page.goto('/settings/general')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download template' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('nexlore-language-template.json')
  const content = JSON.parse(fs.readFileSync((await file.path())!, 'utf-8'))
  expect(content._meta.name).toBeTruthy()
  expect(content.nav.settings).toBe('Settings')
})

test('the operator adds a language with its code and "Upload language", sees it as a chip and takes it out again', async ({ page }) => {
  test.skip(!!process.env.E2E_BASE_URL, 'writes a language file')
  const headers = { 'X-Nexlore-Client': 'tab-e2elanguage' }
  await page.request.delete('/api/locales/eo', { headers })
  try {
    await page.goto('/settings/general')
    const card = page.locator('[data-card="languages"]')
    await expect(card.getByTestId('languages-list')).toContainText('Deutsch · built in')
    // The kit's file button: "Upload language" beside the field, the file chosen at the click (as nexnotes).
    await expect(card.getByTestId('language-upload')).toContainText('Upload language')
    const file = card.getByTestId('language-upload-file')
    // Without a code there is nothing to upload.
    await expect(file).toBeDisabled()
    await card.getByLabel('Language code').fill('eo')
    await file.setInputFiles({ name: 'eo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ _meta: { name: 'Esperanto' }, nav: { settings: 'Agordoj' } })) })
    await expect(card).toContainText('Language added.')
    const chip = card.getByTestId('language-eo')
    await expect(chip).toContainText('Esperanto (eo)')
    // Removing asks first (sprachen 1.0.1): cancelled, the language stays; confirmed, it goes.
    await chip.getByRole('button', { name: 'Remove Esperanto' }).click()
    const asked = page.getByTestId('language-remove-dialog')
    await expect(asked).toBeVisible()
    await asked.getByRole('button', { name: 'Cancel' }).click()
    await expect(asked).toHaveCount(0)
    await expect(chip).toBeVisible()
    await chip.getByRole('button', { name: 'Remove Esperanto' }).click()
    await page.getByTestId('language-remove-dialog').getByRole('button', { name: 'Remove language' }).click()
    await expect(card.getByTestId('language-eo')).toHaveCount(0)
  } finally {
    await page.request.delete('/api/locales/eo', { headers })
  }
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

test('the language picked in the profile holds the first time, even when saving it takes a while', async ({ page }) => {
  const headers = { 'X-Nexlore-Client': 'tab-e2elanguage' }
  try {
    await page.request.put('/api/me/language', { data: { language: 'en' }, headers })
    // As on a slow NAS: the answer to the save comes after the page asked again who is signed in. Until 1.0.0 that
    // question answered with the old language and switched back; a second pick then seemed to work.
    await page.route('**/api/me/language', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      await route.continue()
    })
    await page.goto('/settings/profile')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { langs: string[] }).langs = seen
      new MutationObserver(() => seen.push(document.documentElement.lang)).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    })
    const select = page.getByTestId('profile-card').getByLabel('Language', { exact: true })
    await expect(select.locator('option[value="de"]')).toHaveCount(1)
    await select.selectOption('de')
    await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).language).toBe('de')
    await page.waitForTimeout(1500)
    expect(await page.evaluate(() => (window as unknown as { langs: string[] }).langs)).toEqual(['de'])
    await expect(page.getByTestId('settings-nav')).toContainText('Mein Konto')
  } finally {
    await page.request.put('/api/me/language', { data: { language: '' }, headers })
  }
})
