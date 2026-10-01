/**
 * The bar over chosen words (review before 1.0.0, P3.10 and P3.11): its symbols are readable in both colour schemes,
 * and "Comment" is one of its buttons instead of a pill over the next line.
 */
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'writes a note of its own')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-selbar0' }

function contrast(a: number[], b: number[]): number {
  const lum = (rgb: number[]) => {
    const [r, g, bl] = rgb.map((c) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

for (const scheme of ['dark', 'light'] as const) {
  test(`the bar over chosen words is readable (${scheme}) and holds Comment`, async ({ page }) => {
    const made = await page.request.post('/api/notes', { data: { folder: 'Heath', title: `Bar ${scheme}`, content: 'Some chosen words here.\n\nAnother line below.\n' }, headers: TAB })
    expect(made.status()).toBe(201)
    const path = (await made.json()).path as string
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/note/' + path.split('/').map(encodeURIComponent).join('/'))
    // The app's own light theme (data-theme), set as its switch sets it.
    await page.evaluate((mode) => (mode === 'light' ? document.documentElement.setAttribute('data-theme', 'light') : document.documentElement.removeAttribute('data-theme')), scheme)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const words = page.locator('.ProseMirror p', { hasText: 'Some chosen words' })
    await words.dblclick()
    await page.keyboard.press('Shift+End')
    const bar = page.locator('.milkdown-toolbar')
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: 'Comment', exact: true })).toBeVisible()
    const colours = await bar.evaluate((element) => {
      const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      let background = getComputedStyle(element).backgroundColor
      for (let at: Element | null = element; at && /rgba\(0, 0, 0, 0\)|transparent/.test(background); at = at.parentElement) background = getComputedStyle(at).backgroundColor
      const icons = [...element.querySelectorAll('.toolbar-item:not(.active) svg')].map((svg) => parse(getComputedStyle(svg).fill))
      return { background: parse(background), icons }
    })
    expect(colours.icons.length).toBeGreaterThan(3)
    for (const icon of colours.icons) expect(contrast(icon, colours.background)).toBeGreaterThanOrEqual(4.5)
  })
}
