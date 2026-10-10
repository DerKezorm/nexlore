/**
 * Pflichttests 33 and 34 of the shared sign-in blueprint (copied once from bauplaene/oidc, then nexlore's file).
 *
 * The provider is the stand-in of e2e/fake-postbox.mjs (an OpenID Connect provider over http on 8476 with a key made
 * at its start, sending the browser straight back with a code for whoever POST /oidc/next named). Never a real
 * provider, never the network. The page is the operator `tester` of the fixtures.
 */
import path from 'node:path'

import { request, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-oidc00' }
const PROVIDER = 'http://127.0.0.1:8476'
const ISSUER = `${PROVIDER}/oidc`
const PASSWORD = 'e2e provider test password'

test.skip(!!process.env.E2E_BASE_URL, 'needs the stand-in provider')

type Entry = { id: number; slug: string; label: string }

async function entries(page: Page): Promise<Entry[]> {
  return (await (await page.request.get('/api/oidc/admin/providers')).json()) as Entry[]
}

async function removeEntry(page: Page, slug: string): Promise<void> {
  for (const entry of await entries(page)) {
    if (entry.slug === slug) await page.request.delete(`/api/oidc/admin/providers/${entry.id}`, { headers: TAB })
  }
}

/** The public address of the e2e server: the authentik card stores one when it is pressed without (module 1.0.10). */
async function setAddress(page: Page, address: string, confirm = false): Promise<void> {
  const data = confirm ? { public_url: address, confirm_address: true } : { public_url: address }
  const done = await page.request.put('/api/settings', { data, headers: TAB })
  expect(done.ok(), await done.text()).toBe(true)
}

/** A picture for the review of the module (E2E_SHOTS names a folder); no other effect. */
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`) })
}

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && !/status of 4(04|09|22)/.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test('33: sign-in through the provider button ends in a session', async ({ page, browser, baseURL }) => {
  await removeEntry(page, 'standin33')
  const made = await page.request.post('/api/oidc/admin/providers', {
    data: { label: 'Stand-in 33', slug: 'standin33', issuer: ISSUER, client_id: 'e2e-client', client_secret: `e2e-${Date.now()}` },
    headers: TAB,
  })
  expect(made.ok(), await made.text()).toBe(true)
  // An account of its own, linked to the stand-in's person through its profile.
  const invite = await page.request.post('/api/invites', { data: { days: 1 }, headers: TAB })
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const outside = await request.newContext({ baseURL })
  expect((await outside.post(`/api/invite/${token}`, { data: { name: 'ossie', password: PASSWORD }, headers: TAB })).ok()).toBe(true)
  await outside.dispose()
  await fetch(`${ISSUER}/next`, { method: 'POST', body: JSON.stringify({ sub: 'ossie-33', preferred_username: 'someone-else' }) })
  const own = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const ossie = await own.newPage()
  await ossie.goto('/login')
  await ossie.getByLabel('Name').fill('ossie')
  await ossie.getByLabel('Password').fill(PASSWORD)
  await ossie.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(ossie).toHaveURL(/\/$/)
  await ossie.goto('/account?tab=security')
  const row = ossie.getByTestId('my-providers').locator('li').filter({ hasText: 'Stand-in 33' })
  await expect(row).toContainText('Not linked')
  await row.getByRole('button', { name: 'Link' }).click()
  await row.getByLabel('Password').fill(PASSWORD)
  await row.getByRole('button', { name: 'Link' }).click()
  await expect(ossie).toHaveURL(/\/account\?linked=standin33/)
  // The provider by the name on its button, not by the short name in the address.
  await expect(ossie.getByText('Your account is linked to Stand-in 33.')).toBeVisible()
  await expect(ossie.getByTestId('my-providers').locator('li').filter({ hasText: 'Stand-in 33' })).toContainText('Linked')
  await own.close()

  // A browser without a session: the button on the sign-in page, and in.
  const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const visitor = await fresh.newPage()
  const problems = collectProblems(visitor)
  await visitor.goto('/login')
  await visitor.getByRole('button', { name: /Sign in with|Mit .* anmelden/ }).filter({ hasText: 'Stand-in 33' }).click()
  await visitor.waitForURL((url) => !url.pathname.startsWith('/login') && !url.pathname.startsWith('/api/'))
  await expect(visitor).not.toHaveURL(/error=/)
  expect((await (await visitor.request.get('/api/auth/me')).json()).name).toBe('ossie')
  expect(problems).toEqual([])
  await fresh.close()
  // A stranger at the provider comes in with nothing: the sign-in page says why, in words.
  await fetch(`${ISSUER}/next`, { method: 'POST', body: JSON.stringify({ sub: 'stranger-33', email: 'ossie@example.com' }) })
  const strange = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const stranger = await strange.newPage()
  await stranger.goto('/login')
  await stranger.getByRole('button', { name: 'Sign in with Stand-in 33' }).click()
  await expect(stranger).toHaveURL(/\/login\?error=oidc_no_account/)
  await expect(stranger.getByText('There is no account for you here. Ask for an invitation')).toBeVisible()
  await strange.close()
  await removeEntry(page, 'standin33')
})

test('34: add, edit and remove a provider; the authentik card lists its steps', async ({ page }) => {
  const problems = collectProblems(page)
  await removeEntry(page, 'stand-in')
  await removeEntry(page, 'stand-in-2')
  await page.goto('/settings?tab=server&sub=signin')
  await expect(page.getByRole('heading', { name: 'Sign-in', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign-in providers' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'authentik in one step' })).toBeVisible()
  await page.getByRole('button', { name: 'Add a provider' }).click()
  const form = page.getByTestId('provider-form')
  await form.getByLabel('Name on the button').fill('Stand-in')
  // The short name follows the name until it is typed itself; the redirect address follows the short name.
  await expect(form.getByLabel('Short name')).toHaveValue('stand-in')
  await expect(form.getByRole('textbox', { name: 'Copy' })).toHaveValue(/\/api\/oidc\/stand-in\/callback$/)
  // An issuer that does not answer as one is refused at its field, and nothing is stored.
  await form.getByLabel('Issuer').fill(`${PROVIDER}/nothing-here`)
  await form.getByLabel('Client ID').fill('e2e-client')
  await form.getByLabel('Client secret').fill(`e2e-${Date.now()}`)
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form.getByRole('alert')).toBeVisible()
  await form.getByLabel('Issuer').fill(ISSUER)
  await form.getByRole('button', { name: 'Save' }).click()
  const list = page.getByTestId('provider-list')
  const row = list.locator('li').filter({ hasText: 'Stand-in' })
  await expect(row).toContainText(ISSUER)
  await expect(row).toContainText('on')
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(form.getByText('Short name: stand-in')).toBeVisible()
  await form.getByLabel('Name on the button').fill('Stand-in 2')
  await form.getByLabel('The provider checks the second factor itself').uncheck()
  await form.getByRole('button', { name: 'Save' }).click()
  const renamed = list.locator('li').filter({ hasText: 'Stand-in 2' })
  await expect(renamed).toBeVisible()
  // The sign-in page has its button now.
  const signIn = await (await page.request.get('/api/auth/methods')).json()
  expect(signIn.providers).toContainEqual({ slug: 'stand-in', label: 'Stand-in 2' })
  await renamed.getByRole('button', { name: 'Remove' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/accounts lose the link|Konten verlieren die Verknüpfung/)
  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(list.locator('li').filter({ hasText: 'Stand-in 2' })).toHaveCount(0)
  // The authentik card: an address nobody answers at gives the step list with the first step failed, in words.
  const card = page.locator('#sign-in-authentik')
  await card.getByLabel('Address of authentik').fill('http://127.0.0.1:9')
  await card.getByLabel('API token').fill(`e2e-${Date.now()}`)
  // Without a public address (a fresh app) the card suggests the browser's own and the button reads "Use it and set up".
  await card.getByRole('button', { name: /^Set up$|^Use it and set up$/ }).click()
  const steps = page.getByTestId('authentik-steps')
  await expect(steps).toContainText('Connection to authentik')
  await expect(steps).toContainText('authentik cannot be reached at this address')
  expect(problems).toEqual([])
  // The run stored the suggestion before it asked authentik: the server is left without an address again.
  await setAddress(page, '')
})

test('35: another issuer asks first in the authentik card, Yes runs the button again with the confirmation, No changes nothing', async ({ page }) => {
  const problems = collectProblems(page)
  // An address is set, so the button reads "Set up" (without one it reads "Use it and set up").
  await setAddress(page, `${PROVIDER}`)
  // There is no authentik stand-in here: the server's answer is played, and what the page sends is read.
  const sent: Array<{ url: string; token: string; confirm_issuer_change: boolean }> = []
  const steps = ['reached', 'signingKey', 'mapping', 'provider', 'application', 'filled']
  await page.route('**/api/oidc/authentik/setup', async (route) => {
    const body = route.request().postDataJSON() as (typeof sent)[number]
    sent.push(body)
    const answer = body.confirm_issuer_change
      ? { ok: true, steps: steps.map((key) => ({ key, ok: true, detail: key })), client_id: 'c', issuer: 'https://auth.example.com/o/x/', provider_id: 1, links_dropped: 2 }
      : { ok: false, steps: [{ key: 'reached', ok: false, detail: 'would change', reason: 'issuer_change', status: 0 }], client_id: '', issuer: '', provider_id: null, links_dropped: 0, count: 2 }
    await route.fulfill({ json: answer })
  })
  await page.goto('/settings?tab=server&sub=signin')
  const card = page.locator('#sign-in-authentik')
  await card.getByLabel('Address of authentik').fill('http://127.0.0.1:9')
  const token = `e2e-${Date.now()}`
  await card.getByLabel('API token').fill(token)
  const run = card.getByRole('button', { name: 'Set up', exact: true })
  await run.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Another issuer is another provider. 2 accounts will have to link again afterwards.')
  // No failure on the page behind the question: the button waits for the answer.
  await expect(page.getByTestId('authentik-steps')).toHaveCount(0)
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(sent.map((body) => body.confirm_issuer_change)).toEqual([false])
  await run.click()
  await dialog.getByRole('button', { name: 'Set up', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('authentik-steps').locator('li')).toHaveCount(steps.length)
  expect(sent.map((body) => body.confirm_issuer_change)).toEqual([false, false, true])
  // The token stayed in the field while the question waited: all three runs carry it.
  expect(sent.map((body) => body.token)).toEqual([token, token, token])
  expect(problems).toEqual([])
  await setAddress(page, '')
})

const ADDRESS = {
  public_url: '',
  seen: 'http://nexlore:8000',
  forwarded_proto: '',
  forwarded_host: '',
  proxy_ignored: false,
  callback_path: '/api/oidc/authentik/callback',
  redirect_uri: 'http://nexlore:8000/api/oidc/authentik/callback',
  registered_redirect_uri: '',
  stale: false,
}

test('36: without a public address the card suggests the browser\'s own, "Use it only" saves it, and the button reads "Set up"', async ({ page, baseURL }) => {
  const problems = collectProblems(page)
  await setAddress(page, '')
  await page.goto('/settings?tab=server&sub=signin')
  const card = page.locator('#sign-in-authentik')
  const box = card.getByTestId('authentik-no-address')
  await expect(box).toContainText('No public address yet')
  await expect(card.getByTestId('authentik-proposal')).toHaveText(baseURL!.replace(/\/+$/, ''))
  // The browser and the server see the same address here: no warning about a proxy.
  await expect(card.getByTestId('authentik-proxy-warning')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Use it and set up' })).toBeVisible()
  await shot(page, 'authentik-card-no-address')
  await card.getByRole('button', { name: 'Use it only' }).click()
  await expect(box).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Set up', exact: true })).toBeVisible()
  // Card 1 shows the saved address, and the server holds it.
  await expect(page.locator('#sign-in').getByRole('textbox', { name: 'Public address' })).toHaveValue(baseURL!.replace(/\/+$/, ''))
  const settings = await (await page.request.get('/api/settings')).json()
  expect(settings.public_url).toBe(baseURL!.replace(/\/+$/, ''))
  expect(problems).toEqual([])
  await setAddress(page, '')
})

test('37: the card warns about a proxy that the server did not believe, and about a redirect address authentik still knows', async ({ page }) => {
  const problems = collectProblems(page)
  await setAddress(page, '')
  let answer: Record<string, unknown> = {
    ...ADDRESS,
    seen: 'http://nexlore:8000',
    forwarded_proto: 'https',
    proxy_ignored: true,
  }
  await page.route('**/api/oidc/authentik/address', (route) => route.fulfill({ json: answer }))
  await page.goto('/settings?tab=server&sub=signin')
  const card = page.locator('#sign-in-authentik')
  const warning = card.getByTestId('authentik-proxy-warning')
  await expect(warning).toContainText('The server receives this request as http://nexlore:8000')
  await shot(page, 'authentik-card-proxy-warning')
  // An address is set, but authentik was told another one: the card says which, above the button.
  answer = {
    ...ADDRESS,
    public_url: 'https://notes.example.org',
    redirect_uri: 'https://notes.example.org/api/oidc/authentik/callback',
    registered_redirect_uri: 'https://old.example.org/api/oidc/authentik/callback',
    stale: true,
  }
  await page.reload()
  const stale = page.locator('#sign-in-authentik').getByTestId('authentik-stale')
  await expect(stale).toContainText('authentik still knows the old redirect address https://old.example.org/api/oidc/authentik/callback')
  await expect(page.locator('#sign-in-authentik').getByTestId('authentik-no-address')).toHaveCount(0)
  await shot(page, 'authentik-card-stale')
  expect(problems).toEqual([])
})

test('38: saving the address asks first when a provider knows the old one, and sends the yes with the second try', async ({ page }) => {
  const problems = collectProblems(page)
  await setAddress(page, '')
  const sent: Array<{ public_url?: string; confirm_address?: boolean }> = []
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const body = route.request().postDataJSON() as (typeof sent)[number]
    sent.push(body)
    if (body.confirm_address) return route.continue()
    return route.fulfill({
      status: 409,
      json: {
        detail: {
          code: 'public_url_change',
          message: 'asks',
          count: 1,
          address: 'https://old.example.org/api/oidc/authentik/callback',
          hand: 2,
          entries: [],
        },
      },
    })
  })
  await page.goto('/settings?tab=server&sub=signin')
  const card = page.locator('#sign-in')
  const field = card.getByRole('textbox', { name: 'Public address' })
  await field.fill('https://notes.example.org')
  await card.getByRole('button', { name: 'Save' }).click()
  const dialog = page.getByRole('dialog')
  const question = dialog.getByTestId('address-question')
  await expect(question).toContainText('authentik still knows the redirect address https://old.example.org/api/oidc/authentik/callback')
  await expect(question).toContainText('For 2 providers entered by hand, change the redirect address there yourself.')
  await shot(page, 'address-question')
  // Nothing was saved yet, so the card does not say "Saved" behind the question.
  await expect(card).not.toContainText('Saved')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(sent).toEqual([{ public_url: 'https://notes.example.org' }])
  expect((await (await page.request.get('/api/settings')).json()).public_url).toBe('')
  await card.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(sent.map((body) => body.confirm_address ?? false)).toEqual([false, false, true])
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).public_url).toBe('https://notes.example.org')
  expect(problems).toEqual([])
  await setAddress(page, '')
})

test('39: "Use it only" asks first as well, and a count of 0 leaves out the sentence about authentik', async ({ page }) => {
  const problems = collectProblems(page)
  await setAddress(page, '')
  const sent: Array<{ public_url: string; confirm: boolean }> = []
  await page.route('**/api/oidc/authentik/address', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON() as (typeof sent)[number]
    sent.push(body)
    if (body.confirm) return route.continue()
    return route.fulfill({
      status: 409,
      json: { detail: { code: 'public_url_change', message: 'asks', count: 0, address: '', hand: 1, entries: [] } },
    })
  })
  await page.goto('/settings?tab=server&sub=signin')
  const card = page.locator('#sign-in-authentik')
  await card.getByRole('button', { name: 'Use it only' }).click()
  const question = page.getByRole('dialog').getByTestId('address-question')
  await expect(question).toContainText('For 1 provider entered by hand, change the redirect address there yourself.')
  await expect(question).not.toContainText('authentik still knows')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(card.getByTestId('authentik-no-address')).toHaveCount(0)
  expect(sent.map((body) => body.confirm)).toEqual([false, true])
  expect(problems).toEqual([])
  await setAddress(page, '')
})

test('40: keys of an account that must still set up a second factor carry the hint, and making one stays possible', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  const put = await page.request.put('/api/settings', {
    data: { api_tokens_allowed: true, mcp_allowed: true, mcp_oauth_allowed: true, calendar_feed_allowed: true },
    headers: TAB,
  })
  expect(put.ok(), await put.text()).toBe(true)
  // The server's answer is played: this account is spared the setup in this session (a provider checked its factor)
  // but its keys would be dead.
  await page.route('**/api/auth/me', async (route) => {
    const response = await route.fetch()
    const me = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...me, keys_need_second_factor: true } })
  })
  await page.goto('/account?tab=ai')
  const hint = 'Works only once you set up a second factor.'
  const tokens = page.locator('#api-tokens')
  await expect(tokens).toContainText(hint)
  await expect(tokens.getByRole('link', { name: 'Set it up' })).toHaveAttribute('href', '/account?tab=security')
  await expect(page.locator('#mcp')).toContainText(hint)
  await expect(page.locator('#calendar')).toContainText(hint)
  // Making a token is still possible; the token in the list carries the hint, too.
  await tokens.getByRole('button', { name: 'New token' }).click()
  await tokens.getByLabel('Name, so you know it again').fill('hint-check')
  await tokens.getByRole('button', { name: 'Make', exact: true }).click()
  const row = tokens.getByTestId('api-token').filter({ hasText: 'hint-check' })
  await expect(row).toContainText(hint)
  await shot(page, 'keys-hint')
  await row.getByRole('button', { name: /Delete/ }).click()
  await expect(row).toHaveCount(0)
  // A connector asks for a key of its own on the consent page: the hint stands there, too, and agreeing stays possible.
  const program = await playwright.request.newContext({ baseURL })
  const registered = await program.post('/api/oauth/register', { data: { redirect_uris: ['https://connector.example.com/back'], client_name: 'Hint connector' } })
  expect(registered.status()).toBe(201)
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: (await registered.json()).client_id,
    redirect_uri: 'https://connector.example.com/back',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
  })
  await page.goto(`/oauth/authorize?${query}`)
  await expect(page.getByRole('heading', { name: 'Hint connector wants to use nexlore' })).toBeVisible()
  await expect(page.getByTestId('key-needs-factor')).toContainText(hint)
  await expect(page.getByRole('button', { name: 'Allow' })).toBeEnabled()
  await program.dispose()
  expect(problems).toEqual([])
  // The switches are closed again, as the other specs find them.
  await page.request.put('/api/settings', { data: { api_tokens_allowed: false, mcp_allowed: false, calendar_feed_allowed: false }, headers: TAB })
})
