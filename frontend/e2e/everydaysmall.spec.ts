/**
 * Small things of everyday use from the review before 1.0.0 (block R): cancelled tasks, long task lists, repetitions
 * nexlore cannot read, a daily note without its template, links to notes and days not written yet, the task list in
 * the reading view, and what a view says when it cannot do something. Each test works in a space of its own and takes
 * it away again: the account is shared with the other tests.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes spaces of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-everyday0' }

async function space(page: Page, name: string, notes: Record<string, string>): Promise<void> {
  await page.goto('/settings?tab=spaces')
  expect((await page.request.post('/api/spaces', { data: { name }, headers: TAB })).status()).toBe(201)
  for (const [title, content] of Object.entries(notes)) {
    expect((await page.request.post('/api/notes', { data: { folder: name, title, content }, headers: TAB })).status()).toBe(201)
  }
}

async function away(page: Page, name: string): Promise<void> {
  await page.request.delete('/api/files?path=' + encodeURIComponent(name), { headers: TAB })
}

test('cancelled tasks have a chip of their own and are not among the done ones (P5.6)', async ({ page }) => {
  await space(page, 'Errands1', { List: '- [-] Dropped plan R1\n- [x] Finished plan R1\n' })
  try {
    await page.goto('/tasks')
    await page.getByRole('combobox', { name: 'Space' }).selectOption('Errands1')
    const rows = page.getByTestId('task-row')
    await page.getByRole('button', { name: /^Cancelled\s*1$/ }).click()
    await expect(rows.filter({ hasText: 'Dropped plan R1' })).toBeVisible()
    await expect(rows.filter({ hasText: 'Finished plan R1' })).toHaveCount(0)
    await page.getByRole('button', { name: /^Done\s*1$/ }).click()
    await expect(rows.filter({ hasText: 'Finished plan R1' })).toBeVisible()
    await expect(rows.filter({ hasText: 'Dropped plan R1' })).toHaveCount(0)
  } finally {
    await away(page, 'Errands1')
  }
})

test('a list of more than 500 tasks stays whole after ticking one off (P5.5)', async ({ page }) => {
  const lines = Array.from({ length: 620 }, (_, index) => `- [ ] Bulk task R5 ${String(index).padStart(3, '0')}`)
  await space(page, 'Errands2', { Bulk: lines.join('\n') + '\n' })
  try {
    const problems: string[] = []
    page.on('response', (response) => {
      if (response.url().includes('/api/tasks') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`)
    })
    await page.goto('/tasks')
    await page.getByRole('combobox', { name: 'Space' }).selectOption('Errands2')
    const rows = page.getByTestId('task-row')
    const more = page.getByRole('button', { name: /Load more/ })
    await expect(more).toBeVisible()
    while (await more.isVisible()) {
      const before = await rows.count()
      await more.click()
      await expect.poll(() => rows.count()).toBeGreaterThan(before)
    }
    await expect(rows).toHaveCount(620)
    await rows.filter({ hasText: 'Bulk task R5 000' }).getByRole('button', { name: 'Mark as done' }).click()
    await expect(rows).toHaveCount(619)
    expect(problems).toEqual([])
  } finally {
    await away(page, 'Errands2')
  }
})

test.describe('while a list is still on its way', () => {
  // page.route sees nothing the service worker answers.
  test.use({ serviceWorkers: 'block' })
  test('a search typed and taken back asks nothing again, and loaded tasks stay (P5.5)', async ({ page }, testInfo) => {
    const name = `Errands20${testInfo.retry || ''}`
    const lines = Array.from({ length: 450 }, (_, index) => `- [ ] Slow list task ${String(index).padStart(3, '0')}`)
    await space(page, name, { Bulk: lines.join('\n') + '\n' })
    try {
      await page.goto('/tasks')
      await page.getByRole('combobox', { name: 'Space' }).selectOption(name)
      const rows = page.getByTestId('task-row')
      await expect(rows).toHaveCount(200, { timeout: 15_000 })
      // From here the whole list comes slowly, a further part at once (what the CI showed, 01.10.2026).
      let asked = 0
      await page.route('**/api/tasks?**', async (route) => {
        if (new URL(route.request().url()).searchParams.get('offset') === '0') {
          asked++
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        await route.continue()
      })
      // A letter typed and taken back: the search is what it was.
      const search = page.getByPlaceholder('Search tasks')
      await search.press('x')
      await search.press('Backspace')
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: /Load more/ }).click()
      await expect(rows).toHaveCount(400)
      // Whatever was still on its way has come by now; the list stays as long as it was.
      await page.waitForTimeout(2500)
      await expect(rows).toHaveCount(400)
      expect(asked).toBe(0)
      await page.getByRole('button', { name: /Load more/ }).click()
      await expect(rows).toHaveCount(450)
    } finally {
      await page.unroute('**/api/tasks?**')
      await away(page, name)
    }
  })

  test('more tasks asked for while the list is asked again are not put after the wrong ones (P5.5)', async ({ page }, testInfo) => {
    const name = `Errands21${testInfo.retry || ''}`
    const lines = Array.from({ length: 450 }, (_, index) => `- [ ] Raced task ${String(index).padStart(3, '0')}`)
    await space(page, name, { Bulk: lines.join('\n') + '\n' })
    try {
      await page.goto('/tasks')
      await page.getByRole('combobox', { name: 'Space' }).selectOption(name)
      const rows = page.getByTestId('task-row')
      await expect(rows).toHaveCount(200, { timeout: 15_000 })
      // A further part comes slowly; meanwhile the list is asked for again (another chip and back).
      await page.route('**/api/tasks?**', async (route) => {
        if (new URL(route.request().url()).searchParams.get('offset') === '200') await new Promise((resolve) => setTimeout(resolve, 1500))
        await route.continue()
      })
      await page.getByRole('button', { name: /Load more/ }).click()
      const chips = page.getByRole('group', { name: 'Tasks' })
      await chips.getByRole('button', { name: /^Done/ }).click()
      await chips.getByRole('button', { name: /^Open/ }).click()
      await page.waitForTimeout(2500)
      // The list asked last is shown, nothing of the slow part after it.
      await expect(rows).toHaveCount(200)
      await expect(rows.first()).toContainText('Raced task 000')
    } finally {
      await page.unroute('**/api/tasks?**')
      await away(page, name)
    }
  })
})

