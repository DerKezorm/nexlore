/**
 * Before any test: the operator account, and its session saved for every test (`storageState`). On a fresh data
 * directory the account is made through the setup; against a running instance it signs in with E2E_USER and
 * E2E_PASSWORD. The name and password are made up for the test run and live only in the temporary data directory.
 */
import { request, type FullConfig } from '@playwright/test'

export const OPERATOR = { name: 'tester', password: 'e2e test operator password' }

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL!
  const state = process.env.NEXLORE_E2E_STATE!
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { 'X-Nexlore-Client': 'tab-e2esetup0' } })
  const setup = await (await context.get('/api/setup')).json()
  if (setup.needs_setup) {
    // Empty language: the account follows the browser, as the language tests expect.
    const made = await context.post('/api/setup', { data: { name: OPERATOR.name, password: OPERATOR.password, language: '' } })
    if (!made.ok()) throw new Error(`setup failed: ${made.status()}`)
  } else {
    const name = process.env.E2E_USER ?? OPERATOR.name
    const password = process.env.E2E_PASSWORD ?? OPERATOR.password
    const signed = await context.post('/api/auth/login', { data: { name, password } })
    if (!signed.ok()) throw new Error(`sign-in failed: ${signed.status()} (E2E_USER and E2E_PASSWORD for a running instance)`)
  }
  await context.storageState({ path: state })
  await context.dispose()
}
