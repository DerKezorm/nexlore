/**
 * Block Y in the interface: rights per tool under a key, a request that waits for approval (menu, news, approvals
 * page), the consent page of a connector signing in with OAuth, and the operator's block list.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from './fixtures'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-mcprights' }
const REDIRECT = 'https://connector.example.com/api/mcp/auth_callback'

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function openMcp(page: Page) {
  const opened = await page.request.put('/api/settings', { data: { mcp_allowed: true, mcp_max_level: 'write', mcp_oauth_allowed: true }, headers: TAB })
  expect(opened.ok()).toBe(true)
}

async function makeKey(page: Page, name: string): Promise<{ id: number; token: string }> {
  const made = await page.request.post('/api/mcp/keys', { data: { name, level: 'write' }, headers: TAB })
  expect(made.status()).toBe(201)
  const body = await made.json()
  return { id: body.key.id, token: body.token }
}

async function tool(program: APIRequestContext, token: string, name: string, args: object) {
  const answer = await program.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(answer.status()).toBe(200)
  const result = (await answer.json()).result
  return { failed: result.isError as boolean, value: JSON.parse(result.content[0].text) }
}

// The tests share the account: keys made here go again, requests left open are declined.
test.afterEach(async ({ page }) => {
  for (const request of await (await page.request.get('/api/mcp/requests')).json()) {
    if (request.status === 'waiting') await page.request.post(`/api/mcp/requests/${request.id}/decline`, { headers: TAB })
  }
  const keys = (await (await page.request.get('/api/mcp/keys')).json()).keys as { id: number; name: string }[]
  for (const key of keys.filter((k) => k.name.startsWith('Y '))) await page.request.delete(`/api/mcp/keys/${key.id}`, { headers: TAB })
  await page.request.put('/api/mcp/blocked', { data: { tools: ['delete_space', 'empty_trash'] }, headers: TAB })
})

test('rights per tool are set under the key and kept', async ({ page }) => {
  const problems = collectProblems(page)
  await openMcp(page)
  await makeKey(page, 'Y rights')
  await page.goto('/settings/connections')
  const row = page.locator('[data-card="ai-tools"]').getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'Y rights' })
  // "Rechte je Werkzeug" of the shared module mcp 1.1.0.
  await row.getByRole('button', { name: 'Rights per tool' }).click()
  const box = page.getByTestId('tool-rights-dialog')
  // mcp 1.1.2: rows instead of a table, and every choice saves at once (MCP 21).
  const right = (tool: string) => box.getByTestId('tool-rights-table').locator(`[data-tool="${tool}"]`).getByTestId('tool-right')
  // A new key may use everything of its level at once (decision 3); reading cannot be asked for, so a reading tool
  // offers only Allow and Deny (mcp 1.1.2).
  await expect(right('create_note').getByRole('radio', { name: 'Allow' })).toHaveAttribute('aria-checked', 'true')
  await expect(right('trash_note').getByRole('radio', { name: 'Allow' })).toHaveAttribute('aria-checked', 'true')
  await expect(right('read_note').getByRole('radio', { name: 'Allow' })).toHaveAttribute('aria-checked', 'true')
  await expect(right('read_note').getByRole('radio', { name: 'Ask' })).toHaveCount(0)
  // Blocked by the operator: cannot be chosen.
  await expect(right('delete_space').getByRole('radio', { name: 'Allow' })).toBeDisabled()
  const saving = () => page.waitForResponse((answer) => /\/api\/connections\/mcp\/keys\/.+\/rights$/.test(answer.url()) && answer.request().method() === 'PUT')
  let saved = saving()
  await right('create_note').getByRole('radio', { name: 'Ask' }).click()
  expect((await saved).status()).toBe(200)
  saved = saving()
  await right('trash_note').getByRole('radio', { name: 'Deny' }).click()
  expect((await saved).status()).toBe(200)
  await expect(box.getByTestId('tool-rights-saved')).toHaveText('Saved.')
  await box.getByTestId('tool-rights-close').click()
  await page.reload()
  await page.locator('[data-card="ai-tools"]').getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'Y rights' }).getByRole('button', { name: 'Rights per tool' }).click()
  await expect(right('create_note').getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true')
  await expect(right('trash_note').getByRole('radio', { name: 'Deny' })).toHaveAttribute('aria-checked', 'true')
  expect(problems).toEqual([])
})

test('a request waits under New in the sidebar, and approving runs exactly it', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  await openMcp(page)
  const key = await makeKey(page, 'Y asker')
  // A new key may make notes at once (mcp 1.1.0, decision 3): its account wants to be asked.
  expect((await page.request.put(`/api/mcp/keys/${key.id}/rights`, { data: { rights: { create_note: 'ask' } }, headers: TAB })).status()).toBe(200)
  const program = await playwright.request.newContext({ baseURL })
  const asked = await tool(program, key.token, 'create_note', { folder: 'Zoo', title: 'Asked for', content: 'Waited for a yes.\n' })
  expect(asked.value.status).toBe('waiting')
  const declined = await tool(program, key.token, 'create_note', { folder: 'Zoo', title: 'Never made', content: 'x' })

  await page.goto('/')
  // There is no account menu any more: the requests wait under New, each a line of its own.
  const news = page.getByTestId('sidebar-news')
  if ((await news.getByRole('button', { name: /New since your last visit/ }).getAttribute('aria-expanded')) !== 'true') {
    await news.getByRole('button', { name: /New since your last visit/ }).click()
  }
  // The rows of the shared module mcp 1.1.0 in the bell: program, tool, Allow and Decline right there.
  await expect(news.locator('[data-request]')).toHaveCount(2)
  await expect(news.locator(`[data-request="${asked.value.request}"]`)).toContainText('Y asker')
  await expect(news.locator(`[data-request="${asked.value.request}"]`)).toContainText('Make a note')

  await page.goto('/requests')
  const first = page.getByTestId(`request-${asked.value.request}`)
  await expect(first).toContainText('Make a note')
  await expect(first).toContainText('Asked for')
  // It runs out a day later, not "today"; and English quotes in English.
  await expect(first).not.toContainText('runs out today')
  await expect(first).toContainText('from “Y asker”')
  await first.getByRole('button', { name: 'Approve and run' }).click()
  // Decided, it moves below the waiting ones, with what came of it.
  await expect(page.getByTestId(`request-${asked.value.request}`)).toContainText('done')
  await expect.poll(() => fs.existsSync(path.join(DATA, 'vault', 'Zoo', 'Asked for.md'))).toBe(true)
  expect(fs.readFileSync(path.join(DATA, 'vault', 'Zoo', 'Asked for.md'), 'utf-8')).toBe('Waited for a yes.\n')
  await page.getByTestId(`request-${declined.value.request}`).getByRole('button', { name: 'Decline' }).click()
  await expect(page.getByTestId('requests-none')).toBeVisible()
  expect(fs.existsSync(path.join(DATA, 'vault', 'Zoo', 'Never made.md'))).toBe(false)
  // The program learns what came of it.
  expect((await tool(program, key.token, 'request_status', { request: asked.value.request })).value.status).toBe('done')
  expect((await tool(program, key.token, 'request_status', { request: declined.value.request })).value.status).toBe('declined')
  await program.dispose()
  await page.request.delete('/api/files', { params: { path: 'Zoo/Asked for.md' }, headers: TAB })
  expect(problems).toEqual([])
})

test('a connector signs in on the consent page and gets a key of its own', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  await openMcp(page)
  const program = await playwright.request.newContext({ baseURL })
  const registered = await program.post('/api/oauth/register', { data: { redirect_uris: [REDIRECT], client_name: 'Y connector' } })
  expect(registered.status()).toBe(201)
  const clientId = (await registered.json()).client_id
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  // The program's own page is not there: whatever nexlore sends the browser back to is caught here.
  let back = ''
  await page.route('https://connector.example.com/**', async (route) => {
    back = route.request().url()
    await route.fulfill({ status: 200, body: 'back at the program' })
  })
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'y-state' })
  await page.goto(`/oauth/authorize?${query}`)
  await expect(page.getByRole('heading', { name: 'Y connector wants to use nexlore' })).toBeVisible()
  await page.getByRole('radio', { name: /Read/ }).check()
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect.poll(() => back).toContain('code=')
  const returned = new URL(back)
  expect(returned.searchParams.get('state')).toBe('y-state')
  const traded = await program.post('/api/oauth/token', {
    form: { grant_type: 'authorization_code', code: returned.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
  })
  expect(traded.status()).toBe(200)
  const tokens = await traded.json()
  const spaces = await tool(program, tokens.access_token, 'list_spaces', {})
  expect(spaces.failed).toBe(false)
  await program.dispose()
  await page.unroute('https://connector.example.com/**')
  await page.goto('/settings/connections')
  const row = page.locator('[data-card="ai-tools"]').getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'Y connector' })
  await expect(row).toHaveAttribute('data-program', 'true')
  // The level chosen on the consent page, not more.
  await expect(row).toContainText('Read')
  await expect(row).not.toContainText('Write')
  await row.getByTestId('key-revoke').click()
  await page.getByTestId('key-revoke-dialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(page.locator('[data-card="ai-tools"]').getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'Y connector' })).toHaveCount(0)
  expect(problems).toEqual([])
})

test('the operator blocks a tool for everybody', async ({ page }) => {
  await openMcp(page)
  // Under the switch "MCP-Zugang" of the card "Schnittstellen" (Server › General), the parts of the shared module.
  await page.goto('/settings/server-connections')
  const blocked = page.getByTestId('mcp-operator-blocked')
  await blocked.getByText('Blocked tools').click()
  // The test id stands on the box itself (ui kit CheckboxRow), and it shows what the server keeps: checked once the
  // answer is in, not at the click.
  await expect(blocked.getByTestId('mcp-operator-block-delete_space')).toBeChecked()
  const saved = page.waitForResponse((answer) => answer.url().endsWith('/api/connections/mcp/admin') && answer.request().method() === 'PUT')
  await blocked.getByTestId('mcp-operator-block-trash_note').click()
  expect((await saved).status()).toBe(200)
  await expect(blocked.getByTestId('mcp-operator-block-trash_note')).toBeChecked()
  expect((await (await page.request.get('/api/mcp/tools')).json()).blocked).toContain('trash_note')
})
