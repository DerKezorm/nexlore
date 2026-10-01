/**
 * Everyday use (M6) through the interface, against the real backend and the built app: the task overview and ticking
 * off, a recurring task, the calendar making a daily note from the template, a new note from a template, "Today",
 * the phone, and the service worker (built app only: it never answers for /api, and signing out empties its caches).
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

import { OPERATOR } from './global-setup'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''

function onDisk(rel: string): string {
  return fs.readFileSync(path.join(DATA, 'vault', ...rel.split('/')), 'utf-8')
}

function day(offset = 0): string {
  const when = new Date()
  when.setDate(when.getDate() + offset)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
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

test('the overview lists the tasks by when they are due, and ticking one off writes only its line', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/tasks?x=1')
  await page.getByRole('combobox', { name: 'Space' }).selectOption('Year')
  const rows = page.getByTestId('task-row')
  await expect(rows.filter({ hasText: 'Fix the gate' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Overdue/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Overdue\s*1$/ })).toBeVisible()
  const before = onDisk('Year/Chores.md')
  await rows.filter({ hasText: 'Fix the gate' }).getByRole('button', { name: 'Mark as done' }).click()
  await expect.poll(() => onDisk('Year/Chores.md')).not.toBe(before)
  expect(onDisk('Year/Chores.md')).toBe(
    before.replace(`- [ ] Fix the gate 📅 ${day(-1)} #garden\r\n`, `- [x] Fix the gate 📅 ${day(-1)} #garden ✅ ${day(0)}\r\n`),
  )
  await expect(rows.filter({ hasText: 'Fix the gate' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Done/ }).click()
  await expect(rows.filter({ hasText: 'Fix the gate' })).toBeVisible()
  expect(problems).toEqual([])
})

test('ticking off a recurring task puts its next time above it', async ({ page }) => {
  await page.goto('/tasks')
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('Sweep the yard')
  const row = page.getByTestId('task-row').filter({ hasText: 'Sweep the yard' })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'Mark as done' }).click()
  await expect(page.getByText('Next time added above it.')).toBeVisible()
  expect(onDisk('Year/Weekly.md')).toBe(
    `# Weekly\n\n- [ ] Sweep the yard 🔁 every week 📅 ${day(7)}\n- [x] Sweep the yard 🔁 every week 📅 ${day(0)} ✅ ${day(0)}\n`,
  )
})

test('a click on a day in the calendar makes its daily note from the template of the space', async ({ page }) => {
  const problems = collectProblems(page)
  const set = await page.request.put('/api/spaces/Year/options', {
    data: { daily_template: 'Templates/Day.md' },
    headers: { 'X-Nexlore-Client': 'tab-e2e-days' },
  })
  expect(set.ok()).toBe(true)
  // Two days ahead can be next month (28 September gives 1 October): the calendar goes to that month.
  const date = day(2)
  await page.goto(`/calendar?space=Year&month=${date.slice(0, 7)}`)
  await page.locator(`[data-date="${date}"]`).click()
  await page.waitForURL(new RegExp(`/note/Year/Daily/${date}\\.md`))
  expect(onDisk(`Year/Daily/${date}.md`)).toBe(`# Day ${date}\n\n- [ ] plan the day\n`)
  await page.goto(`/calendar?space=Year&month=${date.slice(0, 7)}`)
  await expect(page.locator(`[data-date="${date}"]`)).toContainText('Daily note')
  // The same day again opens that note, it does not make a second one.
  await page.locator(`[data-date="${date}"]`).click()
  await page.waitForURL(new RegExp(`/note/Year/Daily/${date}\\.md$`))
  expect(fs.readdirSync(path.join(DATA, 'vault', 'Year', 'Daily')).filter((name) => name.startsWith(date))).toEqual([`${date}.md`])
  expect(problems).toEqual([])
})

test('the calendar shows a wiki link in a task as the words it shows', async ({ page }) => {
  await page.goto('/calendar?space=Zoo')
  const cell = page.locator(`[data-date="${day(0).slice(0, 8)}15"]`)
  await expect(cell).toContainText('Call the plumber')
  await expect(cell).not.toContainText('[[')
})

test('a new note starts from a template, its placeholders filled and Templater left as it was', async ({ page }) => {
  await page.goto('/note/Year/Chores.md')
  await page.getByRole('button', { name: 'New note' }).first().click()
  const dialog = page.getByTestId('new-note-dialog')
  await dialog.getByLabel('Title').fill('Kick-off')
  await dialog.getByRole('radio', { name: 'Meeting' }).click()
  await expect(dialog.getByTestId('template-preview')).toContainText('# Kick-off')
  await expect(dialog.getByText('Templater commands are never run')).toBeVisible()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/note\/Year\/Kick-off\.md/)
  expect(onDisk('Year/Kick-off.md')).toBe(`# Kick-off\n\nStarted ${day(0)}\n<% tp.date.now() %>\n`)
})

test('a new note is one click away: in the header, beside each folder, and with Alt+N', async ({ page }) => {
  // Wide enough for the button's words (below, the menu's words need the room).
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/note/Year/Templates/Day.md')
  const dialog = page.getByTestId('new-note-dialog')
  // The header, with its words on a wide screen: beside the open note.
  const header = page.getByRole('banner').getByRole('button', { name: 'New note' })
  await expect(header).toContainText('New note')
  await header.click()
  await expect(dialog).toContainText('New note in “Year / Templates”')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  // Alt+N, the same.
  await page.keyboard.press('Alt+n')
  await expect(dialog).toContainText('New note in “Year / Templates”')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  // Beside a folder of the sidebar: into that folder, not the open note's.
  // The space right above the open note (the sidebar shows the note, and so this row).
  await page.getByTestId('sidebar-tree').getByRole('button', { name: /^Year \d+$/ }).hover()
  await page.getByRole('button', { name: 'New note in Year' }).click()
  await expect(dialog).toContainText('New note in “Year”')
})

test('"Today" opens the daily note of today in the main space of the account', async ({ page }) => {
  // The main space is the account's (Settings, General), not remembered by the browser (P5.19); set back at the end.
  const headers = { 'X-Nexlore-Client': 'tab-e2e-days' }
  await page.request.put('/api/me/appearance', { data: { home_space: 'Year' }, headers })
  try {
    await page.goto('/tasks')
    await expect(page.getByRole('button', { name: "Open today's daily note (Alt+T)" })).toBeEnabled()
    await page.keyboard.press('Alt+t')
    await page.waitForURL(new RegExp(`/note/Year/Daily/${day(0)}\\.md`))
    expect(fs.existsSync(path.join(DATA, 'vault', 'Year', 'Daily', `${day(0)}.md`))).toBe(true)
  } finally {
    await page.request.put('/api/me/appearance', { data: { home_space: '' }, headers })
  }
})

test('the header fits at every width of a desktop, the settings included', async ({ page }) => {
  for (const width of [1024, 1152, 1280, 1366, 1440, 1600]) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/tasks')
    const menu = page.getByRole('navigation', { name: 'Main menu' })
    await expect(menu.getByRole('link', { name: 'Settings' })).toBeVisible()
    const fits = await menu.evaluate((nav) => nav.scrollWidth <= nav.clientWidth + 1)
    expect(fits, `the menu overflows at ${width} px`).toBe(true)
  }
})

test('on a phone the calendar and the tasks fit, and the header reaches them', async ({ page }) => {
  const problems = collectProblems(page)
  await page.setViewportSize({ width: 360, height: 740 })
  for (const route of ['/calendar', '/tasks']) {
    await page.goto(route)
    await expect(page.getByTestId(route === '/calendar' ? 'calendar-page' : 'tasks-page')).toBeVisible()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // Inside the visible part of the header's menu, not only on the screen: the menu scrolls sideways.
    const menu = await page.getByRole('navigation', { name: 'Main menu' }).boundingBox()
    for (const link of ['/calendar', '/tasks']) {
      const box = await page.locator(`nav a[href="${link}"]`).boundingBox()
      expect(box && menu && box.x + box.width <= menu.x + menu.width + 0.5).toBe(true)
    }
  }
  expect(problems).toEqual([])
})

test('the service worker keeps the app, never anything from /api, and signing out empties it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  const answers: { url: string; worker: boolean }[] = []
  page.on('response', (response) => answers.push({ url: new URL(response.url()).pathname, worker: response.fromServiceWorker() }))
  await page.goto('/tasks')
  await expect(page.getByTestId('tasks-page')).toBeVisible()
  await page.waitForTimeout(500)
  expect(answers.filter((answer) => answer.url.startsWith('/api/') && answer.worker)).toEqual([])
  // An address under /api opened on its own (a download in a new tab) goes past the worker too.
  const direct = await page.goto('/api/health')
  expect(direct?.fromServiceWorker()).toBe(false)
  await page.goto('/tasks')
  expect(answers.some((answer) => answer.url.startsWith('/assets/') && answer.worker)).toBe(true)
  const kept = await page.evaluate(async () => {
    const found: string[] = []
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) found.push(new URL(request.url).pathname)
    return found
  })
  expect(kept.length).toBeGreaterThan(0)
  expect(kept.filter((url) => url.startsWith('/api'))).toEqual([])
  // Signing out: a fresh session of its own, so the one the other tests share stays valid.
  await page.context().clearCookies()
  const signIn = await page.request.post('/api/auth/login', {
    data: { name: OPERATOR.name, password: OPERATOR.password },
    headers: { 'X-Nexlore-Client': 'tab-e2e-sw00' },
  })
  expect(signIn.ok()).toBe(true)
  await page.goto('/')
  await page.getByRole('button', { name: `Account of ${OPERATOR.name}` }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL(/\/login/)
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBe(0)
})

test('a new note can go to another place, and the templates follow the space', async ({ page }) => {
  await page.goto('/note/Year/Chores.md')
  await expect(page.locator('article')).toContainText('Water the ferns')
  // Alt+N needs the spaces loaded (the note shows before them; the header button is enabled once they are there).
  await expect(page.getByRole('banner').getByRole('button', { name: 'New note' })).toBeEnabled()
  await page.keyboard.press('Alt+n')
  const dialog = page.getByTestId('new-note-dialog')
  await expect(dialog.getByTestId('new-note-where')).toHaveText('Year')
  // Year has templates.
  await expect(dialog.getByRole('radio', { name: 'Meeting' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Change' }).click()
  await dialog.getByRole('button', { name: 'Zone', exact: true }).click()
  await expect(dialog.getByTestId('new-note-where')).toHaveText('Zone')
  await expect(dialog).toContainText('New note in “Zone”')
  await expect(dialog.getByRole('radio', { name: 'Meeting' })).toHaveCount(0)
  await dialog.getByLabel('Title').fill('Placed elsewhere')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/note\/Zone\/Placed%20elsewhere\.md/)
  expect(fs.existsSync(path.join(DATA, 'vault', 'Zone', 'Placed elsewhere.md'))).toBe(true)
})

test('templates can be found: made from the new note dialog, saved from the menu, marked in the sidebar', async ({ page }) => {
  // A space without templates: the dialog offers to make one, and says what the placeholders do.
  await page.goto('/note/Zone/Across.md')
  await expect(page.locator('article')).toContainText('Across')
  // Alt+N needs the spaces loaded (the note shows before them; the header button is enabled once they are there).
  await expect(page.getByRole('banner').getByRole('button', { name: 'New note' })).toBeEnabled()
  await page.keyboard.press('Alt+n')
  const dialog = page.getByTestId('new-note-dialog')
  await expect(dialog).toContainText('{{title}}')
  await dialog.getByRole('button', { name: 'New template' }).click()
  await page.waitForURL(/\/note\/Zone\/Templates\/New%20template\.md\?edit=1|\/note\/Zone\/Templates\/New%20template\.md$/)
  await expect.poll(() => fs.existsSync(path.join(DATA, 'vault', 'Zone', 'Templates', 'New template.md'))).toBe(true)
  expect(onDisk('Zone/Templates/New template.md')).toContain('{{title}}')
  // The templates folder has its own symbol.
  const tree = page.getByTestId('sidebar-tree')
  // Zone's, not another space's that happens to be open too.
  await expect(tree.locator('li[data-path="Zone/Templates"] [data-look="template"]')).toBeVisible()

  // A note of its own saved as a template, from the menu.
  await page.goto('/note/Zone/Across.md')
  await tree.getByRole('button', { name: 'Across', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Save as template …' }).click()
  await page.getByRole('dialog', { name: /as a template/ }).getByRole('button', { name: 'Save as template' }).click()
  await expect(page.getByRole('status')).toContainText('Saved as a template in “Zone / Templates”')
  expect(onDisk('Zone/Templates/Across.md')).toBe(onDisk('Zone/Across.md'))
})

test('an empty task list tells why: filters that leave nothing can be cleared, and a first task is shown how to write', async ({ page, browser, baseURL }) => {
  await page.goto('/tasks')
  await page.getByPlaceholder('Search tasks').fill('qqqqzzzz')
  const empty = page.getByTestId('tasks-empty')
  await expect(empty).toContainText('No task fits these filters.')
  await empty.getByRole('button', { name: 'Clear the filters' }).click()
  await expect(page.getByPlaceholder('Search tasks')).toHaveValue('')
  await expect(empty).toHaveCount(0)
  // A new account without a space has no task anywhere.
  const invite = await page.request.post('/api/invites', { data: { days: 1 }, headers: { 'X-Nexlore-Client': 'tab-e2e-tasks' } })
  const token = new URL((await invite.json()).link).pathname.split('/').pop()!
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  const fresh = await context.newPage()
  const joined = await fresh.request.post(`/api/invite/${token}`, { data: { name: 'tasksless', password: 'e2e tasksless password' }, headers: { 'X-Nexlore-Client': 'tab-e2e-tasks' } })
  expect(joined.ok()).toBe(true)
  await fresh.goto('/tasks')
  await expect(fresh.getByTestId('tasks-empty')).toContainText('No tasks yet.')
  await expect(fresh.getByTestId('tasks-empty').locator('code')).toContainText(/- \[ \] Call the plumber 📅 \d{4}-\d{2}-\d{2}/)
  await context.close()
})
