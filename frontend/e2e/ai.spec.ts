/**
 * AI in notes through the interface, against a stand-in service (`e2e/fake-ai.mjs`, never a real model or key): the
 * operator allows it under Server › KI-Anbieter and lets each account bring its own service, the account connects its
 * own under Mein Konto › KI (both from the shared module ki), the editor offers it in the toolbar and the context
 * menu, a result stands next to the text and changes nothing until it is taken over, and the account sees what went
 * out.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-ai00' }
const SERVICE = 'http://127.0.0.1:8478/v1/'
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault and the stand-in service')

function collectProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

async function edit(page: Page, note: string) {
  await page.goto(`/note/${note}`)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
}

async function select(page: Page, text: string) {
  await page.locator('.ProseMirror').evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(wanted)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      return
    }
    throw new Error(`not found: ${wanted}`)
  }, text)
}

const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 })

test('the operator allows AI and lets each account bring its own; the account connects its service', async ({ page }) => {
  const problems = collectProblems(page)
  // Mein Konto › KI (the shared module ki): nothing allowed yet.
  await page.goto('/settings/ai')
  await expect(page.getByTestId('ki-me-state')).toContainText('Not ready')
  await expect(page.getByTestId('ki-me-state')).toContainText('No AI is set up or allowed on this server.')

  // Server › KI-Anbieter: the main switch, then "Each account itself" (a new installation starts with one for all).
  await page.goto('/settings/ai-provider')
  const operator = page.getByTestId('ki-operator')
  // The switch shows what the server keeps (ki 0.1.0): it turns on once the answer is in, not at the click itself.
  await operator.getByTestId('ki-operator-enabled').click()
  await expect(operator.getByTestId('ki-operator-enabled')).toBeChecked()
  await operator.getByTestId('ki-operator-mode').getByRole('radio', { name: 'Each account itself' }).click()
  await expect(operator.getByTestId('ki-operator-mode').getByRole('radio', { name: 'Each account itself' })).toHaveAttribute('aria-checked', 'true')
  // The stand-in runs on this machine: an own access reaches it only once the operator lists it.
  await operator.getByTestId('ki-operator-hosts').fill('127.0.0.1:8478')
  const hostsSaved = page.waitForResponse((answer) => answer.url().endsWith('/api/server/ai') && answer.request().method() === 'PUT')
  await operator.getByTestId('ki-operator-hosts-save').click()
  expect((await hostsSaved).ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('ki-operator-hosts')).toHaveValue('127.0.0.1:8478')

  await page.goto('/settings/ai')
  const own = page.getByTestId('ki-me-own')
  // A tile fills in the address and says where the key comes from.
  await own.getByTestId('ki-me-own-tile-openai').click()
  await expect(own.getByTestId('ki-me-own-url')).toHaveValue('https://api.openai.com/v1/')
  await expect(own.getByRole('link', { name: 'Get a key at OpenAI' })).toBeVisible()
  await own.getByTestId('ki-me-own-url').fill(SERVICE)
  await own.getByTestId('ki-me-own-key').fill('e2e-stand-in-key')
  await own.getByTestId('ki-me-own-load').click()
  await own.getByTestId('ki-me-own-models').selectOption('stand-in')
  await expect(own.getByTestId('ki-me-own-model')).toHaveValue('stand-in')
  await own.getByTestId('ki-me-own-save').click()
  // Saved complete, the AI is ready for this account; the key is not shown again.
  await expect(page.getByTestId('ki-me-state')).toContainText('Ready')
  await expect(page.getByTestId('ki-me-where')).toContainText('Your texts stay in the own network.')
  await expect(page.getByTestId('ki-me-mine')).toBeChecked()
  await expect(own.getByTestId('ki-me-own-key')).toHaveValue('')
  await expect(own.getByTestId('ki-me-own-key')).toHaveAttribute('placeholder', 'Stays; type only to change it.')
  const me = await (await page.request.get('/api/auth/me')).json()
  expect(me.ai_ready).toBe(true)
  expect(problems).toEqual([])
})

test('a correction stands next to the text and changes only what was chosen when taken over', async ({ page }) => {
  const problems = collectProblems(page)
  const before = onDisk('Zoo/Ai.md')
  await edit(page, 'Zoo/Ai.md')
  await page.locator('.ProseMirror').focus()
  await select(page, 'We meet on Thursday at teh office.')
  await page.getByTestId('editor-toolbar').getByRole('button', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Correct spelling' }).click()
  const dialog = page.getByTestId('ai-dialog')
  await expect(dialog.getByTestId('ai-scope')).toHaveText('The selection · 7 words')
  await expect(dialog.getByTestId('ai-rows')).toContainText('at the office.')
  // Nothing changed yet.
  expect(onDisk('Zoo/Ai.md')).toBe(before)
  await expect(page.locator('.ProseMirror')).toContainText('teh office')
  await dialog.getByRole('button', { name: 'Take it over' }).click()
  await expect(dialog).toHaveCount(0)
  await saved(page)
  expect(onDisk('Zoo/Ai.md')).toBe(before.replace('teh office', 'the office'))
  // What went out: the rules, the task, and only the selection, between the marks of the module's frame.
  const sent = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(sent.messages[1].content.split('\n').slice(1, -1).join('\n')).toBe('We meet on Thursday at teh office.')
  expect(sent.messages[0].content).toContain('Never invent, drop or alter a fact')
  expect(problems).toEqual([])
})

test('thrown away, a rewrite of the whole note leaves the file as it was', async ({ page }) => {
  const before = onDisk('Zoo/Ai whole.md')
  await edit(page, 'Zoo/Ai whole.md')
  // Nothing selected: the whole note, from the context menu.
  await page.locator('.ProseMirror p').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Rewrite' }).click()
  await page.getByRole('menuitem', { name: 'Plain language' }).click()
  const dialog = page.getByTestId('ai-dialog')
  await expect(dialog.getByTestId('ai-scope')).toContainText('The whole note')
  await expect(dialog.getByTestId('ai-rows')).toContainText('We will gather')
  await dialog.getByRole('button', { name: 'Throw it away' }).click()
  await expect(dialog).toHaveCount(0)
  await page.waitForTimeout(1500)
  expect(onDisk('Zoo/Ai whole.md')).toBe(before)
  const sent = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(sent.messages[0].content).toContain('in plain language')
})

test('a summary goes in after the block with the caret, and a written text into a note of its own', async ({ page }) => {
  await edit(page, 'Zoo/Ai insert.md')
  await page.locator('.ProseMirror').focus()
  await select(page, 'Second line stays.')
  await page.getByTestId('editor-toolbar').getByRole('button', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Summarize' }).click()
  const dialog = page.getByTestId('ai-dialog')
  await expect(dialog.getByTestId('ai-result')).toHaveText('- Summary: a meeting on Thursday.')
  await dialog.getByRole('button', { name: 'Insert at the cursor' }).click()
  await saved(page)
  expect(onDisk('Zoo/Ai insert.md')).toMatch(/Second line stays\.\n\n[-*] Summary: a meeting on Thursday\.\n$/)

  await page.getByTestId('editor-toolbar').getByRole('button', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Write for me …' }).click()
  // Turned down: the status stands after the sentence. The stand-in runs on this machine, in the own network: the
  // words of such a service are never shown to a member (review before 1.0.0), only those of a public one.
  await dialog.getByLabel('What should be written?').fill('Turn this down')
  await dialog.getByRole('button', { name: 'Write', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('The service answered with an error. (400)')
  await dialog.getByLabel('What should be written?').fill('An agenda for Thursday')
  await dialog.getByRole('button', { name: 'Write', exact: true }).click()
  // The fence the model put around it is gone.
  await expect(dialog.getByTestId('ai-result')).toHaveText('## Agenda\n\n- [ ] Welcome\n- [ ] Office')
  await dialog.getByLabel('Title of the new note').fill('Agenda from AI')
  await dialog.getByRole('button', { name: 'As a new note' }).click()
  await page.waitForURL(/\/note\/Zoo\/Agenda%20from%20AI\.md/)
  expect(onDisk('Zoo/Agenda from AI.md')).toContain('- [ ] Welcome')
  const sent = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(sent.messages[0].content).toContain('An agenda for Thursday')
})

test('the account sees what went out, word for word, and clears it; switched off, the editor offers no AI', async ({ page }) => {
  await page.goto('/settings/ai')
  const events = page.getByTestId('ki-me-events')
  // Four answered, one turned down after it went out: that one is in the list too.
  await expect(events.locator('tbody tr')).toHaveCount(5)
  await expect(events.locator('tbody tr').filter({ hasText: 'Did not work' })).toHaveCount(1)
  await events.locator('tbody tr').last().getByTestId('ki-me-event-show').click()
  const shown = page.getByTestId('ki-me-event')
  await expect(shown).toContainText('We meet on Thursday at teh office.')
  await expect(shown).toContainText('Never invent, drop or alter a fact')
  await shown.getByRole('button', { name: 'Close' }).first().click()
  await page.getByTestId('ki-me-events-clear').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear the list' }).click()
  await expect(events).toHaveText('Nothing went out yet.')

  const closed = await page.request.put('/api/settings', { data: { ai_allowed: false }, headers: TAB })
  expect(closed.ok()).toBe(true)
  await edit(page, 'Zoo/Ai off.md')
  await expect(page.getByTestId('editor-toolbar')).toBeVisible()
  await expect(page.getByTestId('editor-toolbar').getByRole('button', { name: 'AI' })).toHaveCount(0)
  await page.locator('.ProseMirror p').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Cut' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'AI' })).toHaveCount(0)
})
