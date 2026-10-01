/**
 * Access from the review before 1.0.0 (block U): contrast and edges, finger-sized controls, the jump to the content,
 * the map by keyboard, focus that comes back, tabs that answer the arrows, task boxes with names, headings, less
 * motion, repetitions in the interface's words.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes notes of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-access000' }

/** Contrast of two CSS colours as WCAG counts it. */
async function contrast(page: Page, fore: string, back: string): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const rgb = (value: string) => {
        const probe = document.createElement('i')
        probe.style.color = value
        document.body.appendChild(probe)
        const [r, g, bl] = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number)
        probe.remove()
        return [r, g, bl]
      }
      const lum = (value: string) => {
        const [r, g, b] = rgb(value).map((c) => {
          const s = c / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
      return (x + 0.05) / (y + 0.05)
    },
    [fore, back],
  )
}

test('small text, white on the accent and the edges of fields reach their contrast in both modes (P8.11, P8.12)', async ({ page }) => {
  await page.goto('/settings')
  // The account's own look first: set later, it would switch the mode back between two readings.
  await expect(page.getByRole('tablist', { name: 'Settings' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  for (const mode of ['dark', 'light'] as const) {
    // Mode and colours in one step, so nothing of the page comes in between.
    const tokens = await page.evaluate((m) => {
      if (m === 'light') document.documentElement.setAttribute('data-theme', 'light')
      else document.documentElement.removeAttribute('data-theme')
      const read = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
      return { ground: read('--color-ink-950'), card: read('--color-ink-850'), faint: read('--color-mist-600'), on: read('--color-on-accent'), accent: read('--color-accent-500'), edge: read('--color-edge') }
    }, mode)
    expect(await contrast(page, tokens.faint, tokens.ground)).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(page, tokens.faint, tokens.card)).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(page, tokens.on, tokens.accent)).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(page, tokens.edge, tokens.card)).toBeGreaterThanOrEqual(3)
  }
  // A field takes the edge colour, not the faint line of the cards.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.goto('/search')
  const edge = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-edge').trim())
  const field = page.getByTestId('search-page').locator('input[type="search"]').first()
  const border = await field.evaluate((input) => getComputedStyle(input).borderTopColor)
  const parent = await field.evaluate((input) => (input.className.includes('border-ink-7') ? 'framed' : 'plain'))
  if (parent === 'framed') expect(border).toBe(await page.evaluate((c) => { const i = document.createElement('i'); i.style.color = c; document.body.appendChild(i); const v = getComputedStyle(i).color; i.remove(); return v }, edge))
})

test.describe('with a finger', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 400, height: 800 } })
  test('the controls of the header are 44 pixels at least (P8.8)', async ({ page }) => {
    await page.goto('/tasks')
    const header = page.locator('header').first()
    await expect(header.getByRole('button').first()).toBeVisible()
    const small = await header.evaluate((box) =>
      [...box.querySelectorAll<HTMLElement>('button, a[href]')]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.height < 43.5 || rect.width < 43.5).length,
    )
    expect(small).toBe(0)
  })
})

test('Tab first reaches a jump to the content, which takes the focus there (P8.9)', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('tasks-page')).toBeVisible()
  await page.keyboard.press('Tab')
  const jump = page.getByRole('link', { name: 'Skip to the content' })
  await expect(jump).toBeFocused()
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN')
})

test('the map can be walked by Tab and a note opened with Enter; it has a heading (P8.10, P8.19)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Map', level: 1 })).toBeAttached()
  const canvas = page.getByTestId('graph-canvas')
  await expect(canvas).toBeVisible()
  const places = page.getByTestId('graph-places').getByRole('button')
  await expect(places.first()).toBeAttached({ timeout: 10_000 })
  await canvas.focus()
  await page.keyboard.press('Tab')
  await expect(places.first()).toBeFocused()
  await expect(places.first()).toBeVisible()
  // Into a small space: its notes come next, and Enter opens one.
  const year = page.getByTestId('graph-places').getByRole('button', { name: /^Year, / })
  await year.focus()
  await page.keyboard.press('Enter')
  const note = page.getByTestId('graph-places').locator('button[data-place="note"]').first()
  await expect(note).toBeAttached({ timeout: 10_000 })
  await note.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/note\//)
})

test('closing the new note dialog gives the focus back to its button (P8.13)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/note/Heath/Heather.md')
  const button = page.getByRole('button', { name: 'New note', exact: true })
  await expect(button).toBeEnabled()
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(button).toBeFocused()
})

test('tabs answer the arrows and only the chosen one stands in the Tab order (P8.14)', async ({ page }) => {
  await page.goto('/settings')
  const tabs = page.getByRole('tablist', { name: 'Settings' }).getByRole('tab')
  await tabs.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.nth(1)).toBeFocused()
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.first()).toHaveAttribute('tabindex', '-1')
})

test('a task box says which task it ticks off; today in the calendar is marked (P8.18)', async ({ page }) => {
  await page.request.post('/api/notes', { data: { folder: 'Heath', title: 'Access tasks', content: '- [ ] Polish the lamp U18\n' }, headers: TAB })
  await page.goto('/tasks')
  await page.getByRole('searchbox', { name: 'Search tasks' }).fill('Polish the lamp U18')
  await expect(page.getByRole('button', { name: 'Mark as done: Polish the lamp U18', exact: true })).toBeVisible()
  await page.goto('/calendar')
  await expect(page.locator('[aria-current="date"]')).toHaveCount(1)
})

test('with less motion asked for, the map does not fly (P8.21)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const canvas = page.getByTestId('graph-canvas')
  await expect(canvas).toHaveAttribute('data-zoom', /./)
  // The map at rest first: it fits itself once the spaces are there, and only then lists its places.
  await expect(page.getByTestId('graph-places').locator('li').first()).toBeAttached({ timeout: 15_000 })
  const before = await canvas.getAttribute('data-zoom')
  await canvas.focus()
  await page.keyboard.press('+')
  // At once, not over a fifth of a second.
  await page.waitForTimeout(60)
  expect(await canvas.getAttribute('data-zoom')).not.toBe(before)
  const now = await canvas.getAttribute('data-zoom')
  await page.waitForTimeout(300)
  expect(await canvas.getAttribute('data-zoom')).toBe(now)
})

test.describe('in German', () => {
  test.use({ locale: 'de-DE' })
  test('a repetition reads in the words of the interface (P8.22)', async ({ page }) => {
    await page.request.post('/api/notes', { data: { folder: 'Heath', title: 'Access repeat', content: '- [ ] Water U22 🔁 every 2 weeks on Monday 📅 2031-01-06\n' }, headers: TAB })
    await page.goto('/tasks')
    await page.getByRole('searchbox').first().fill('Water U22')
    await expect(page.getByTestId('task-row').filter({ hasText: 'Water U22' })).toContainText('alle 2 Wochen am Montag')
  })
})

test('no id stands twice on the page, in the editor neither (P8.19)', async ({ page }) => {
  await page.goto('/note/Zoo/Menu.md?edit=1')
  await expect(page.locator('.ProseMirror')).toBeVisible()
  // The slash menu and the selection bar are drawn already, hidden: both carry the code icon.
  const twice = await page.evaluate(() => {
    const seen = new Map<string, number>()
    for (const element of document.querySelectorAll('[id]')) seen.set(element.id, (seen.get(element.id) ?? 0) + 1)
    return [...seen].filter(([, count]) => count > 1).map(([id]) => id)
  })
  expect(twice).toEqual([])
})