test('ticking off a repetition nexlore cannot read says there is no next one (P5.8)', async ({ page }) => {
  await space(page, 'Errands3', { List: '- [ ] Water the fern R3 🔁 every blue moon\n' })
  try {
    await page.goto('/tasks')
    await page.getByRole('combobox', { name: 'Space' }).selectOption('Errands3')
    await page.getByTestId('task-row').filter({ hasText: 'Water the fern R3' }).getByRole('button', { name: 'Mark as done' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'cannot read this repetition' })).toBeVisible()
  } finally {
    await away(page, 'Errands3')
  }
})

test('a daily note whose template is gone opens with a word why it is empty (P5.3)', async ({ page }) => {
  await space(page, 'Errands4', { 'Day template': '# {{title}}\n' })
  try {
    const set = await page.request.put('/api/spaces/Errands4/options', { data: { daily_template: 'Day template.md' }, headers: TAB })
    expect(set.status()).toBe(200)
    // The template goes after it was chosen.
    await away(page, 'Errands4/Day template.md')
    await page.goto('/calendar?space=Errands4&month=2031-05')
    await page.locator('[data-date="2031-05-06"]').click()
    await page.waitForURL(/\/note\/Errands4\/.*2031-05-06\.md/)
    await expect(page.getByText("The space's daily template is gone")).toBeVisible()
  } finally {
    await away(page, 'Errands4')
  }
})

