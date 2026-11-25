/**
 * The mail address of an account (issue #13, since the shared account module "Email" in the profile), in the app as it
 * runs: the mail server as a part of its own, an address entered in the profile (with the own password) and confirmed
 * by the link in a real mail, an address that counts at once without a server, the operator who can only take an
 * address away, and the sign-in provider: an account only through it follows it, a linked one keeps its own and is
 * offered the provider's, and an address never catches somebody else's first sign-in (no account is ever found by
 * its address at a provider).
 * The mail server and the provider are the stand-ins of e2e/fake-postbox.mjs; nothing leaves the machine.
 */
import { request, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

import { OPERATOR } from './global-setup'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-mail0' }
const PASSWORD = 'e2e mail address password'
const POSTBOX = 'http://127.0.0.1:8476'
const ISSUER = `${POSTBOX}/oidc`
/** The stand-in's entry in the provider list. */
const SLUG = 'standin'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault and the stand-ins')

type Mail = { to: string; subject: string; body: string }

let before: Record<string, unknown> = {}

test.beforeAll(async ({ request: api }) => {
  before = await (await api.get('/api/settings')).json()
})

test.beforeEach(async () => {
  await fetch(`${POSTBOX}/mails`, { method: 'DELETE' })
})

test.afterAll(async ({ request: api }) => {
  // The server is shared: mail, public address and provider go back to how the other tests know them.
  const keys = ['smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_from', 'public_url'] as const
  const back = Object.fromEntries(keys.map((key) => [key, before[key]]))
  expect((await api.put('/api/settings', { data: back, headers: TAB })).ok()).toBe(true)
  for (const entry of (await (await api.get('/api/oidc/admin/providers')).json()) as { id: number; slug: string }[]) {
    if (entry.slug === SLUG) await api.delete(`/api/oidc/admin/providers/${entry.id}`, { headers: TAB })
  }
})

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    // A refused link or a locked act is an answer the page shows, not a fault.
    if (message.type() === 'error' && !/status of 4(04|09)/.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function mails(): Promise<Mail[]> {
  return (await fetch(`${POSTBOX}/mails`)).json()
}

async function mailTo(address: string): Promise<Mail> {
  await expect.poll(async () => (await mails()).filter((mail) => mail.to === address).length).toBeGreaterThan(0)
  return (await mails()).filter((mail) => mail.to === address).pop()!
}

async function mailServer(page: Page, on: boolean, baseURL: string): Promise<void> {
  const data = on
    ? { smtp_host: '127.0.0.1', smtp_port: 2525, smtp_security: 'none', smtp_user: '', smtp_from: 'notes@example.com', public_url: baseURL }
    : { smtp_host: '', public_url: '' }
  expect((await page.request.put('/api/settings', { data, headers: TAB })).ok()).toBe(true)
}

async function newAccount(page: Page, name: string, baseURL: string): Promise<void> {
  const invite = await page.request.post('/api/invites', { data: { days: 1 }, headers: TAB })
  expect(invite.ok()).toBe(true)
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const outside = await request.newContext({ baseURL })
  // The form of 1.16.0 (no display name): the username stands in for it (the shared account module, `older_request`).
  expect((await outside.post(`/api/invite/${token}`, { data: { name, password: PASSWORD }, headers: TAB })).ok()).toBe(true)
  await outside.dispose()
}

async function signedOut(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  return { context, page: await context.newPage() }
}

async function signIn(browser: Browser, name: string): Promise<Page> {
  const { page } = await signedOut(browser)
  await page.goto('/login')
  await page.getByLabel('Username or email').fill(name)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  return page
}

async function provider(page: Page): Promise<void> {
  const listed = (await (await page.request.get('/api/oidc/admin/providers')).json()) as { slug: string }[]
  if (listed.some((entry) => entry.slug === SLUG)) return
  const answer = await page.request.post('/api/oidc/admin/providers', {
    data: { label: 'Stand-in SSO', slug: SLUG, issuer: ISSUER, client_id: 'e2e-client', client_secret: `e2e-${Date.now()}`, auto_create: true },
    headers: TAB,
  })
  expect(answer.ok(), await answer.text()).toBe(true)
}

async function next(claims: Record<string, unknown>): Promise<void> {
  await fetch(`${ISSUER}/next`, { method: 'POST', body: JSON.stringify(claims) })
}

/** Through the provider's button on the sign-in page, in a browser of its own. */
async function viaProvider(browser: Browser, claims: Record<string, unknown>): Promise<Page> {
  await next(claims)
  const { page } = await signedOut(browser)
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign in with Stand-in SSO' }).click()
  await expect(page).toHaveURL(/\/$/)
  return page
}

/** The address field of the profile (the shared account module's "Email"). */
function emailField(page: Page) {
  return page.getByTestId('profile-card').getByLabel('Email', { exact: true })
}

/** A new address in the profile: "Save", then the own password; with a mail server it waits for its link. */
async function enter(page: Page, address: string, { waits = true } = {}): Promise<void> {
  await page.goto('/settings/profile')
  await emailField(page).fill(address)
  await page.getByTestId('profile-save').click()
  const confirm = page.getByRole('dialog', { name: 'Confirm with your password.' })
  await confirm.getByLabel('Current password').fill(PASSWORD)
  await confirm.getByRole('button', { name: 'Save' }).click()
  if (waits) await expect(page.getByTestId('email-pending')).toContainText(address)
}

async function confirmFrom(browser: Browser, address: string): Promise<string> {
  const mail = await mailTo(address)
  const link = mail.body.match(/http:\/\/\S+\/(?:email|confirm-email)\/[A-Za-z0-9_-]+/)?.[0]
  expect(link, mail.body).toBeTruthy()
  const { context, page } = await signedOut(browser)
  await page.goto(link!)
  await expect(page.getByRole('heading', { name: 'Confirm the new address' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('heading', { name: 'Address confirmed' })).toBeVisible()
  await context.close()
  return link!
}

test('the mail server is a part of its own and says what it is for', async ({ page, baseURL }) => {
  const problems = collectProblems(page)
  await mailServer(page, false, baseURL!)
  await page.setViewportSize({ width: 1440, height: 900 })
  // The cards of a part draw once the settings are there; "not there" only means something after that.
  const loaded = page.waitForResponse((answer) => answer.url().endsWith('/api/settings') && answer.request().method() === 'GET')
  await page.goto('/settings?tab=server&sub=accounts')
  await loaded
  await expect(page.locator('#accounts')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.locator('#mail')).toHaveCount(0)
  await page.getByTestId('settings-nav').getByRole('link', { name: 'Mail' }).click()
  await expect(page).toHaveURL(/\/settings\/mail$/)
  const card = page.locator('#mail')
  await expect(card.getByRole('heading', { name: 'Mail server' })).toBeVisible()
  await expect(card.getByTestId('mail-uses')).toContainText('The links with which someone confirms their mail address')
  await expect(card.getByTestId('mail-public-url')).toBeVisible()
  await card.getByLabel('Server').fill('127.0.0.1')
  await card.getByLabel('Port').fill('2525')
  await card.getByLabel('Encryption').selectOption('none')
  await card.getByLabel('Sender address').fill('notes@example.com')
  // Without encryption the card warns (the shared post module), and the name the mail goes out under is a field.
  await expect(card.getByTestId('mail-unencrypted')).toBeVisible()
  await expect(card.getByLabel('Sender name')).toHaveValue('')
  const saved = page.waitForResponse((answer) => answer.url().endsWith('/api/settings') && answer.request().method() === 'PUT')
  await card.getByRole('button', { name: 'Save' }).click()
  expect((await saved).ok()).toBe(true)
  await card.getByLabel('Send a test mail to').fill('postmaster@example.com')
  await card.getByRole('button', { name: 'Send test' }).click()
  await expect(card).toContainText('Test mail sent.')
  expect((await mailTo('postmaster@example.com')).to).toBe('postmaster@example.com')
  // With the public address set, the hint about it goes.
  expect((await page.request.put('/api/settings', { data: { public_url: baseURL }, headers: TAB })).ok()).toBe(true)
  await page.reload()
  await expect(page.locator('#mail').getByRole('heading', { name: 'Mail server' })).toBeVisible()
  await expect(page.locator('#mail').getByTestId('mail-public-url')).toHaveCount(0)
  expect(problems).toEqual([])
})

test('an address entered counts once the link in its mail is opened, and the link works once', async ({ page, browser, baseURL }) => {
  await mailServer(page, true, baseURL!)
  await newAccount(page, 'postie', baseURL!)
  const own = await signIn(browser, 'postie')
  const problems = collectProblems(own)
  await enter(own, 'postie@example.com')
  // Waiting, it counts for nothing yet: the field still has the address before (none).
  await own.reload()
  await expect(emailField(own)).toHaveValue('')
  const mail = await mailTo('postie@example.com')
  expect(mail.subject).toContain('nexlore')
  const link = await confirmFrom(browser, 'postie@example.com')
  // A second time it does nothing.
  const { context, page: again } = await signedOut(browser)
  await again.goto(link)
  await expect(again.getByRole('heading', { name: 'Not confirmed' })).toBeVisible()
  await expect(again.getByText('This link has been used already or is not valid any more.')).toBeVisible()
  await context.close()
  await own.reload()
  await expect(emailField(own)).toHaveValue('postie@example.com')
  await expect(own.getByTestId('email-pending')).toHaveCount(0)
  // Notifications by mail are open now, to this address.
  await own.goto('/account?tab=notify')
  await expect(own.getByText('To postie@example.com.')).toBeVisible()
  // Withdrawing a new one leaves the confirmed one; a phone shows it all without sideways scrolling.
  await own.setViewportSize({ width: 390, height: 844 })
  await enter(own, 'postie.new@example.com')
  expect(await own.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await own.getByTestId('email-pending').getByRole('button', { name: 'Withdraw' }).click()
  await expect(own.getByTestId('email-pending')).toHaveCount(0)
  await own.reload()
  await expect(emailField(own)).toHaveValue('postie@example.com')
  expect(problems).toEqual([])
})

test('without a mail server an address counts at once; the notifications say there is no server', async ({ page, browser, baseURL }) => {
  await mailServer(page, false, baseURL!)
  await newAccount(page, 'nopost', baseURL!)
  const own = await signIn(browser, 'nopost')
  await enter(own, 'nopost@example.com', { waits: false })
  await expect(own.getByTestId('email-pending')).toHaveCount(0)
  await own.reload()
  await expect(emailField(own)).toHaveValue('nopost@example.com')
  // No mail went out: there is no server.
  expect(await mails()).toEqual([])
  await own.goto('/account?tab=notify')
  await expect(own.getByText('The operator has not set up a mail server.')).toBeVisible()
  await expect(own.getByTestId('notify-mail-fix')).toHaveCount(0)
  // The operator sees the way to the server beside the notifications.
  await page.goto('/account?tab=notify')
  await expect(page.getByTestId('notify-mail-fix')).toHaveText('Set up a mail server')
})

test('the operator never sets an address, only takes one away, with the own password', async ({ page, browser, baseURL }) => {
  await mailServer(page, false, baseURL!)
  await newAccount(page, 'given', baseURL!)
  const own = await signIn(browser, 'given')
  await enter(own, 'given@example.com', { waits: false })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings/accounts')
  const row = page.getByTestId('account-given')
  await expect(row).toContainText('given@example.com')
  await row.getByTestId('account-manage').click()
  const manage = page.getByTestId('manage-dialog')
  // No field to set one: the button only takes it away.
  await expect(manage.getByRole('textbox')).toHaveCount(0)
  await manage.getByRole('button', { name: 'Remove address' }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove address' })
  await confirm.getByLabel('Current password').fill(OPERATOR.password)
  await confirm.getByRole('button', { name: 'Remove address' }).click()
  await expect(page.getByTestId('account-given')).not.toContainText('given@example.com')
  // A script of 1.16.0 that sets an address is refused.
  const id = (await (await own.request.get('/api/auth/me')).json()).id
  const refused = await page.request.put(`/api/accounts/${id}/email`, { data: { address: 'other@example.com', current_password: OPERATOR.password }, headers: TAB })
  expect(refused.ok()).toBe(false)
  await own.reload()
  await expect(emailField(own)).toHaveValue('')
})

test('an account only through the provider follows its address', async ({ page, browser, baseURL }) => {
  await mailServer(page, true, baseURL!)
  await provider(page)
  const clara = await viaProvider(browser, { sub: 'clara-1', email: 'clara@example.com', preferred_username: 'clara' })
  const problems = collectProblems(clara)
  await clara.goto('/settings/profile')
  await expect(emailField(clara)).toHaveValue('clara@example.com')
  // The provider changed it; the next sign-in brings it along.
  const later = await viaProvider(browser, { sub: 'clara-1', email: 'clara.new@example.com', preferred_username: 'clara' })
  await later.goto('/settings/profile')
  await expect(emailField(later)).toHaveValue('clara.new@example.com')
  await page.goto('/settings/accounts')
  await expect(page.getByTestId('account-clara')).toContainText('clara.new@example.com')
  expect(problems).toEqual([])
})

test("a linked account keeps its own address and is offered the provider's, taken with the password", async ({ page, browser, baseURL }) => {
  await mailServer(page, true, baseURL!)
  await provider(page)
  await newAccount(page, 'linda', baseURL!)
  const own = await signIn(browser, 'linda')
  const problems = collectProblems(own)
  await enter(own, 'linda@example.com')
  await confirmFrom(browser, 'linda@example.com')
  // Linking runs through the provider in this very browser.
  await next({ sub: 'linda-1', email: 'linda.sso@example.com', preferred_username: 'linda' })
  const started = await own.request.post(`/api/oidc/${SLUG}/link`, { data: { password: PASSWORD }, headers: TAB })
  expect(started.ok()).toBe(true)
  await own.goto((await started.json()).url)
  await expect(own).toHaveURL(/\/settings\/security\?linked=standin/)
  await own.goto('/settings/profile')
  await expect(emailField(own)).toHaveValue('linda@example.com')
  const offer = own.getByTestId('mail-offer')
  await expect(offer).toContainText('Use the address from Stand-in SSO?')
  await expect(offer).toContainText('linda.sso@example.com')
  await offer.getByRole('button', { name: 'No, thanks' }).click()
  await expect(offer).toHaveCount(0)
  await own.reload()
  // Not asked again, and nothing taken either: the own address still counts.
  await expect(emailField(own)).toHaveValue('linda@example.com')
  await expect(own.getByTestId('mail-offer')).toHaveCount(0)
  // A newer address at the provider is offered again, and taken on request with the password (its link first).
  await (await viaProvider(browser, { sub: 'linda-1', email: 'linda.work@example.com', preferred_username: 'linda' })).context().close()
  await own.reload()
  await own.getByTestId('mail-offer').getByRole('button', { name: 'Use it' }).click()
  const confirm = own.getByRole('dialog', { name: 'Confirm with your password.' })
  await confirm.getByLabel('Current password').fill(PASSWORD)
  await confirm.getByRole('button', { name: 'Use it' }).click()
  await confirmFrom(browser, 'linda.work@example.com')
  await own.reload()
  await expect(emailField(own)).toHaveValue('linda.work@example.com')
  expect(problems).toEqual([])
})

test("an address nobody confirmed never catches somebody else's first sign-in through the provider", async ({ page, browser, baseURL }) => {
  await mailServer(page, true, baseURL!)
  await provider(page)
  await newAccount(page, 'mallory', baseURL!)
  const mallory = await signIn(browser, 'mallory')
  await enter(mallory, 'victim@example.com')
  const victim = await viaProvider(browser, { sub: 'victim-1', email: 'victim@example.com', preferred_username: 'victim' })
  const me = await (await victim.request.get('/api/auth/me')).json()
  expect(me.name).not.toBe('mallory')
  expect(me.sign_in).toBe('oidc')
})
