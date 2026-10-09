/**
 * The mail address of an account (issue #13), in the app as it runs: the mail server as a part of its own, an address
 * entered in the profile and confirmed by the link in a real mail, a locked field without a server, an address the
 * operator gives, and the sign-in provider: an account only through it follows it, a linked one keeps its own and is
 * offered the provider's, and an address never catches somebody else's first sign-in (no account is ever found by
 * its address).
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
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
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

async function enter(page: Page, address: string): Promise<void> {
  await page.goto('/account')
  const part = page.getByTestId('mail-address')
  await part.getByLabel('Mail address').fill(address)
  await part.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByTestId('mail-waiting')).toContainText(address)
}

async function confirmFrom(browser: Browser, address: string): Promise<string> {
  const mail = await mailTo(address)
  const link = mail.body.match(/http:\/\/\S+\/confirm-email\/nxe_[A-Za-z0-9_-]+/)?.[0]
  expect(link, mail.body).toBeTruthy()
  const { context, page } = await signedOut(browser)
  await page.goto(link!)
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
  await page.getByRole('tab', { name: 'Mail server' }).click()
  await expect(page).toHaveURL(/sub=mail/)
  const card = page.locator('#mail')
  await expect(card.getByRole('heading', { name: 'Mail server' })).toBeVisible()
  await expect(card.getByTestId('mail-uses')).toContainText('The links with which someone confirms their mail address')
  await expect(card.getByTestId('mail-public-url')).toBeVisible()
  await card.getByLabel('Server').fill('127.0.0.1')
  await card.getByLabel('Port').fill('2525')
  await card.getByLabel('Encryption').selectOption('none')
  await card.getByLabel('Sender address').fill('notes@example.com')
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
  // Waiting, it counts for nothing yet.
  await expect(own.getByTestId('mail-status')).toHaveCount(0)
  const mail = await mailTo('postie@example.com')
  expect(mail.subject).toBe('Confirm your mail address for nexlore')
  const link = await confirmFrom(browser, 'postie@example.com')
  // A second time it does nothing.
  const { context, page: again } = await signedOut(browser)
  await again.goto(link)
  await expect(again.getByRole('heading', { name: 'Not confirmed' })).toBeVisible()
  await expect(again.getByText('This link does not work any more.')).toBeVisible()
  await context.close()
  await own.reload()
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: postie@example.com')
  await expect(own.getByTestId('mail-status')).toContainText('entered by you')
  await expect(own.getByTestId('mail-waiting')).toHaveCount(0)
  // Notifications by mail are open now, to this address.
  await own.goto('/account?tab=notify')
  await expect(own.getByText('To postie@example.com.')).toBeVisible()
  // Cancelling a new one leaves the confirmed one; a phone shows it all without sideways scrolling.
  await own.setViewportSize({ width: 390, height: 844 })
  await enter(own, 'postie.new@example.com')
  expect(await own.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await own.getByTestId('mail-waiting').getByRole('button', { name: 'Cancel' }).click()
  await expect(own.getByTestId('mail-waiting')).toHaveCount(0)
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: postie@example.com')
  expect(problems).toEqual([])
})

test('without a mail server the field is locked and says why; the operator is shown where to set one up', async ({ page, browser, baseURL }) => {
  await mailServer(page, false, baseURL!)
  await newAccount(page, 'nopost', baseURL!)
  const own = await signIn(browser, 'nopost')
  await own.goto('/account')
  const part = own.getByTestId('mail-address')
  await expect(part.getByLabel('Mail address')).toBeDisabled()
  await expect(part).toContainText('The operator has not set up a mail server')
  await expect(part.getByRole('link', { name: 'Set up a mail server' })).toHaveCount(0)
  await own.goto('/account?tab=notify')
  await expect(own.getByText('The operator has not set up a mail server.')).toBeVisible()
  await expect(own.getByTestId('notify-mail-fix')).toHaveCount(0)
  // The operator sees the way to the server, in the profile and beside the notifications.
  await page.goto('/account')
  await page.getByTestId('mail-address').getByRole('link', { name: 'Set up a mail server' }).click()
  await expect(page).toHaveURL(/tab=server&sub=mail/)
  await page.goto('/account?tab=notify')
  await expect(page.getByTestId('notify-mail-fix')).toHaveText('Set up a mail server')
  // A server without the public address cannot send the link either, and says that instead.
  await mailServer(page, true, baseURL!)
  expect((await page.request.put('/api/settings', { data: { public_url: '' }, headers: TAB })).ok()).toBe(true)
  await own.goto('/account')
  await expect(own.getByTestId('mail-address')).toContainText("The operator has not entered nexlore's public address")
})

test('the operator gives an account an address; it counts at once and the account is told', async ({ page, browser, baseURL }) => {
  await mailServer(page, false, baseURL!)
  await newAccount(page, 'given', baseURL!)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings?tab=server&sub=accounts')
  const row = page.locator('#accounts li').filter({ hasText: 'given' }).first()
  await expect(row.getByTestId('account-mail')).toContainText('No mail address')
  await row.getByRole('button', { name: 'Mail address' }).click()
  const form = row.getByTestId('account-mail-form')
  await form.getByLabel('Mail address for given').fill('given@example.com')
  await form.getByLabel('Your own password').fill(OPERATOR.password)
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(row.getByTestId('account-mail')).toContainText('given@example.com')
  await expect(row.getByTestId('account-mail')).toContainText('entered by the operator')
  // No mail went out: none was needed (and no server is there).
  expect(await mails()).toEqual([])
  const own = await signIn(browser, 'given')
  await own.setViewportSize({ width: 1440, height: 900 })
  await own.getByRole('button', { name: /^New since your last visit/ }).click()
  const notice = own.locator('[data-notice="operator_email"]')
  await expect(notice).toContainText('set your mail address to given@example.com')
  await notice.getByRole('link', { name: 'To the profile' }).click()
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: given@example.com')
  await expect(own.getByTestId('mail-status')).toContainText('entered by the operator')
})

test('an account only through the provider follows its address and cannot change it here', async ({ page, browser, baseURL }) => {
  await mailServer(page, true, baseURL!)
  await provider(page)
  const clara = await viaProvider(browser, { sub: 'clara-1', email: 'clara@example.com', preferred_username: 'clara' })
  const problems = collectProblems(clara)
  await clara.goto('/account')
  const field = clara.getByTestId('mail-address').getByLabel('Mail address')
  await expect(field).toHaveValue('clara@example.com')
  await expect(field).toHaveAttribute('readonly', '')
  await expect(clara.getByTestId('mail-address')).toContainText('Comes from Stand-in SSO and follows it at every sign-in.')
  // The provider changed it; the next sign-in brings it along.
  const later = await viaProvider(browser, { sub: 'clara-1', email: 'clara.new@example.com', preferred_username: 'clara' })
  await later.goto('/account')
  await expect(later.getByTestId('mail-address').getByLabel('Mail address')).toHaveValue('clara.new@example.com')
  // The operator has no button for it either.
  await page.goto('/settings?tab=server&sub=accounts')
  const row = page.locator('#accounts li').filter({ hasText: 'clara.new@example.com' })
  await expect(row.getByTestId('account-mail')).toContainText('clara.new@example.com')
  await expect(row.getByRole('button', { name: 'Mail address' })).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a linked account keeps its own address and is offered the provider\'s; unlinking keeps the own one', async ({ page, browser, baseURL }) => {
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
  await expect(own).toHaveURL(/\/account\?linked=standin/)
  await own.goto('/account')
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: linda@example.com')
  const offer = own.getByTestId('mail-offer')
  await expect(offer).toContainText('Stand-in SSO knows you as linda.sso@example.com')
  await offer.getByRole('button', { name: "Don't ask again" }).click()
  await expect(offer).toHaveCount(0)
  await own.reload()
  // Not asked again, and nothing taken either: the own address still counts (checked first: it waits for the page).
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: linda@example.com')
  await expect(own.getByTestId('mail-status')).toContainText('entered by you')
  await expect(own.getByTestId('mail-offer')).toHaveCount(0)
  // A newer address at the provider is offered again, and taken on request.
  await (await viaProvider(browser, { sub: 'linda-1', email: 'linda.work@example.com', preferred_username: 'linda' })).context().close()
  await own.reload()
  await own.getByTestId('mail-offer').getByRole('button', { name: 'Take it' }).click()
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: linda.work@example.com')
  await expect(own.getByTestId('mail-status')).toContainText('from Stand-in SSO')
  // Unlinked, an address from the provider goes along with the link.
  expect((await own.request.delete(`/api/oidc/${SLUG}/link`, { headers: TAB })).ok()).toBe(true)
  await own.reload()
  await expect(own.getByTestId('mail-address').getByLabel('Mail address')).toHaveValue('')
  await expect(own.getByTestId('mail-status')).toHaveCount(0)
  // An own one stays: entered and confirmed again, linked and unlinked, it is still there.
  await enter(own, 'linda@example.com')
  await confirmFrom(browser, 'linda@example.com')
  const again = await own.request.post(`/api/oidc/${SLUG}/link`, { data: { password: PASSWORD }, headers: TAB })
  await own.goto((await again.json()).url)
  await expect(own).toHaveURL(/\/account\?linked=standin/)
  expect((await own.request.delete(`/api/oidc/${SLUG}/link`, { headers: TAB })).ok()).toBe(true)
  await own.goto('/account')
  await expect(own.getByTestId('mail-status')).toContainText('Confirmed: linda@example.com')
  expect(problems).toEqual([])
})

test('an address nobody confirmed never catches somebody else\'s first sign-in through the provider', async ({ page, browser, baseURL }) => {
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
