/**
 * Before any test: the operator account, and its session saved for every test (`storageState`). On a fresh data
 * directory the account is made through the setup; against a running instance it signs in with E2E_USER and
 * E2E_PASSWORD. The name and password are made up for the test run and live only in the temporary data directory.
 */
import { request, type FullConfig } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const OPERATOR = { name: 'tester', password: 'e2e test operator password' }
/** The setup code the test server is started with (playwright.config.ts); a real one is in the server's log. */
export const SETUP_CODE = 'e2e-setup-code'

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL!
  const state = process.env.NEXLORE_E2E_STATE!
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { 'X-Nexlore-Client': 'tab-e2esetup0' } })
  const setup = await (await context.get('/api/setup')).json()
  if (setup.needs_setup) {
    // Empty language: the account follows the browser, as the language tests expect.
    const made = await context.post('/api/setup', { data: { name: OPERATOR.name, password: OPERATOR.password, language: '', code: process.env.E2E_SETUP_CODE ?? SETUP_CODE } })
    if (!made.ok()) throw new Error(`setup failed: ${made.status()}`)
  } else {
    const name = process.env.E2E_USER ?? OPERATOR.name
    const password = process.env.E2E_PASSWORD ?? OPERATOR.password
    const signed = await context.post('/api/auth/login', { data: { name, password } })
    if (!signed.ok()) throw new Error(`sign-in failed: ${signed.status()} (E2E_USER and E2E_PASSWORD for a running instance)`)
  }
  await context.storageState({ path: state })
  // The look the account has now: every test file starts from it again (fixtures.ts).
  const me = await context.get('/api/auth/me')
  if (!me.ok()) throw new Error(`reading the account failed: ${me.status()}`)
  fs.writeFileSync(process.env.NEXLORE_E2E_LOOK!, JSON.stringify((await me.json()).appearance))
  await context.dispose()
  // A spec that takes `test` from Playwright itself would skip the fresh start and the slow run.
  const folder = path.dirname(fileURLToPath(import.meta.url))
  const bypass = fs.readdirSync(folder).filter((name) => name.endsWith('.spec.ts') && /import \{[^}]*\b(test|expect)\b[^}]*\} from '@playwright\/test'/.test(fs.readFileSync(path.join(folder, name), 'utf-8')))
  if (bypass.length) throw new Error(`take test and expect from ./fixtures: ${bypass.join(', ')}`)
}
