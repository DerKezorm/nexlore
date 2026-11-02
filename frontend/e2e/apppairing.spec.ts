/**
 * Pairing the iPhone app through the interface: the account opens "Connect the iPhone app", a stand-in for the app
 * picks the key up with the short code, the card says it came and the device stands in the list until it is
 * disconnected. The sign-in page for connecting by address hands the app a pairing link after the click.
 */
import { expect, test } from './fixtures'

test('an iPhone pairs with the short code and goes when disconnected', async ({ page, playwright, baseURL }) => {
  const phone = await playwright.request.newContext({ baseURL })
  try {
    await page.goto('/account?tab=security')
    const card = page.locator('#app-devices')
    await card.getByRole('button', { name: 'Connect the iPhone app' }).click()
    await expect(card.getByRole('img', { name: 'QR code to connect the iPhone app' })).toBeVisible()
    await expect(card.getByTestId('app-pairing-address')).toHaveText(new URL(page.url()).origin)
    const code = (await card.getByTestId('app-pairing-code').textContent())!.trim()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)

    // The app: no cookie, no tab; the code typed as people type it.
    const picked = await phone.post('/api/app/1/pairing/code', { data: { code: code.toLowerCase(), device: 'E2E phone' } })
    expect(picked.status()).toBe(200)
    const { key } = (await picked.json()) as { key: string }
    expect(key).toMatch(/^nxd_/)
    const auth = { Authorization: `Bearer ${key}` }
    expect((await phone.get('/api/app/1/me', { headers: auth })).status()).toBe(200)

    await expect(card.getByText('E2E phone is connected.')).toBeVisible()
    await expect(card.getByTestId('app-device').filter({ hasText: 'E2E phone' })).toBeVisible()
    await card.getByRole('button', { name: 'Disconnect E2E phone' }).click()
    await expect(card.getByTestId('app-device').filter({ hasText: 'E2E phone' })).toHaveCount(0)
    expect((await phone.get('/api/app/1/me', { headers: auth })).status()).toBe(401)
  } finally {
    await phone.dispose()
  }
})

test('the sign-in page asks first and then hands the app its link', async ({ page }) => {
  await page.goto('/app-connect?device=Pocket%20phone')
  await expect(page.getByRole('heading', { name: 'Connect iPhone' })).toBeVisible()
  await expect(page.getByText('The device “Pocket phone” wants to connect.')).toBeVisible()
  const made = page.waitForResponse((answer) => answer.url().endsWith('/api/app-pairing') && answer.request().method() === 'POST')
  await page.getByRole('button', { name: 'Connect iPhone' }).click()
  const pairing = (await (await made).json()) as { link: string; id: string }
  expect(pairing.link).toMatch(/^nexlore:\/\/connect\?address=[^&]+&pairing=[^&]+&secret=[^&]+$/)
  await page.goto('/account?tab=security')
  // Nobody picked it up: the pairing waits, and the page withdraws nothing it did not show.
  const state = await page.request.get(`/api/app-pairing/${pairing.id}`)
  expect(((await state.json()) as { state: string }).state).toBe('waiting')
  await page.request.delete(`/api/app-pairing/${pairing.id}`, { headers: { 'X-Nexlore-Client': 'tab-e2e-apppair0' } })
})
