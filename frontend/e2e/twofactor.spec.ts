/**
 * The second factor through the interface: set it up on the account page (the codes are worked out here, as an app
 * would), sign in in two steps with a recovery code, a wrong code is refused, the operator cannot require it without
 * one of their own, the operator resets it, and an account that must set one up sees only that. A fresh account,
 * so the operator's own sign-in stays as the other tests expect it.
 */
import { request, type Browser, type Page } from '@playwright/test'
import { signOut } from './account'
import { expect, test } from './fixtures'
import { createHmac } from 'node:crypto'

import { OPERATOR } from './global-setup'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-2fa00' }
const PASSWORD = 'e2e second factor password'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** RFC 6238, as an authenticator app works it out. */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const digest = createHmac('sha1', base32(secret)).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    // A refused code or setting is an answer the page shows, not a fault.
    if (message.type() === 'error' && !/status of 4(01|09)/.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function newAccount(page: Page, name: string, baseURL: string): Promise<void> {
  const invite = await page.request.post('/api/invites', { data: { days: 1 }, headers: TAB })
  expect(invite.ok()).toBe(true)
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  // Accepted from a context of its own: accepting signs in, and the operator's page must stay the operator's.
  const outside = await request.newContext({ baseURL })
  const made = await outside.post(`/api/invite/${token}`, { data: { name, password: PASSWORD }, headers: TAB })
  expect(made.ok()).toBe(true)
  await outside.dispose()
}

async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  return context.newPage()
}

async function signIn(page: Page, name: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username or email').fill(name)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('an account sets up its second factor and signs in with it', async ({ page, browser, baseURL }) => {
  await newAccount(page, 'factor', baseURL!)
  const own = await signedOutPage(browser)
  const problems = collectProblems(own)
  await signIn(own, 'factor')
  await expect(own).toHaveURL(/\/$/)

  await own.goto('/account?tab=security')
  const section = own.getByTestId('second-factor')
  // The state beside the heading, as the shared account module words it ("On"/"Off").
  await expect(own.getByTestId('second-factor-state')).toHaveText('Off')
  await section.getByRole('button', { name: 'Set up an authenticator app' }).click()
  await expect(section.getByRole('img', { name: 'QR code for the authenticator app' })).toBeVisible()
  const secret = (await own.getByTestId('totp-secret').textContent())!.replace(/\s/g, '')
  await section.getByLabel('Code from the app').fill(totp(secret))
  await section.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await section.getByRole('button', { name: 'Turn on' }).click()
  const shown = own.getByTestId('recovery-codes')
  // Ten recovery codes since the shared account module.
  await expect(shown.getByRole('listitem')).toHaveCount(10)
  const codes = await shown.getByRole('listitem').allTextContents()
  await shown.getByRole('button', { name: 'I have them' }).click()
  await expect(own.getByTestId('second-factor-state')).toHaveText('On')
  await expect(own.getByTestId('recovery-part')).toContainText('10 codes left')

  // Signing in now takes two steps; a wrong code is refused, a recovery code goes through once.
  await signOut(own)
  // Signed out once the login page is there; going there before (a slow CI machine did) finds the session alive.
  await expect(own).toHaveURL(/\/login(\?|$)/)
  await signIn(own, 'factor')
  await expect(own.getByRole('heading', { name: 'Second factor' })).toBeVisible()
  await own.getByLabel('Code', { exact: true }).fill('000000')
  await own.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(own.getByRole('alert')).toContainText('The code is wrong.')
  await own.getByLabel('Code', { exact: true }).fill(codes[0])
  await own.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(own).toHaveURL(/\/$/)
  await own.goto('/account?tab=security')
  await expect(own.getByTestId('recovery-part')).toContainText('9 codes left')
  expect(problems).toEqual([])
  await own.context().close()
})

