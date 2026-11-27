/**
 * AI from outside through the interface (M7): the operator opens MCP, the account makes a key and sees it once, a
 * program proposes a draft over MCP, the note shows it, and taking it over writes only the changed line.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
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

// The tab beside the note is kept with the account, and the tests share one: back to the links after each.
test.afterEach(async ({ page }) => {
  await page.request.put('/api/me/appearance', { data: { panel: true, panel_tab: 'links' }, headers: { 'X-Nexlore-Client': 'tab-e2e-panel' } })
})

test('a key made on the account page proposes a draft that the note takes over', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  const opened = await page.request.put('/api/settings', {
    data: { mcp_allowed: true, mcp_max_level: 'write' },
    headers: { 'X-Nexlore-Client': 'tab-e2e-mcp0' },
  })
  expect(opened.ok()).toBe(true)

  // The card "KI-Werkzeuge (MCP)" of the shared key module, under My account › Connections.
  await page.goto('/settings/connections')
  const tools = page.locator('[data-card="ai-tools"]')
  await tools.getByTestId('tools-new').click()
  const keyDialog = page.getByTestId('key-dialog')
  await keyDialog.getByTestId('key-name').fill('Agent')
  await keyDialog.getByTestId('key-right').getByRole('radio', { name: /Drafts/ }).check()
  await keyDialog.getByTestId('key-submit').click()
  // Since schluessel 1.2.0 (B23) the new key shows in the window that made it.
  const shown = keyDialog.getByTestId('key-made')
  await expect(shown).toContainText('It is shown this once only')
  const token = (await shown.getByTestId('key-secret').locator('input').inputValue()).trim()
  expect(token).toMatch(/^nxl_/)
  await expect(shown.getByTestId('key-header').locator('input')).toHaveValue(`Authorization: Bearer ${token}`)
  await shown.getByTestId('key-done').click()
  // What to do with it: the lines for a program, with this address and a stand-in for the key shown only once.
  const address = `${new URL(page.url()).origin}/api/mcp`
  await tools.getByTestId('mcp-how-to').getByRole('button').first().click()
  expect(JSON.parse(await tools.getByTestId('mcp-recipe-json').locator('input').inputValue())).toEqual({
    mcpServers: { nexlore: { type: 'http', url: address, headers: { Authorization: 'Bearer YOUR-KEY' } } },
  })
  await expect(tools.getByTestId('mcp-recipe-command').locator('input')).toHaveValue(
    `claude mcp add --transport http nexlore ${address} --header "Authorization: Bearer YOUR-KEY"`,
  )
  await expect(keyDialog).toHaveCount(0)
  await expect(page.getByText(token)).toHaveCount(0)

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
  await page.getByRole('tab', { name: 'Versions' }).click()
  // MCP decision 15: the history names the key, as nexnotes does.
  await expect(page.getByText('MCP · Agent').first()).toBeVisible()
  expect(problems).toEqual([])
})

test('a key made for one space sees no other', async ({ page, playwright, baseURL }) => {
  const problems = collectProblems(page)
  const opened = await page.request.put('/api/settings', {
    data: { mcp_allowed: true, mcp_max_level: 'write' },
    headers: { 'X-Nexlore-Client': 'tab-e2e-mcp0' },
  })
  expect(opened.ok()).toBe(true)
  await page.goto('/settings/connections')
  const tools = page.locator('[data-card="ai-tools"]')
  await tools.getByTestId('tools-new').click()
  const dialog = page.getByTestId('key-dialog')
  await dialog.getByTestId('key-name').fill('Zoo only')
  await dialog.getByRole('radio', { name: 'Only these' }).check()
  const make = dialog.getByTestId('key-submit')
  await expect(make).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Zoo', exact: true }).check()
  await make.click()
  const shown = dialog.getByTestId('key-made')
  const token = (await shown.getByTestId('key-secret').locator('input').inputValue()).trim()
  await shown.getByTestId('key-done').click()
  await expect(tools.getByTestId('key-row').filter({ visible: true }).filter({ hasText: 'Zoo only' })).toContainText(/Read.*Zoo/)

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

test('the operator switches MCP off again, and both pages say where it goes on', async ({ page }) => {
  const closed = await page.request.put('/api/settings', { data: { mcp_allowed: false }, headers: { 'X-Nexlore-Client': 'tab-e2e-mcp0' } })
  expect(closed.ok()).toBe(true)
  // The account page says why there are no keys; the operator's switch is "MCP-Zugang" under Server › General.
  await page.goto('/settings/connections')
  const tools = page.locator('[data-card="ai-tools"]')
  await expect(tools.getByTestId('tools-off')).toContainText('The operator has switched MCP access off.')
  await page.goto('/settings/extensions#mcp')
  await expect(page).toHaveURL(/\/settings\/server-connections#mcp$/)
  await expect(page.getByTestId('interfaces-mcp')).not.toBeChecked()
  await expect(page.getByTestId('mcp-settings')).toBeVisible()
})
