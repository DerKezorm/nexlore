/**
 * Small things of everyday use from the review before 1.0.0 (block R): cancelled tasks, long task lists, repetitions
 * nexlore cannot read, a daily note without its template, links to notes and days not written yet, the task list in
 * the reading view, and what a view says when it cannot do something. Each test works in a space of its own and takes
 * it away again: the account is shared with the other tests.
 */
import { expect, test, type Page } from '@playwright/test'

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
