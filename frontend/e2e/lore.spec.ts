/**
 * Frag Lore through the interface, against the stand-in service (`e2e/fake-ai.mjs`, which answers Lore word by word
 * and never with a real model): the entry in the header, a question and its answer as it comes, the chip that lights
 * its source, the line for what the notes do not say, the list of conversations, the spaces to leave out, the window
 * in the corner with the note open beside it and its proposal, an answer saved as a note, and that Lore shows only
 * where the operator switched it on and a service is ready. The operator's service for all is put in at the
 * start and the settings are put back at the end: the tests share one server and one operator.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-lore' }
const SERVICE = 'http://127.0.0.1:8478/v1/'
const onDisk = (rel: string) => fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault and the stand-in service')

let before: Record<string, unknown> = {}

test.beforeEach(async ({ page }) => {
  before = await (await page.request.get('/api/settings')).json()
  expect((await page.request.put('/api/settings', { headers: TAB, data: { ai_allowed: true, ai_mode: 'shared', lore_allowed: true } })).ok()).toBe(true)
  expect((await page.request.put('/api/ai/shared', { headers: TAB, data: { url: SERVICE, model: 'stand-in', key: 'e2e-stand-in-key' } })).ok()).toBe(true)
})

test.afterEach(async ({ page }) => {
  await page.request.delete('/api/lore/conversations', { headers: TAB })
  await page.request.put('/api/me/appearance', { headers: TAB, data: { lore_hidden: [], panel_tab: 'links' } })
  await page.request.put('/api/ai/shared', { headers: TAB, data: { url: '', model: '', key: '' } })
  await page.request.put('/api/settings', { headers: TAB, data: { ai_allowed: before.ai_allowed, ai_mode: 'own', lore_allowed: false } })
  await page.evaluate(() => {
    localStorage.removeItem('nexlore.loreOpen')
    sessionStorage.removeItem('nexlore.loreConversation')
  }).catch(() => undefined)
})

function problems(page: Page): string[] {
  const found: string[] = []
  page.on('console', (message) => message.type() === 'error' && found.push(message.text()))
  page.on('pageerror', (error) => found.push(error.message))
  return found
}

test('Lore answers a question from the notes, with its source, and keeps the conversation', async ({ page }) => {
  const seen = problems(page)
  await page.goto('/')
  await page.getByRole('link', { name: 'Ask Lore' }).click()
  await expect(page).toHaveURL(/\/lore$/)
  await expect(page.getByRole('heading', { name: 'What would you like to know?' })).toBeVisible()

  const field = page.getByRole('textbox', { name: 'Ask Lore something about your notes …' })
  await field.fill('How often do the glasswing backups run?')
  await field.press('Enter')
  const answer = page.getByTestId('lore-answer').last()
  await expect(answer.getByTestId('lore-text')).toContainText('The glasswing backups run every hour')
  await expect(page).toHaveURL(/\/lore\/\d+$/)
  await expect(answer.getByTestId('lore-missing')).toHaveText('Not in your notes: when the copy was last checked')
  // Sources and the way it searched are folded under the bubble.
  await expect(answer.getByTestId('lore-sources')).toHaveCount(0)
  await answer.getByTestId('lore-trace-toggle').click()
  await expect(answer.getByTestId('lore-trace')).toContainText(/Searched (one space|\d+ spaces), read (one note|\d+ notes)/)

  // A raised number opens the sources and lights its own.
  await answer.getByTestId('lore-text').locator('sup button[data-source="1"]').click()
  const card = answer.getByTestId('lore-sources').locator('[data-card="1"]')
  await expect(card).toContainText('Glasswing backups')
  await expect(card).toHaveClass(/bg-accent-500/)

  // The conversation is in the list, and comes back after a reload.
  await expect(page.getByTestId('lore-list').getByRole('link', { name: 'How often do the glasswing backups run?' })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('lore-answer').getByTestId('lore-text')).toContainText('every hour')

  // A source opens the note.
  await page.getByTestId('lore-sources-toggle').click()
  await page.getByTestId('lore-sources').locator('[data-card="1"]').click()
  await expect(page).toHaveURL(/\/note\/Zyx\/Lore\/Glasswing%20backups\.md/)
  expect(seen).toEqual([])
})

test('when the model can, Lore looks further and the new source joins the answer', async ({ page }) => {
  await page.goto('/lore')
  const field = page.getByRole('textbox', { name: 'Ask Lore something about your notes …' })
  await field.fill('Please look further: how long did it take?')
  await field.press('Enter')
  const answer = page.getByTestId('lore-answer').last()
  await expect(answer.getByTestId('lore-text')).toContainText('every hour')
  await answer.getByTestId('lore-trace-toggle').click()
  await expect(answer.getByTestId('lore-step')).toHaveText(['then: looked for “glasswing restore”, 2 new sources'])
  await answer.getByTestId('lore-sources-toggle').click()
  await expect(answer.getByTestId('lore-sources')).toContainText('Glasswing drill')
})

test('going from one conversation to another and back shows each its own', async ({ page }) => {
  await page.goto('/lore')
  const field = page.getByRole('textbox', { name: 'Ask Lore something about your notes …' })
  await field.fill('First question about glasswing backups?')
  await field.press('Enter')
  await expect(page.getByTestId('lore-answer').getByTestId('lore-text')).toBeVisible()
  await page.getByRole('button', { name: 'New conversation' }).click()
  await expect(page.getByTestId('lore-question')).toHaveCount(0)
  await field.fill('Second question about the glasswing drill?')
  await field.press('Enter')
  await expect(page.getByTestId('lore-answer').getByTestId('lore-text')).toBeVisible()
  const list = page.getByTestId('lore-list')
  await list.getByRole('link', { name: 'First question about glasswing backups?' }).click()
  await expect(page.getByTestId('lore-question')).toHaveText(['First question about glasswing backups?'])
  await list.getByRole('link', { name: 'Second question about the glasswing drill?' }).click()
  await expect(page.getByTestId('lore-question')).toHaveText(['Second question about the glasswing drill?'])
  await list.getByRole('link', { name: 'First question about glasswing backups?' }).click()
  await expect(page.getByTestId('lore-question')).toHaveText(['First question about glasswing backups?'])
})

test('a space left out is not asked, and the choice stays with the account', async ({ page }) => {
  await page.goto('/lore')
  const chips = page.getByTestId('lore-spaces')
  const zyx = chips.getByRole('button', { name: 'Zyx', exact: true })
  await expect(zyx).toHaveAttribute('aria-pressed', 'true')
  await zyx.click()
  await expect(zyx).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).appearance.lore_hidden.length).toBe(1)
  const field = page.getByRole('textbox', { name: 'Ask Lore something about your notes …' })
  await field.fill('How often do the glasswing backups run?')
  await field.press('Enter')
  await expect(page.getByTestId('lore-answer').getByTestId('lore-text')).toBeVisible()
  // Nothing of the space left out went to the service.
  const last = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(JSON.stringify(last.messages)).not.toContain('kept for two days')
  await page.reload()
  await expect(page.getByTestId('lore-spaces').getByRole('button', { name: 'Zyx', exact: true })).toHaveAttribute('aria-pressed', 'false')
})

test('in the corner Lore answers about the note open and proposes a change that is taken over on it', async ({ page }) => {
  const seen = problems(page)
  await page.goto('/note/Zyx/Lore/Glasswing%20drill.md')
  await page.getByTestId('lore-fab').click()
  const overlay = page.getByTestId('lore-overlay')
  await expect(overlay.getByTestId('lore-about')).toContainText('About: Glasswing drill')
  await overlay.getByRole('button', { name: 'What is missing here?' }).click()
  await expect(overlay.getByTestId('lore-text')).toContainText('every hour')
  // The note went along whole.
  const last = await (await page.request.get('http://127.0.0.1:8478/last')).json()
  expect(last.messages[0].content).toContain('The last glasswing restore took 38 minutes.')
  await overlay.getByRole('button', { name: 'Propose for the note' }).click()
  await expect(overlay.getByTestId('lore-proposed')).toBeVisible()
  await overlay.getByRole('button', { name: 'Close Lore' }).click()
  await page.getByRole('button', { name: 'Compare' }).first().click()
  await page.getByRole('button', { name: 'Take over', exact: true }).click()
  await expect.poll(() => onDisk('Zyx/Lore/Glasswing drill.md')).toContain('- [ ] Check the copy')
  expect(onDisk('Zyx/Lore/Glasswing drill.md')).toContain('The last glasswing restore took 38 minutes.')
  expect(seen).toEqual([])
})

test('the window in the corner keeps its conversation across pages and can ask without the note', async ({ page }) => {
  await page.goto('/note/Zyx/Lore/Glasswing%20backups.md')
  await page.getByTestId('lore-fab').click()
  const overlay = page.getByTestId('lore-overlay')
  await overlay.getByTestId('lore-about').getByRole('button', { name: 'Ask without this note' }).click()
  await expect(overlay.getByTestId('lore-about')).toHaveCount(0)
  const field = overlay.getByRole('textbox', { name: 'Ask on …' })
  await field.fill('How often do the glasswing backups run?')
  const asked = page.waitForRequest((request) => request.url().endsWith('/api/lore/ask'))
  await field.press('Enter')
  expect((await asked).postDataJSON().note).toBeUndefined()
  await expect(overlay.getByTestId('lore-text')).toContainText('every hour')
  // Another page: the window stays open, with the same conversation; another note comes along again.
  await page.goto('/note/Zyx/Lore/Glasswing%20drill.md')
  await expect(page.getByTestId('lore-overlay').getByTestId('lore-question')).toHaveText(['How often do the glasswing backups run?'])
  await expect(page.getByTestId('lore-overlay').getByTestId('lore-about')).toContainText('Glasswing drill')
  // Not on the page Ask Lore itself.
  await page.goto('/lore')
  await expect(page.getByTestId('lore-fab')).toHaveCount(0)
})

test('an answer is saved as a note with its source as a link', async ({ page }) => {
  await page.goto('/lore')
  const field = page.getByRole('textbox', { name: 'Ask Lore something about your notes …' })
  await field.fill('How often do the glasswing backups run?')
  await field.press('Enter')
  const answer = page.getByTestId('lore-answer').last()
  await answer.getByRole('button', { name: 'Save as a note' }).click()
  await expect(answer.getByTestId('lore-saved')).toContainText('Zyx › Lore › Lore')
  const saved = await answer.getByTestId('lore-saved').getByRole('button').innerText()
  const rel = saved.split(' › ').join('/') + '.md'
  const text = onDisk(rel)
  expect(text).toContain('> [!question] How often do the glasswing backups run?')
  expect(text).toContain('[[Zyx/Lore/Glasswing backups|1]]')
})

test('with a model for meaning, a note shows the notes most like it', async ({ page }) => {
  expect((await page.request.put('/api/ai/shared', { headers: TAB, data: { embed_model: 'stand-in-embed' } })).ok()).toBe(true)
  await expect
    .poll(async () => {
      const state = await (await page.request.get('/api/ai/shared')).json()
      return state.meaning.total > 0 && state.meaning.done === state.meaning.total
    }, { timeout: 60_000 })
    .toBe(true)
  await page.goto('/note/Zyx/Lore/Glasswing%20drill.md')
  await page.getByRole('tab', { name: /Links/ }).click()
  // The nearest are about glasswing; which one comes first depends on the notes other tests made (a saved answer
  // about glasswing is just as near), and the note itself is never among them.
  const first = page.getByTestId('similar-notes').locator('button[data-note]').first()
  await expect(first).toHaveAttribute('data-note', /glasswing/i)
  await expect(page.getByTestId('similar-notes').locator('button[data-note="Zyx/Lore/Glasswing drill.md"]')).toHaveCount(0)
  await page.goto('/settings?tab=server&sub=extensions#ai')
  await expect(page.getByTestId('ai-meaning-progress')).toContainText(/notes read in/)
  await page.request.put('/api/ai/shared', { headers: TAB, data: { embed_model: '' } })
})

test('without a service Lore says what is missing and where to put it in', async ({ page }) => {
  await page.request.put('/api/settings', { headers: TAB, data: { ai_mode: 'own' } })
  await page.request.put('/api/ai', { headers: TAB, data: { active: false } })
  await page.goto('/lore')
  await expect(page.getByTestId('lore-no-thread')).toContainText('Lore has no thread right now')
  await page.getByRole('link', { name: 'Set up an AI service' }).click()
  await expect(page).toHaveURL(/\/account\?tab=ai#ai$/)
  // With AI not allowed at all, the header has no entry.
  await page.request.put('/api/settings', { headers: TAB, data: { ai_allowed: false } })
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Ask Lore' })).toHaveCount(0)
  await expect(page.getByTestId('lore-fab')).toHaveCount(0)
})

test('the spider leaves its corner to what sits there, and on a phone steps aside while one writes', async ({ page }) => {
  const apart = async (other: ReturnType<Page['locator']>) => {
    const a = (await page.getByTestId('lore-fab').boundingBox())!
    const b = (await other.boundingBox())!
    return a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height
  }
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 760 }]) {
    await page.setViewportSize(size)
    await page.goto('/')
    await expect(page.getByTestId('lore-fab')).toBeVisible()
    for (const name of ['Closer', 'Further away']) expect(await apart(page.getByRole('button', { name, exact: true }))).toBe(true)
  }
  // The dock of a canvas, on a phone as wide as the screen.
  const made = await (await page.request.post('/api/canvases', { data: { folder: 'Zyx', name: `Corner ${Date.now().toString(36)}` }, headers: TAB })).json()
  await page.request.delete('/api/locks', { params: { path: made.path }, headers: TAB })
  try {
    await page.goto(`/file/${made.path.split('/').map(encodeURIComponent).join('/')}`)
    const dock = page.getByRole('toolbar').filter({ has: page.getByRole('button', { name: /Text/ }) })
    await expect(dock).toBeVisible()
    await expect(page.getByTestId('lore-fab')).toBeVisible()
    expect(await apart(dock)).toBe(true)
  } finally {
    await page.request.delete('/api/files', { params: { path: made.path }, headers: TAB })
  }
  // Writing on a phone: the field and the row above the keyboard get the bottom of the screen.
  await page.goto('/note/Zyx/Lore/Glasswing%20drill.md?edit=1')
  await page.locator('.ProseMirror').click()
  await expect(page.getByTestId('lore-fab')).toHaveCount(0)
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.getByTestId('lore-fab')).toBeVisible()
})

test('switched off by the operator, Lore shows nowhere and the page says why', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('lore-fab')).toBeVisible()
  await page.request.put('/api/settings', { headers: TAB, data: { lore_allowed: false } })
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Ask Lore' })).toHaveCount(0)
  await expect(page.getByTestId('lore-fab')).toHaveCount(0)
  await page.goto('/lore')
  await expect(page.getByTestId('lore-no-thread')).toContainText('has not switched on Ask Lore')
  // The operator switches it on in the card.
  await page.goto('/settings?tab=server&sub=extensions#ai')
  await page.locator('#ai').getByRole('checkbox', { name: /Allow Ask Lore/ }).check()
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).lore).toBe(true)
  await page.goto('/')
  await expect(page.getByTestId('lore-fab')).toBeVisible()
})
