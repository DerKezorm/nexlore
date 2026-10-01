/**
 * Working together from the review before 1.0.0 (block V): the own note open in another tab, comments of others
 * without a reload, who saved a version and why it cannot be brought back, @names that name nobody.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes notes of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-team00000' }

async function note(page: Page, title: string, content: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { folder: 'Heath', title, content }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).path as string
}

const url = (at: string) => '/note/' + at.split('/').map(encodeURIComponent).join('/')

test('the own note open for writing in another tab is said as such, not with the own name (P1.19)', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const at = await note(page, 'Team own tab', 'Text.\n')
  await page.goto(url(at) + '?edit=1')
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  const other = await context.newPage()
  await other.setViewportSize({ width: 1440, height: 900 })
  await other.goto(url(at))
  await expect(other.getByText('You are editing this note in another tab or window.', { exact: false })).toBeVisible({ timeout: 15_000 })
  await other.close()
})

test('a comment of another tab shows without a reload (P6.4)', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const at = await note(page, 'Team comments', 'The roses stand by the wall.\n')
  await page.goto(url(at))
  await expect(page.locator('.nn-prose')).toContainText('The roses stand')
  const made = await page.request.post('/api/comments', {
    data: { path: at, quote: 'roses', before: 'The ', after: ' stand', body: 'Prune them in March.' },
    headers: { 'X-Nexlore-Client': 'tab-e2e-teamother' },
  })
  expect(made.status()).toBe(201)
  const panel = page.getByTestId('note-panel')
  await panel.getByRole('tab', { name: /Comments/ }).click()
  await expect(panel.getByText('Prune them in March.')).toBeVisible({ timeout: 20_000 })
})

test('versions say who saved them, and why one cannot be brought back while editing (P6.17)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const at = await note(page, 'Team versions', 'One.\n')
  // From two tabs: saves of one tab within a few minutes are bundled into one version.
  for (const [index, text] of ['Two.\n', 'Three.\n'].entries()) {
    const current = await (await page.request.get('/api/note?path=' + encodeURIComponent(at))).json()
    const saved = await page.request.put('/api/note', {
      data: { path: at, content: text, base_hash: current.hash },
      headers: { 'X-Nexlore-Client': `tab-e2e-teamsave${index}` },
    })
    expect(saved.status()).toBe(200)
  }
  await page.goto(url(at) + '?edit=1')
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  const panel = page.getByTestId('note-panel')
  await panel.getByRole('tab', { name: 'Versions' }).click()
  const versions = panel.getByTestId('versions')
  await expect(versions).toContainText('tester')
  await expect(versions.getByTestId('versions-why')).toHaveText('While you edit, no version can be brought back.')
})

test('an @name that names nobody is not marked as a mention (P6.18)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const at = await note(page, 'Team mentions', 'The gate needs oil.\n')
  const made = await page.request.post('/api/comments', {
    data: { path: at, quote: 'gate', before: 'The ', after: ' needs', body: 'Ask @tester, not @nobodyhere.' },
    headers: TAB,
  })
  expect(made.status()).toBe(201)
  await page.goto(url(at))
  const panel = page.getByTestId('note-panel')
  await panel.getByRole('tab', { name: /Comments/ }).click()
  await expect(panel.getByText('@tester', { exact: true })).toHaveClass(/bg-accent-500/)
  await expect(panel.getByText(/@nobodyhere/)).not.toHaveClass(/bg-accent-500/)
})
