/**
 * Pairing the iPhone app through the interface (the shared module geraete since 1.17.0): the account opens "Connect
 * iPhone or iPad" on the card Devices, a stand-in for the published app picks the key up with the typed code, the
 * window says it came and the device stands in the list until it is disconnected. The sign-in page for connecting by
 * address hands the published app a pairing link after the click.
 */
import { expect, test } from './fixtures'

test('an iPhone pairs with the typed code and goes when disconnected', async ({ page, playwright, baseURL }) => {
  const phone = await playwright.request.newContext({ baseURL })
  try {
    await page.goto('/settings/connections')
    const card = page.locator('#devices')
    await card.getByTestId('devices-connect').click()
    const dialog = page.getByTestId('pair-dialog')
    await expect(dialog.getByTestId('pair-qr')).toBeVisible()
    const shown = (await dialog.getByTestId('pair-code-box').textContent()) ?? ''
    const code = shown.match(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/)?.[0] ?? ''
    expect(code).not.toBe('')

    // The published app: no cookie, no tab; the code typed as people type it.
    const picked = await phone.post('/api/app/1/pairing/code', { data: { code: code.toLowerCase(), device: 'E2E phone' } })
    expect(picked.status()).toBe(200)
    const { key } = (await picked.json()) as { key: string }
    expect(key).toMatch(/^nxd_/)
    const auth = { Authorization: `Bearer ${key}` }
    expect((await phone.get('/api/app/1/me', { headers: auth })).status()).toBe(200)

    // The name stands in the window's title since geraete 0.1.x, the line below says where the device is now.
    await expect(dialog.getByTestId('pair-paired')).toContainText('It is in your list of devices now.')
    await expect(dialog).toContainText('E2E phone is connected')
    await dialog.getByTestId('pair-done').click()
    const row = card.getByTestId('device-row').filter({ hasText: 'E2E phone' })
    await expect(row).toBeVisible()
    await row.getByTestId('device-disconnect').click()
    await page.getByTestId('device-disconnect-dialog').getByRole('button', { name: 'Disconnect' }).click()
    await expect(row).toHaveCount(0)
    expect((await phone.get('/api/app/1/me', { headers: auth })).status()).toBe(401)
  } finally {
    await phone.dispose()
  }
})

test('the sign-in page asks first and then hands the published app its link', async ({ page }) => {
  await page.goto('/app-connect?device=Pocket%20phone')
  await expect(page.getByText('Connect “Pocket phone” to your account?')).toBeVisible()
  const made = page.waitForResponse((answer) => answer.url().endsWith('/api/devices/app-connect') && answer.request().method() === 'POST')
  await page.getByTestId('app-connect-confirm').click()
  const { redirect } = (await (await made).json()) as { redirect: string }
  // The link of the QR code, which the published app reads by name (``address``, ``pairing``, ``secret``).
  expect(redirect).toMatch(/^nexlore:\/\/connect\?server=[^&]+&address=[^&]+&pairing=[^&]+&secret=[^&]+$/)
})