test('in the reading view a link to a note not written yet makes it, one to a day makes its daily note (P1.2, P5.4)', async ({ page }) => {
  await space(page, 'Errands5', { Links: 'See [[Fresh note R2]] and [[2031-03-04]].\n' })
  try {
    await page.goto('/note/Errands5/Links.md')
    await page.locator('.nn-prose a', { hasText: 'Fresh note R2' }).click()
    await expect(page).toHaveURL(/\/note\/Errands5\/Fresh%20note%20R2\.md/)
    await expect(page.locator('.ProseMirror')).toBeVisible()
    await page.goto('/note/Errands5/Links.md')
    await page.locator('.nn-prose a', { hasText: '2031-03-04' }).click()
    const options = await (await page.request.get('/api/spaces/Errands5/options')).json()
    const folder = (options.daily_folder as string).split('/').map(encodeURIComponent).join('/')
    expect(folder).not.toBe('')
    await expect(page).toHaveURL(new RegExp(`/note/Errands5/${folder}/2031-03-04\\.md`))
    // Not also a plain note beside the link.
    expect((await page.request.get('/api/note?path=' + encodeURIComponent('Errands5/2031-03-04.md'))).status()).toBe(404)
  } finally {
    await away(page, 'Errands5')
  }
})

test('the reading view shows a task with its box only, no bullet before it (P5.17)', async ({ page }) => {
  await space(page, 'Errands6', { List: '- [ ] Box only R17\n- Plain item R17\n' })
  try {
    await page.goto('/note/Errands6/List.md')
    const task = page.locator('.nn-prose li', { hasText: 'Box only R17' })
    await expect(task).toBeVisible()
    expect(await task.evaluate((element) => getComputedStyle(element).listStyleType)).toBe('none')
    const plain = page.locator('.nn-prose li', { hasText: 'Plain item R17' })
    expect(await plain.evaluate((element) => getComputedStyle(element).listStyleType)).toBe('disc')
  } finally {
    await away(page, 'Errands6')
  }
})

test('a view says in the reader\'s words what it cannot show (P5.14)', async ({ page }) => {
  await space(page, 'Errands7', { Odd: '```base\nviews:\n  - type: galaxy\n    name: Stars\n```\n' })
  try {
    await page.goto('/note/Errands7/Odd.md')
    await expect(page.getByText('nexlore does not know the view type “galaxy” and shows it as a table.')).toBeVisible()
  } finally {
    await away(page, 'Errands7')
  }
})

test('a space names its daily notes its own way: calendar, links and the steps to the next day follow (P5.22, P5.24)', async ({ page }, testInfo) => {
  // Calendar, two notes, a link and the editor: more than the usual half minute when the machine is busy.
  test.setTimeout(90_000)
  // Each wait has a limit of its own: a hang once used up the whole test (01.10.2026), and nothing said where.
  // A name of its own for a second try: the first one's space still holds its name from the trash.
  const name = `Errands8${testInfo.retry || ''}`
  await space(page, name, { Links: 'Plan for [[09.05.2031]].\n' })
  try {
    expect((await page.request.put(`/api/spaces/${name}/options`, { data: { daily_format: 'DD.MM.YYYY' }, headers: TAB })).status()).toBe(200)
    await page.goto(`/calendar?space=${name}&month=2031-05`)
    await page.locator('[data-date="2031-05-06"]').click()
    await page.waitForURL(/\/note\/Errands8\d*\/Daily\/06\.05\.2031\.md/, { timeout: 15_000 })
    await page.getByTestId('day-steps').getByRole('button', { name: /Day after/ }).click()
    await page.waitForURL(/\/note\/Errands8\d*\/Daily\/07\.05\.2031\.md/, { timeout: 15_000 })
    await page.goto(`/calendar?space=${name}&month=2031-05`)
    await expect(page.locator('[data-date="2031-05-06"]')).toContainText('Daily note')
    // A link in the space's pattern opens that day's note, and makes none beside the linking one.
    await page.goto(`/note/${name}/Links.md`)
    await page.locator('.nn-prose a', { hasText: '09.05.2031' }).click()
    await page.waitForURL(/\/note\/Errands8\d*\/Daily\/09\.05\.2031\.md/, { timeout: 15_000 })
    // "@tomorrow" in the editor links to tomorrow's note as the space names it.
    await page.goto(`/note/${name}/Links.md`)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator('.ProseMirror')).toBeFocused({ timeout: 15_000 })
    await page.keyboard.type(' @tomorrow')
    await expect(page.getByTestId('date-suggest')).toBeVisible()
    await page.keyboard.press('Enter')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const named = `${String(tomorrow.getDate()).padStart(2, '0')}.${String(tomorrow.getMonth() + 1).padStart(2, '0')}.${tomorrow.getFullYear()}`
    await expect(page.locator('.ProseMirror')).toContainText(named)
  } finally {
    await away(page, name)
  }
})

