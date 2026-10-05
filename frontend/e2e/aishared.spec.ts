/**
 * One AI service for all (Frag Lore, design answer 05.10.2026), through the interface and against the stand-in service
 * (`e2e/fake-ai.mjs`): the operator chooses "One for all", puts in the service without listing its address in the own
 * network, and every account is told it needs nothing of its own. The settings are put back as they were found, since
 * the tests share one server and one operator.
 */
import { AI_PROVIDERS } from '../src/lib/aiProviders'
import { expect, test } from './fixtures'

// A service without models for vectors, taken from the list so that no product name stands here.
const NO_VECTORS = AI_PROVIDERS.find((provider) => !provider.embeddings && provider.keys)!

const TAB = { 'X-Nexlore-Client': 'tab-e2e-aish' }
const SERVICE = 'http://127.0.0.1:8478/v1/'

test.skip(!!process.env.E2E_BASE_URL, 'needs the stand-in service')

let before: Record<string, unknown> = {}

test.beforeEach(async ({ page }) => {
  before = await (await page.request.get('/api/settings')).json()
  // Not listed as a service in the own network: the operator's address needs no entry there.
  const opened = await page.request.put('/api/settings', { headers: TAB, data: { ai_allowed: true, ai_private_hosts: '' } })
  expect(opened.ok()).toBe(true)
})

test.afterEach(async ({ page }) => {
  await page.request.put('/api/ai/shared', { headers: TAB, data: { url: '', model: '', key: '' } })
  await page.request.put('/api/settings', {
    headers: TAB,
    data: { ai_allowed: before.ai_allowed, ai_private_hosts: before.ai_private_hosts, ai_mode: 'own', ai_per_minute: 20 },
  })
})

test('the operator brings one service for all, and an account is told it needs nothing of its own', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))

  await page.goto('/settings?tab=server&sub=extensions#ai')
  const card = page.locator('#ai')
  const forAll = card.getByRole('button', { name: /One for all/ })
  await expect(card.getByRole('button', { name: /Each on their own/ })).toHaveAttribute('aria-pressed', 'true')
  await forAll.click()
  await expect(forAll).toHaveAttribute('aria-pressed', 'true')
  // The list of hosts in the own network is about members' own addresses; with one for all it is not asked.
  await expect(card.getByLabel('Services in your own network')).toHaveCount(0)

  const shared = card.getByTestId('ai-shared')
  await expect(shared.getByText(/Save an address and a model/)).toBeVisible()
  // The tiles fill in the address as in an account's own access; a service without models for vectors says so.
  await shared.getByRole('button', { name: NO_VECTORS.name, exact: true }).click()
  await expect(shared.getByLabel(/^Address/)).toHaveValue(NO_VECTORS.url)
  await expect(shared.getByRole('link', { name: `Get a key from ${NO_VECTORS.name}` })).toBeVisible()
  await expect(shared.getByTestId('ai-embed-none')).toBeVisible()
  await shared.getByRole('button', { name: 'Ollama' }).click()
  await expect(shared.getByTestId('ai-embed-none')).toHaveCount(0)
  await shared.getByLabel(/^Address/).fill(SERVICE)
  await shared.getByLabel('Key', { exact: true }).fill('e2e-stand-in-key')
  await shared.getByRole('button', { name: 'Load the models' }).click()
  await expect(shared.getByTestId('ai-shared-models-count')).toHaveText('1 model found: address and key are right.')
  await expect(shared.getByLabel('Model', { exact: true })).toHaveValue('stand-in')
  await shared.getByRole('button', { name: 'Save' }).click()
  await expect(shared.getByText('Saved.')).toBeVisible()
  await expect(shared.getByLabel('Key', { exact: true })).toHaveValue('')
  await expect(shared.getByLabel('Key', { exact: true })).toHaveAttribute('placeholder', 'saved, not shown again')
  await expect(shared.getByText(/Save an address and a model/)).toHaveCount(0)

  // The "Saved." above is still there from the service: wait for this save itself.
  const paced = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PUT')
  await card.getByLabel('Requests per account').selectOption('60')
  expect((await paced).ok()).toBe(true)
  expect((await (await page.request.get('/api/settings')).json()).ai_per_minute).toBe(60)

  await page.goto('/account?tab=ai')
  await expect(page.getByTestId('ai-shared-info')).toHaveText(
    'The operator provides the AI service for everyone: stand-in. You do not need to fill anything in.',
  )
  await expect(page.locator('section#ai').getByLabel(/^Address/)).toHaveCount(0)

  // It goes out with the operator's service (which one exactly is measured in backend/tests/test_ai_shared.py).
  const done = await page.request.post('/api/ai/run', { headers: TAB, data: { task: 'spelling', text: 'This is teh plan for today.' } })
  expect(await done.json()).toEqual({ text: 'This is the plan for today.' })
  const last = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(last.model).toBe('stand-in')
  expect(problems).toEqual([])
})
