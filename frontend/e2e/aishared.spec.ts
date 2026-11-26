/**
 * One AI service for all (Frag Lore), through the interface and against the stand-in service
 * (`e2e/fake-ai.mjs`): the operator chooses "One for all" under Server › KI-Anbieter (the shared module ki), puts in
 * the service without listing its address in the own network, and every account is told it needs nothing of its own. The settings are put back as they were found, since
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
    data: { ai_allowed: before.ai_allowed, ai_private_hosts: before.ai_private_hosts, ai_mode: before.ai_mode, ai_per_minute: 20 },
  })
})

test('the operator brings one service for all, and an account is told it needs nothing of its own', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  expect((await page.request.put('/api/settings', { headers: TAB, data: { ai_mode: 'own' } })).ok()).toBe(true)

  // Server › KI-Anbieter (the shared module ki): the way of access, then the service for all.
  await page.goto('/settings/ai-provider')
  const operator = page.getByTestId('ki-operator')
  const way = operator.getByTestId('ki-operator-mode')
  const forAll = way.getByRole('radio', { name: 'One for all' })
  await expect(way.getByRole('radio', { name: 'Each account itself' })).toHaveAttribute('aria-checked', 'true')
  await forAll.click()
  await expect(forAll).toHaveAttribute('aria-checked', 'true')
  // The list of hosts in the own network is about members' own addresses; with one for all it is not asked.
  await expect(operator.getByTestId('ki-operator-hosts')).toHaveCount(0)

  const shared = operator.getByTestId('ki-operator-service')
  // The tiles fill in the address as in an account's own access.
  await shared.getByRole('radio', { name: 'Ollama' }).click()
  await expect(shared.getByTestId('ki-operator-service-url')).toHaveValue('http://ollama:11434/v1/')
  await shared.getByTestId('ki-operator-service-url').fill(SERVICE)
  await shared.getByTestId('ki-operator-service-key').fill('e2e-stand-in-key')
  await shared.getByTestId('ki-operator-service-load').click()
  await shared.getByTestId('ki-operator-service-models').selectOption('stand-in')
  await shared.getByTestId('ki-operator-service-save').click()
  // Complete now: the check of the connection is offered, and it answers.
  await operator.getByTestId('ki-operator-probe').click()
  await expect(operator.getByTestId('ki-operator-probe-result')).toContainText(/Answer after/)
  await expect(operator.getByTestId('ki-operator-service-key')).toHaveValue('')
  await expect(operator.getByTestId('ki-operator-service-key')).toHaveAttribute('placeholder', 'Stays; type only to change it.')

  // Lore and meaning (nexlore's card below): a service without models for vectors says so.
  expect((await page.request.put('/api/ai/shared', { headers: TAB, data: { url: NO_VECTORS.url } })).ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('ai-embed-none')).toBeVisible()
  expect((await page.request.put('/api/ai/shared', { headers: TAB, data: { url: SERVICE } })).ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('ai-embed-none')).toHaveCount(0)

  // The brake per person and minute, the module's card "Limits".
  const paced = page.waitForResponse((response) => response.url().endsWith('/api/server/ai') && response.request().method() === 'PUT')
  await page.getByTestId('ki-operator-per_minute').fill('60')
  await page.getByTestId('ki-operator-per_minute-save').click()
  expect((await paced).ok()).toBe(true)
  expect((await (await page.request.get('/api/settings')).json()).ai_per_minute).toBe(60)

  // Mein Konto › KI: ready with the operator's model, nothing of one's own to fill in.
  await page.goto('/settings/ai')
  await expect(page.getByTestId('ki-me-state')).toContainText('Ready')
  await expect(page.getByTestId('ki-me-model')).toContainText('stand-in')
  await expect(page.getByTestId('ki-me-where')).toContainText('Your texts stay in the own network.')
  await expect(page.getByTestId('ki-card-own')).toHaveCount(0)

  // It goes out with the operator's service (which one exactly is measured in backend/tests/test_ai_shared.py).
  const done = await page.request.post('/api/ai/run', { headers: TAB, data: { task: 'spelling', text: 'This is teh plan for today.' } })
  expect(await done.json()).toEqual({ text: 'This is the plan for today.' })
  const last = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(last.model).toBe('stand-in')
  expect(problems).toEqual([])
})
