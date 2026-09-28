/**
 * AI from outside through the interface (M7): the operator opens MCP, the account makes a key and sees it once, a
 * program proposes a draft over MCP, the note shows it, and taking it over writes only the changed line.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''

function onDisk(rel: string): string {
  return fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')
}

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('a key made on the account page proposes a draft that the note takes over', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  const opened = await page.request.put('/api/settings', {
    data: { mcp_allowed: true, mcp_max_level: 'write' },
    headers: { 'X-Nexlore-Client': 'tab-e2e-mcp0' },
  })
  expect(opened.ok()).toBe(true)

  await page.goto('/account')
  await page.getByRole('button', { name: 'New key' }).click()
  await page.getByLabel('Name').fill('Agent')
  await page.getByRole('radio', { name: /Drafts/ }).check()
  await page.getByRole('button', { name: 'Make the key' }).click()
  const shown = page.getByTestId('mcp-token')
  await expect(shown).toContainText('It is shown only now.')
  const token = (await shown.locator('code').first().textContent())!.trim()
  expect(token).toMatch(/^nxl_/)
  await shown.getByRole('button', { name: 'I have it' }).click()
  await expect(page.getByTestId('mcp-token')).toHaveCount(0)
  await expect(page.getByText('nxl_')).toHaveCount(1) // only the first characters stay

  // A program: no cookie, no Origin, the key in Authorization.
  const program = await playwright.request.newContext({ baseURL })
  const ask = async (method: string, params: object) => {
    const answer = await program.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 1, method, params },
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(answer.status()).toBe(200)
    return (await answer.json()).result
  }
  const note = JSON.parse((await ask('tools/call', { name: 'read_note', arguments: { path: 'Zoo/Draft me.md' } })).content[0].text)
  const made = await ask('tools/call', {
    name: 'propose_change',
    arguments: { path: 'Zoo/Draft me.md', base_hash: note.hash, reason: 'a better line', content: '# Draft me\n\nKept line.\nNew line.\n' },
  })
  expect(made.isError).toBe(false)
  await program.dispose()

  await page.goto('/note/Zoo/Draft me.md')
  await expect(page.getByText('Draft by Agent')).toBeVisible()
  await expect(page.getByTestId('drafts-count')).toHaveText('1')
  await page.getByRole('button', { name: 'Look at it' }).click()
  const dialog = page.getByRole('dialog', { name: 'Draft by Agent' })
  await expect(dialog.getByTestId('draft-rows')).toContainText('New line.')
  await dialog.getByRole('button', { name: 'Take it over' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Draft by Agent')).toHaveCount(0)
  // Only the changed line is new; the rest keeps its Windows line endings.
  expect(onDisk('Zoo/Draft me.md')).toBe('# Draft me\r\n\r\nKept line.\r\nNew line.\r\n')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.getByRole('button', { name: 'Show the history' }).click()
  await expect(page.getByText('AI (MCP)').first()).toBeVisible()
  expect(problems).toEqual([])
})

test('a key made for one space sees no other', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  const opened = await page.request.put('/api/settings', {
    data: { mcp_allowed: true, mcp_max_level: 'write' },
    headers: { 'X-Nexlore-Client': 'tab-e2e-mcp0' },
  })
  expect(opened.ok()).toBe(true)
  await page.goto('/account')
  await page.getByRole('button', { name: 'New key' }).click()
  await page.getByLabel('Name').fill('Zoo only')
  await page.getByRole('radio', { name: 'Only these' }).check()
  const make = page.getByRole('button', { name: 'Make the key' })
  await expect(make).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Zoo', exact: true }).check()
  await make.click()
  const shown = page.getByTestId('mcp-token')
  const token = (await shown.locator('code').first().textContent())!.trim()
  await shown.getByRole('button', { name: 'I have it' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Zoo only' }).getByTestId('mcp-key-spaces')).toHaveText('Zoo')

  const program = await playwright.request.newContext({ baseURL })
  const call = async (name: string, args: object) => {
    const answer = await program.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(answer.status()).toBe(200)
    return (await answer.json()).result
  }
  const listed = JSON.parse((await call('list_spaces', {})).content[0].text)
  expect(listed.map((space: { name: string }) => space.name)).toEqual(['Zoo'])
  const foreign = await call('read_note', { path: 'Zone/Across.md' })
  expect(foreign.isError).toBe(true)
  expect(foreign.content[0].text).toBe('Not found.')
  expect((await call('read_note', { path: 'Zoo/Across target.md' })).isError).toBe(false)
  await program.dispose()
  expect(problems).toEqual([])
})

test('the operator switches MCP off again, and the key card goes', async ({ page }) => {
  const closed = await page.request.put('/api/settings', { data: { mcp_allowed: false }, headers: { 'X-Nexlore-Client': 'tab-e2e-mcp0' } })
  expect(closed.ok()).toBe(true)
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'AI from outside (MCP)' })).toHaveCount(0)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'AI from outside (MCP)' })).toBeVisible()
})
