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
    // The operator's switch, on its card in the settings.
    await page.goto('/settings?tab=server&sub=extensions')
    const card = page.locator('#api-tokens')
    const saved = page.waitForResponse((answer) => answer.url().endsWith('/api/settings') && answer.request().method() === 'PUT')
    await card.getByRole('checkbox', { name: 'Accounts may make API tokens' }).check()
    expect((await saved).status()).toBe(200)

    // The account: at the top of Connections, above MCP.
    await page.goto('/account?tab=ai')
    const own = page.locator('#api-tokens')
    await expect(page.locator('section').first()).toHaveAttribute('id', 'api-tokens')
    await own.getByRole('button', { name: 'New token' }).click()
    await own.getByLabel('Name, so you know it again').fill('n8n')
    await own.getByRole('radio', { name: /^Write/ }).check()
    await own.getByRole('radio', { name: 'in 30 days' }).check()
    await own.getByRole('button', { name: 'Make', exact: true }).click()
    const shown = page.getByTestId('api-token-shown')
    await expect(shown).toContainText('It is shown only now.')
    const token = (await shown.locator('code').first().textContent())!.trim()
    expect(token).toMatch(/^nxa_[A-Za-z0-9_-]{40,}$/)
    await expect(shown.locator('pre').nth(0)).toHaveText(`Authorization: Bearer ${token}`)
    await expect(shown.locator('pre').nth(1)).toHaveText(`curl -H "Authorization: Bearer ${token}" ${new URL(page.url()).origin}/api/v1/me`)
    await shown.getByRole('button', { name: 'I have it' }).click()
    await expect(page.getByTestId('api-token-shown')).toHaveCount(0)
    await expect(page.getByText(token)).toHaveCount(0)
    await expect(own.getByTestId('api-token')).toContainText('Write')
    await expect(own.getByTestId('api-token-end')).toContainText('runs out on')

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
    await expect(own.getByTestId('api-token')).not.toContainText('never used')

    // The note is there for the interface too.
    await page.goto(`/note/Zoo/${encodeURIComponent(title)}.md`)
    await expect(page.getByText('From a program.')).toBeVisible()

    // The operator blocks it; the program is out, the account sees why.
    await page.goto('/settings?tab=server&sub=extensions')
    await page.getByRole('button', { name: /^Block token n8n of / }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click()
    await expect(page.locator('#api-tokens').getByText('blocked', { exact: true })).toBeVisible()
    expect((await program.get('/api/v1/me', { headers: auth })).status()).toBe(401)
    await page.goto('/account?tab=ai')
    await expect(page.getByTestId('api-token-blocked')).toHaveText('blocked by the operator')
  } finally {
    await program.dispose()
    await page.request.delete(`/api/files?path=${encodeURIComponent(`Zoo/${title}.md`)}`, { headers: TAB })
    const listed = await (await page.request.get('/api/api-tokens')).json()
    for (const token of listed.tokens ?? []) await page.request.delete(`/api/api-tokens/${token.id}`, { headers: TAB })
    await page.request.put('/api/settings', { data: { api_tokens_allowed: false }, headers: TAB })
  }
})

test('without the operator the card says so and points the operator to the switch', async ({ page }) => {
  await page.goto('/account?tab=ai')
  await expect(page.getByTestId('api-tokens-off')).toContainText('The operator has not switched API tokens on.')
  await page.getByRole('link', { name: 'Switch them on under Settings → Server → AI, API and plugins.' }).click()
  await expect(page.locator('#api-tokens')).toBeVisible()
})
