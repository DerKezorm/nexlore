/**
 * Notifications in the account (block Z2): a webhook is saved and shown only by its host, the test reaches it with
 * nexlore's small JSON, an occasion is switched and kept. The webhook is the stand-in service (e2e/fake-ai.mjs).
 */
import { expect, test } from './fixtures'

const TAB = { 'X-Nexlore-Client': 'tab-e2e-notify00' }
const HOOK = 'http://127.0.0.1:8478/hook'

test.skip(!!process.env.E2E_BASE_URL, 'changes the account')

test('a webhook gets the test, and occasions are kept', async ({ page, request }) => {
  try {
    await page.goto('/account?tab=notify')
    await page.getByLabel('Webhook address').fill(HOOK)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('notify-webhook')).toHaveText(/Webhook to 127\.0\.0\.1/)
    await expect(page.getByText(HOOK)).toHaveCount(0)
    await page.getByRole('button', { name: 'Send a test' }).click()
    await expect(page.getByText('Webhook: sent')).toBeVisible()
    const got = await (await request.get('http://127.0.0.1:8478/hook/last')).json()
    expect(got).toMatchObject({ app: 'nexlore', event: 'test', title: 'nexlore test' })
    // Mail cannot be chosen without the operator's mail server.
    await expect(page.getByRole('checkbox', { name: 'By mail' })).toBeDisabled()
    const saved = page.waitForResponse((answer) => answer.url().endsWith('/api/me/notify') && answer.request().method() === 'PUT')
    await page.getByRole('checkbox', { name: 'Tasks of the day' }).check()
    expect((await saved).status()).toBe(200)
    await expect(page.getByLabel('Time for the tasks of the day')).toHaveValue('07:00')
    await page.reload()
    await expect(page.getByRole('checkbox', { name: 'Tasks of the day' })).toBeChecked()
  } finally {
    await page.request.put('/api/me/notify', { data: { webhook: '', choices: { tasks: false } }, headers: TAB })
  }
})
