/**
 * What the character between a task's brackets means (Issue #14), through the interface: a space whose Tasks plugin
 * settings call [a] archived (cancelled), [r] to be reviewed (open) and [i] no task; the status filter of the task
 * overview; and the list in the space's options, which stands above the plugin.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const TAB = { 'X-Nexlore-Client': 'tab-e2e-statuses' }
const NOTE = '- [ ] Plain one S14\n- [r] Review the draft S14\n- [a] Old plan set aside S14\n- [i] Just a thought S14\n- [x] Finished one S14\n'

function settings(): string {
  const row = (symbol: string, name: string, type: string) => ({ symbol, name, nextStatusSymbol: 'x', availableAsCommand: true, type })
  return JSON.stringify({
    statusSettings: {
      coreStatuses: [row(' ', 'Todo', 'TODO'), row('x', 'Done', 'DONE')],
      customStatuses: [row('/', 'In Progress', 'IN_PROGRESS'), row('-', 'Cancelled', 'CANCELLED'), row('a', 'Archived', 'CANCELLED'),
        row('r', 'To be reviewed', 'TODO'), row('i', 'Idea', 'NON_TASK')],
    },
  })
}

/** A space of its own, named after all the others (nothing in the tree moves), with the plugin's settings in it. */
async function space(page: Page): Promise<string> {
  const name = `Zzstatus${Date.now() % 1_000_000}`
  await page.goto('/settings?tab=spaces')
  expect((await page.request.post('/api/spaces', { data: { name }, headers: TAB })).status()).toBe(201)
  expect((await page.request.post('/api/notes', { data: { folder: name, title: 'Marks', content: NOTE }, headers: TAB })).status()).toBe(201)
  const file = path.join(DATA, 'vault', name, '.obsidian', 'plugins', 'obsidian-tasks-plugin', 'data.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, settings())
  return name
}

async function away(page: Page, name: string): Promise<void> {
  await page.request.delete('/api/files?path=' + encodeURIComponent(name), { headers: TAB })
}

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

test('the plugin settings of a space say what its characters mean, and the filter picks one', async ({ page }) => {
  const name = await space(page)
  try {
    await page.goto('/tasks')
    await page.getByRole('combobox', { name: 'Space' }).selectOption(name)
    const rows = page.getByTestId('task-row')
    await expect(rows.filter({ hasText: 'Plain one S14' })).toBeVisible()
    await expect(rows.filter({ hasText: 'Review the draft S14' }).getByTestId('task-status')).toHaveText('To be reviewed')
    await expect(rows).toHaveCount(2)
    await expect(page.getByRole('button', { name: /^Open\s*2$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Cancelled\s*1$/ })).toBeVisible()
    const filter = page.getByRole('combobox', { name: 'Status' })
    await filter.selectOption('r')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Review the draft S14')
    // A cancelled character takes its chip along.
    await filter.selectOption('a')
    await expect(page.getByRole('button', { name: /^Cancelled/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Old plan set aside S14')
    await filter.selectOption('')
    await expect(rows).toHaveCount(1)
    await page.getByRole('button', { name: /^Open\s*2$/ }).click()
    await expect(rows).toHaveCount(2)
  } finally {
    await away(page, name)
  }
})

test('the list in the space options stands above the plugin', async ({ page }) => {
  const name = await space(page)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/settings?tab=spaces')
    await page.locator('#spaces li').filter({ hasText: name }).getByRole('button', { name: 'Options' }).click()
    const dialog = page.getByRole('dialog', { name: new RegExp(`Options of “${name}”`) })
    await expect(dialog.getByTestId('task-statuses-plugin')).toContainText('[a] Archived · cancelled')
    await dialog.getByRole('button', { name: 'Add a character' }).click()
    const row = dialog.getByTestId('task-status-row')
    await row.getByLabel('Character').fill('a')
    await row.getByLabel('Name').fill('Filed')
    await row.getByLabel('Counts as').selectOption('done')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByText(/Saved/)).toBeVisible()
    // The same character twice is said before saving.
    await dialog.getByRole('button', { name: 'Add a character' }).click()
    await dialog.getByTestId('task-status-row').nth(1).getByLabel('Character').fill('a')
    await expect(dialog.getByText('Each character only once.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove [a]' }).nth(1).click()
    await dialog.getByRole('button', { name: 'Close' }).first().click()

    await page.goto('/tasks')
    await page.getByRole('combobox', { name: 'Space' }).selectOption(name)
    await page.getByRole('button', { name: /^Done\s*2$/ }).click()
    const filed = page.getByTestId('task-row').filter({ hasText: 'Old plan set aside S14' })
    await expect(filed.getByTestId('task-status')).toHaveText('Filed')
    expect((await (await page.request.get(`/api/spaces/${name}/task-statuses`)).json()).own).toEqual([
      { mark: 'a', kind: 'done', name: 'Filed', source: 'own' },
    ])
  } finally {
    await away(page, name)
  }
})
