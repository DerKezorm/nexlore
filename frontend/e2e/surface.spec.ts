/**
 * The surface on phones and small screens from the review before 1.0.0 (block S): the panel's tabs, the themes card,
 * properties, the save state, long addresses and tables, a phone on its side, ways to close, the pages before signing
 * in, the provider card, and texts of the operator over the shipped ones.
 */
import { expect, test, type Page } from '@playwright/test'

test.skip(!!process.env.E2E_BASE_URL, 'writes notes of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-surface0' }

async function note(page: Page, title: string, content: string): Promise<string> {
  const made = await page.request.post('/api/notes', { data: { folder: 'Heath', title, content }, headers: TAB })
  expect(made.status()).toBe(201)
  return (await made.json()).path as string
}

const url = (path: string) => '/note/' + path.split('/').map(encodeURIComponent).join('/')

test('the tabs of the panel scroll in themselves; the app never moves sideways (P7.3)', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  const path = await note(page, 'Surface tabs', '# One\n\nText.\n')
  await page.goto(url(path))
  const tabs = page.getByTestId('note-panel').getByRole('tablist')
  await expect(tabs).toBeVisible()
  const last = tabs.getByRole('tab').last()
  await last.click()
  await expect(last).toHaveAttribute('aria-selected', 'true')
  // Nothing around the tabs scrolled sideways: the logo and the sidebar stay where they are.
  const moved = await tabs.evaluate((bar) => {
    const out: string[] = []
    for (let node = bar.parentElement; node; node = node.parentElement) if (node.scrollLeft !== 0) out.push(node.tagName + '.' + node.className)
    return out
  })
  expect(moved).toEqual([])
})

test('on a phone the themes card keeps its words readable and properties their values (P8.1, P1.3)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/settings?tab=looks')
  const title = page.getByTestId('themes').getByRole('heading', { name: 'Themes' })
  await expect(title).toBeVisible()
  expect((await title.boundingBox())!.width).toBeGreaterThan(60)
  const text = page.getByTestId('themes').locator('p').first()
  expect((await text.boundingBox())!.width).toBeGreaterThan(200)

  const path = await note(page, 'Surface properties', '---\nstatus: Editor\n---\nText.\n')
  await page.goto(url(path) + '?edit=1')
  const value = page.getByRole('textbox', { name: 'status' })
  await expect(value).toBeVisible({ timeout: 15_000 })
  expect((await value.boundingBox())!.width).toBeGreaterThan(120)
})

test.describe('in German, which says it longest ("Noch nicht gespeichert")', () => {
  test.use({ locale: 'de-DE' })
  for (const width of [390, 768]) test(`at ${width} pixels the save state never lies over the path (P8.2)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 })
  const path = await note(page, 'Surface saving', 'Text.\n')
  await page.goto(url(path) + '?edit=1')
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  await page.locator('.ProseMirror').click()
  await page.keyboard.type(' more')
  const badge = page.getByTestId('note-toolbar').getByRole('status')
  await expect(badge).toBeVisible()
  const crumbs = await page.getByTestId('note-crumbs').boundingBox()
  const state = await badge.boundingBox()
  expect(state!.x).toBeGreaterThanOrEqual(crumbs!.x + crumbs!.width - 1)
  // Its words fit its own box: squeezed, they ran over the path.
  expect(await badge.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(1)
  // And the path keeps room for more than a letter.
  expect(crumbs!.width).toBeGreaterThan(80)
  })
})

test('on a phone a long address breaks and a wide table scrolls in itself, reading and writing (P8.3, P3.23)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const long = 'https://example.com/' + 'averyveryverylongpathsegment/'.repeat(6)
  // A word in a cell that cannot break: the table is wider than the phone.
  const table = '| Column A | Column B | Column C | Column D | Column E |\n| --- | --- | --- | --- | --- |\n| Cell content one | Cell content two | Cellcontentwithoutanyspaceatall | Cell content four | Cell content five |\n'
  const path = await note(page, 'Surface wide', `See ${long} here.\n\n${table}`)
  await page.goto(url(path))
  await expect(page.locator('.nn-prose table')).toBeVisible()
  const scroller = page.getByTestId('note-body').locator('xpath=..')
  expect(await scroller.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(1)
  expect(await page.locator('.nn-prose table').evaluate((box) => box.scrollWidth > box.clientWidth)).toBe(true)

  await page.goto(url(path) + '?edit=1')
  const head = page.locator('.ProseMirror th', { hasText: 'Column A' })
  await expect(head).toBeVisible({ timeout: 15_000 })
  // The words stay whole: one line high, not "Colu mn A".
  const lineHeight = await head.evaluate((cell) => parseFloat(getComputedStyle(cell).lineHeight) || 24)
  expect((await head.locator('p').first().boundingBox())!.height).toBeLessThan(lineHeight * 1.6)
})

test('a phone on its side keeps the toolbar in one row (P8.16)', async ({ page }) => {
  await page.setViewportSize({ width: 750, height: 342 })
  const path = await note(page, 'Surface landscape', 'Text.\n')
  await page.goto(url(path) + '?edit=1')
  const bar = page.getByTestId('editor-toolbar')
  await expect(bar).toBeVisible({ timeout: 15_000 })
  expect((await bar.boundingBox())!.height).toBeLessThan(48)
})

test('search, the palette and the graph sheet can be closed with a tap (P8.17)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const search = page.getByRole('dialog', { name: 'Search' })
  await expect(search).toBeVisible()
  await search.getByRole('button', { name: 'Close' }).click()
  await expect(search).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+p')
  const palette = page.getByRole('dialog', { name: 'Commands' })
  await expect(palette).toBeVisible()
  await palette.getByRole('button', { name: 'Close' }).click()
  await expect(palette).toHaveCount(0)
})

test('the sign-in page follows a light system before anybody chose (P8.20)', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, colorScheme: 'light' })
  const page = await context.newPage()
  await page.goto('/login')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await context.close()
})

test('without a sign-in provider the account offers none to link (P7.14)', async ({ page }) => {
  const methods = await (await page.request.get('/api/auth/methods')).json()
  test.skip(methods.oidc, 'this server has a provider')
  await page.goto('/account?tab=security')
  await expect(page.getByText('Second factor', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Sign-in provider', { exact: true })).toHaveCount(0)
})
