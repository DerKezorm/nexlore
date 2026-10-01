/**
 * What every end-to-end test stands on; the specs take `test` and `expect` from here, not from Playwright itself.
 *
 * The tests share one account (`tester`, the operator: the spaces of the invented vault belong to it, and inviting
 * into them would hand them to a second account). What one file leaves set on it, the next would find: the column
 * on its versions tab, the week starting on Sunday, a favorite. So before the first test of each file the account
 * goes back to how the setup made it: its look, its display name and its favorites.
 *
 * `E2E_SLOW=3 npx playwright test e2e/<file>` slows every page's processor down, to bring out a race in a test on
 * purpose. Not a model of the CI: measured on 01.10.2026, the CI runs the tests as fast as this machine, and a whole
 * run slowed down mostly showed waits of five seconds running out, nothing the app did wrong.
 */
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'

export { expect }

const TAB = { 'X-Nexlore-Client': 'tab-e2e-fixture0' }
const slowness = Number(process.env.E2E_SLOW ?? 0)
const started = new Set<string>()

/** Back to the look the account had right after the setup (saved there), without favorites. */
async function freshAccount(request: APIRequestContext): Promise<void> {
  const saved = process.env.NEXLORE_E2E_LOOK
  if (!saved || !fs.existsSync(saved)) throw new Error('the look of the fresh account is missing (global-setup.ts)')
  const look = JSON.parse(fs.readFileSync(saved, 'utf-8'))
  const put = await request.put('/api/me/appearance', { data: look, headers: TAB })
  if (!put.ok()) throw new Error(`resetting the look failed: ${put.status()}`)
  const profile = await request.put('/api/me/profile', { data: { display_name: '' }, headers: TAB })
  if (!profile.ok()) throw new Error(`resetting the display name failed: ${profile.status()}`)
  const favorites = await request.get('/api/favorites')
  if (!favorites.ok()) throw new Error(`reading the favorites failed: ${favorites.status()}`)
  for (const favorite of (await favorites.json()) as { path: string }[]) {
    const off = await request.put('/api/favorites', { data: { path: favorite.path, on: false }, headers: TAB })
    if (!off.ok()) throw new Error(`removing a favorite failed: ${off.status()}`)
  }
}

async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowness })
}

export const test = base.extend<{ freshFile: void; slowPages: void }>({
  freshFile: [
    async ({ page }, use, testInfo) => {
      // Against a running instance the account is somebody's own: nothing is reset there.
      if (!process.env.E2E_BASE_URL && !started.has(testInfo.file)) {
        started.add(testInfo.file)
        await freshAccount(page.request)
      }
      await use()
    },
    { auto: true },
  ],
  slowPages: [
    async ({ page }, use) => {
      if (slowness > 1) {
        await throttle(page)
        // Pages the test opens in the same window (a second tab) are as slow.
        page.context().on('page', (other) => void throttle(other).catch(() => {}))
      }
      await use()
    },
    { auto: true },
  ],
})
