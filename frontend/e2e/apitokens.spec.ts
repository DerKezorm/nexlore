/**
 * API tokens through the interface: the operator switches them on, the account makes a token and sees it once with the
 * header line, a program reads and writes with it, the list notes its use, the operator blocks it, and the account sees
 * it blocked. A request from a web page (with an Origin) is refused.
 */
import { expect, test } from './fixtures'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-apitoken' }

test.skip(!!process.env.E2E_BASE_URL, 'changes the server settings')

test('a token made on the account page works for a program until the operator blocks it', async ({ page, playwright, baseURL }) => {
  const program = await playwright.request.newContext({ baseURL })
  const title = `Api note ${Date.now()}`
  try {
    // The operator's switch, on the card "Schnittstellen" under Server › General (the shared key module).
    await page.goto('/settings?tab=server&sub=extensions#api-tokens')
    await expect(page).toHaveURL(/\/settings\/server-connections#api-tokens$/)
    const saved = page.waitForResponse((answer) => answer.url().endsWith('/api/connections/interfaces') && answer.request().method() === 'PUT')
    // The tick follows the server's answer (the card of the module saves at once).
    await page.getByTestId('interfaces-api').click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByTestId('interfaces-api')).toBeChecked()

    // The account: in Connections, the devices first, the API keys after nexlore's own cards.
    await page.goto('/settings/connections')
    await expect(page).toHaveURL(/\/settings\/connections/)
    const own = page.locator('[data-card="api-keys"]')
    await expect(page.locator('[data-card]').first()).toHaveAttribute('data-card', 'devices')
    await own.getByTestId('api-keys-new').click()
    const dialog = page.getByTestId('key-dialog')
    await dialog.getByTestId('key-name').fill('n8n')
    await dialog.getByTestId('key-right').getByRole('radio', { name: /^Write/ }).check()
    await dialog.getByTestId('key-expiry').selectOption('30')
    await dialog.getByTestId('key-submit').click()
    const shown = own.getByTestId('key-made')
    await expect(shown).toContainText('It is shown this once only')
    const token = (await shown.getByTestId('key-secret').locator('input').inputValue()).trim()
    expect(token).toMatch(/^nxa_[A-Za-z0-9_-]{40,}$/)
    await expect(shown.getByTestId('key-header').locator('input')).toHaveValue(`Authorization: Bearer ${token}`)
    await shown.getByTestId('key-done').click()
    await expect(own.getByTestId('key-made')).toHaveCount(0)
    await expect(page.getByText(token)).toHaveCount(0)
    await expect(own.getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'n8n' })).toContainText('Write')
    await expect(own.getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'n8n' })).toContainText(/\d/)

    // A program: no cookie, no tab, the token in Authorization.
    const auth = { Authorization: `Bearer ${token}` }
    const me = await program.get('/api/v1/me', { headers: auth })
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ level: 'write', spaces: null })
    const made = await program.post('/api/v1/notes', { headers: auth, data: { folder: 'Zoo', title, content: `# ${title}\n\nFrom a program.\n` } })
    expect(made.status()).toBe(201)
    expect((await program.get('/api/v1/dashboard', { headers: auth })).status()).toBe(200)
    // A web page is refused, even with the token.
    expect((await program.get('/api/v1/me', { headers: { ...auth, Origin: 'https://evil.example.com' } })).status()).toBe(403)
    await page.reload()
    await expect(own.getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'n8n' })).not.toContainText('Never')

    // The note is there for the interface too.
    await page.goto(`/note/Zoo/${encodeURIComponent(title)}.md`)
    await expect(page.getByText('From a program.')).toBeVisible()

    // The operator blocks it; the program is out, the account sees why.
    await page.goto('/settings/accounts')
    const all = page.locator('[data-card="all-api-keys"]')
    await all.getByTestId('all-keys-row').filter({ visible: true }).filter({ hasText: 'n8n' }).getByTestId('all-keys-block').click()
    await page.getByTestId('all-keys-block-dialog').getByRole('button', { name: 'Lock' }).click()
    await expect(all.getByTestId('all-keys-row').filter({ visible: true }).filter({ hasText: 'n8n' })).toHaveAttribute('data-blocked', 'true')
    expect((await program.get('/api/v1/me', { headers: auth })).status()).toBe(401)
    await page.goto('/settings/connections')
    await expect(page.locator('[data-card="api-keys"]').getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'n8n' }).getByTestId('key-blocked')).toBeVisible()
  } finally {
    await program.dispose()
    await page.request.delete(`/api/files?path=${encodeURIComponent(`Zoo/${title}.md`)}`, { headers: TAB })
    const listed = await (await page.request.get('/api/api-tokens')).json()
    for (const token of listed.tokens ?? []) await page.request.delete(`/api/api-tokens/${token.id}`, { headers: TAB })
    await page.request.put('/api/settings', { data: { api_tokens_allowed: false }, headers: TAB })
  }
})

test('without the operator the card says so and points the operator to the switch', async ({ page }) => {
  await page.request.put('/api/settings', { data: { api_tokens_allowed: false }, headers: TAB })
  await page.goto('/settings/connections')
  await expect(page.getByTestId('api-keys-off')).toContainText('The operator has switched the programming interface off.')
  await expect(page.getByTestId('api-keys-off')).toContainText('Switch it on under Server › Connections › Interfaces.')
})