test('the options of a space offer daily notes it missed (P5.22)', async ({ page }) => {
  const notes: Record<string, string> = {}
  for (const day of ['01', '02', '03']) notes[`${day}.09.2026`] = 'x\n'
  await space(page, 'Errands9', notes)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/settings?tab=spaces')
    await page.locator('#spaces li').filter({ hasText: 'Errands9' }).getByRole('button', { name: 'Options' }).click()
    const dialog = page.getByRole('dialog', { name: /Options of “Errands9”/ })
    await expect(dialog.getByTestId('daily-guess')).toContainText('3 notes named like daily notes (DD.MM.YYYY)')
    await dialog.getByTestId('daily-guess').getByRole('button', { name: 'Use them' }).click()
    await expect(dialog.getByLabel('Name of daily notes')).toHaveValue('DD.MM.YYYY')
    await expect(dialog.getByTestId('daily-guess')).toHaveCount(0)
  } finally {
    await away(page, 'Errands9')
  }
})

test('Today goes to the space of the open note, else to the main space of the account (P5.19)', async ({ page }) => {
  // Named last: the first own space, where Today goes without either rule, is another one.
  await space(page, 'Zzzerrands', { Open: 'x\n' })
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/note/Zzzerrands/Open.md')
    await page.getByRole('button', { name: /Open today's daily note/ }).click()
    await page.waitForURL(/\/note\/Zzzerrands\/Daily\//)
    await page.goto('/settings')
    await page.locator('#home-space select').selectOption('Zzzerrands')
    await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).appearance.home_space).toBe('Zzzerrands')
    await page.goto('/tasks')
    await page.getByRole('button', { name: /Open today's daily note/ }).click()
    await page.waitForURL(/\/note\/Zzzerrands\/Daily\//)
  } finally {
    await page.request.put('/api/me/appearance', { data: { home_space: '' }, headers: TAB })
    await away(page, 'Zzzerrands')
  }
})

test('the palette puts a template, the date or the time into the note being written (P5.24)', async ({ page }) => {
  await space(page, 'Errands11', { Target: 'Start.\n' })
  await page.request.post('/api/folders', { data: { parent: 'Errands11', name: 'Templates', existing_ok: true }, headers: TAB })
  const template = await page.request.post('/api/notes', {
    data: { folder: 'Errands11/Templates', title: 'Checklist', content: '---\nkind: list\n---\n- [ ] Pack for {{title}}\n' },
    headers: TAB,
  })
  try {
    expect(template.status()).toBe(201)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/note/Errands11/Target.md')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator('.ProseMirror')).toBeFocused({ timeout: 15_000 })
    const palette = page.getByRole('dialog', { name: 'Commands' })
    await page.keyboard.press('ControlOrMeta+p')
    await page.keyboard.type('insert today')
    await expect(palette.getByRole('option')).toHaveText([/Insert today's date/])
    await page.keyboard.press('Enter')
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    await expect(page.locator('.ProseMirror')).toContainText(iso)
    await page.keyboard.press('ControlOrMeta+p')
    await page.keyboard.type('insert template')
    await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: 'Insert template …' }).getByRole('button', { name: 'Checklist' }).click()
    await expect(page.locator('.ProseMirror')).toContainText('Pack for Target')
    // Its front matter stays out of the note.
    await expect(page.locator('.ProseMirror')).not.toContainText('kind: list')
  } finally {
    await away(page, 'Errands11')
  }
})

test('the calendar jumps to a month and year, and its week starts on the day chosen (P5.24)', async ({ page }) => {
  try {
    await page.goto('/calendar?month=2026-10')
    await expect(page.getByLabel('Year', { exact: true })).toHaveValue('2026')
    // Year and month right after each other on a slow machine: the month keeps the year just picked.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
    await Promise.all([
      page.getByLabel('Year', { exact: true }).selectOption('2024'),
      page.getByLabel('Month', { exact: true }).selectOption('02'),
    ])
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await expect(page).toHaveURL(/month=2024-02/)
    await page.getByLabel('Week starts on').selectOption('sunday')
    // 1 February 2024 was a Thursday: from Sunday on it is the fifth box after the seven names.
    const boxes = page.locator('[data-testid="calendar-page"] .grid-cols-7 > *')
    await expect(boxes.nth(7 + 4)).toHaveAttribute('data-date', '2024-02-01')
  } finally {
    await page.request.put('/api/me/appearance', { data: { week_start: 'monday' }, headers: TAB })
  }
})

test('quick capture has a button, the zettel command is found by its name, the calendar leads to its subscription (P5.18)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/calendar')
  await page.getByRole('link', { name: 'Subscribe to the calendar' }).click()
  await expect(page.getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('calendar-feed')).toBeVisible()
  await page.getByRole('button', { name: 'Quick capture' }).click()
  await expect(page.getByRole('dialog', { name: 'Quick capture' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+p')
  await page.keyboard.type('zettel')
  await expect(page.getByRole('dialog', { name: 'Commands' }).getByRole('option').first()).toContainText('named by the time')
})

test('the reading view ticks a task off as the task list does, the next occurrence above it (P5.2)', async ({ page }) => {
  await space(page, 'Errands12', { List: '---\ntags: [x]\n---\n- [ ] First R2\n- [ ] Sweep R2 🔁 every week 📅 2031-05-06\n' })
  try {
    await page.goto('/note/Errands12/List.md')
    const box = page.locator('.nn-prose li', { hasText: 'Sweep R2' }).locator('input[type="checkbox"]')
    await expect(box).toBeEnabled()
    await box.click()
    await expect
      .poll(async () => (await (await page.request.get('/api/note?path=' + encodeURIComponent('Errands12/List.md'))).json()).content)
      .toMatch(/- \[ \] Sweep R2 🔁 every week 📅 2031-05-13\n- \[x\] Sweep R2 🔁 every week 📅 2031-05-06 ✅ \d{4}-\d{2}-\d{2}\n/)
    await expect(page.locator('.nn-prose li', { hasText: '2031-05-13' })).toBeVisible()
  } finally {
    await away(page, 'Errands12')
  }
})

test.describe('before the spaces have come', () => {
  // page.route sees nothing the service worker answers.
  test.use({ serviceWorkers: 'block' })
  test('a link to a day in the space\'s own pattern still opens the daily note (P5.22)', async ({ page }, testInfo) => {
    const name = `Errands10${testInfo.retry || ''}`
    await space(page, name, { Links: 'Plan for [[11.05.2031]].\n' })
    try {
      expect((await page.request.put(`/api/spaces/${name}/options`, { data: { daily_format: 'DD.MM.YYYY' }, headers: TAB })).status()).toBe(200)
      // The list of spaces comes late: the click is there first.
      await page.route('**/api/spaces', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500))
        await route.continue()
      })
      await page.goto(`/note/${name}/Links.md`)
      await page.locator('.nn-prose a', { hasText: '11.05.2031' }).click()
      await page.waitForURL(new RegExp(`/note/${name}/Daily/11\\.05\\.2031\\.md`), { timeout: 15_000 })
    } finally {
      await page.unroute('**/api/spaces')
      await away(page, name)
    }
  })
})