test('the operator requires it only with one of their own, and resets it for an account', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/settings?tab=server&sub=signin')
  const toggle = page.getByRole('checkbox', { name: 'Require a second factor' })
  await toggle.click()
  await expect(page.getByText('Set up your own second factor first, on your account page.')).toBeVisible()
  await expect(toggle).not.toBeChecked()

  // The accounts are an area of their own, further down the settings' navigation: one row per account, "Manage"
  // opens a dialog with every act (the shared account module's list).
  await page.getByTestId('settings-nav').getByRole('link', { name: 'Accounts' }).click()
  const row = page.getByTestId('account-factor')
  await expect(row).toContainText('Second factor')
  const manage = async () => {
    await row.getByTestId('account-manage').click()
    return page.getByTestId('manage-dialog')
  }
  const close = async () => page.getByTestId('manage-dialog').getByRole('button', { name: 'Close' }).click()
  await (await manage()).getByRole('button', { name: 'Reset the second factor' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reset the second factor' }).last()
  // Only with the operator's own password once more: a session alone is not enough, the button waits for it.
  await expect(dialog.getByRole('button', { name: 'Reset the second factor' })).toBeDisabled()
  await dialog.getByLabel('Current password').fill('not the password at all')
  await dialog.getByRole('button', { name: 'Reset the second factor' }).click()
  await expect(dialog.getByText('The password is wrong.')).toBeVisible()
  await dialog.getByLabel('Current password').fill(OPERATOR.password)
  await dialog.getByRole('button', { name: 'Reset the second factor' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row).not.toContainText('Second factor')
  await close()

  // A role, the same way; the field starts empty each time.
  await (await manage()).getByRole('button', { name: 'Make operator' }).click()
  const promote = page.getByRole('dialog', { name: 'Make operator' }).last()
  await expect(promote.getByLabel('Current password')).toHaveValue('')
  await promote.getByLabel('Current password').fill(OPERATOR.password)
  await promote.getByRole('button', { name: 'Make operator' }).click()
  await expect(row).toContainText('Operator')
  await close()
  await (await manage()).getByRole('button', { name: 'Make member' }).click()
  const demote = page.getByRole('dialog', { name: 'Make member' }).last()
  await demote.getByLabel('Current password').fill(OPERATOR.password)
  await demote.getByRole('button', { name: 'Make member' }).click()
  await expect(row).not.toContainText('Operator')
  await close()
  // The wrong password above counted like a failed sign-in, and nothing more.
  expect(problems.filter((problem) => !problem.includes('401'))).toEqual([])
})

test('an account that must set one up sees nothing else until it has', async ({ page, browser, baseURL }) => {
  // The operator sets up a factor of their own (as an app would), requires it, and takes both back at the end.
  const begun = await (await page.request.post('/api/auth/totp/begin', { headers: TAB })).json()
  const confirmed = await page.request.post('/api/auth/totp/confirm', {
    data: { code: totp(begun.secret), password: OPERATOR.password },
    headers: TAB,
  })
  expect(confirmed.ok()).toBe(true)
  try {
    expect((await page.request.put('/api/settings', { data: { two_factor_required: true }, headers: TAB })).ok()).toBe(true)
    await newAccount(page, 'required', baseURL!)
    const own = await signedOutPage(browser)
    const problems = collectProblems(own)
    await signIn(own, 'required')
    await expect(own.getByRole('heading', { name: 'Set up a second factor' })).toBeVisible()
    await expect(own.getByRole('link', { name: 'Graph' })).toHaveCount(0)
    const section = own.getByTestId('second-factor')
    await section.getByRole('button', { name: 'Set up an authenticator app' }).click()
    const secret = (await own.getByTestId('totp-secret').textContent())!.replace(/\s/g, '')
    await section.getByLabel('Code from the app').fill(totp(secret))
    await section.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await section.getByRole('button', { name: 'Turn on' }).click()
    await own.getByTestId('recovery-codes').getByRole('button', { name: 'I have them' }).click()
    await expect(own.getByRole('heading', { name: 'Set up a second factor' })).toHaveCount(0)
    await expect(own.getByRole('link', { name: 'Graph' }).first()).toBeVisible()
    expect(problems).toEqual([])
    await own.context().close()
  } finally {
    expect((await page.request.put('/api/settings', { data: { two_factor_required: false }, headers: TAB })).ok()).toBe(true)
    expect((await page.request.post('/api/auth/totp/disable', { data: { password: OPERATOR.password }, headers: TAB })).ok()).toBe(true)
  }
})

// Last in this file: five wrong codes also count against this address, and a code step after it would have to wait.
test('too many wrong codes lead back to the password', async ({ page, browser, baseURL }) => {
  await newAccount(page, 'guessed', baseURL!)
  const own = await signedOutPage(browser)
  await signIn(own, 'guessed')
  await expect(own).toHaveURL(/\/$/)
  const begun = await (await own.request.post('/api/auth/totp/begin', { headers: TAB })).json()
  const confirmed = await own.request.post('/api/auth/totp/confirm', { data: { code: totp(begun.secret), password: PASSWORD }, headers: TAB })
  expect(confirmed.ok()).toBe(true)
  await own.request.post('/api/auth/logout', { headers: TAB })
  await signIn(own, 'guessed')
  for (let attempt = 0; attempt < 5; attempt++) {
    await own.getByLabel('Code', { exact: true }).fill('000000')
    await own.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(own.getByRole('alert')).toBeVisible()
  }
  await expect(own.getByRole('alert')).toContainText('That took too long. Sign in again.')
  await expect(own.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(own.getByLabel('Code', { exact: true })).toHaveCount(0)
  await own.context().close()
})
