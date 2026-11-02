/**
 * dist-editor/ from a file:// URL, as the iPhone app opens it: the bundle loads without a server, says `ready`, shows
 * a note with everything the editor draws (formula, diagram, picture, properties, fonts), asks the app for files and
 * suggestions, and reaches for nothing but its own files.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = path.resolve('dist-editor', 'editor-app.html')

type Message = { type: string; [key: string]: unknown }

/** A red dot, the picture the stand-in app hands out. */
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const NOTE = [
  '---',
  'tags: [garten]',
  'status: entwurf',
  '---',
  '# Beet',
  '',
  'Siehe [[Kompost]] und #pflanzen/tomate.',
  '',
  '![Foto](Bilder/Beet%201.png)',
  '',
  '- [ ] Gießen',
  '',
  '> [!tip] Hinweis',
  '> Morgens.',
  '',
  '| Pflanze | Tage |',
  '| --- | --- |',
  '| Tomate | 60 |',
  '',
  '$$',
  'e^{i\\pi}+1=0',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  '  Saat --> Ernte',
  '```',
  '',
].join('\n')

async function open(page: Page): Promise<{ requests: string[]; problems: string[] }> {
  const requests: string[] = []
  const problems: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  await page.addInitScript(() => {
    const seen: unknown[] = []
    ;(window as unknown as { seen: unknown[] }).seen = seen
    ;(window as unknown as { webkit: unknown }).webkit = {
      messageHandlers: { nexlore: { postMessage: (message: unknown) => seen.push(JSON.parse(JSON.stringify(message))) } },
    }
  })
  await page.goto(pathToFileURL(entry).href)
  return { requests, problems }
}

const messages = (page: Page) => page.evaluate(() => (window as unknown as { seen: Message[] }).seen)

async function waitFor(page: Page, type: string, more: (message: Message) => boolean = () => true): Promise<Message> {
  let found: Message | undefined
  await expect.poll(async () => (found = (await messages(page)).find((message) => message.type === type && more(message))) !== undefined, { timeout: 30_000 }).toBe(true)
  return found!
}

test.beforeAll(() => {
  if (!fs.existsSync(entry)) throw new Error('dist-editor is missing: node scripts/editor-app-pack.mjs')
})

test('opens from a file:// URL, shows a whole note and asks the app for its files', async ({ page }, info) => {
  const { requests, problems } = await open(page)
  const ready = await waitFor(page, 'ready')
  const manifest = JSON.parse(fs.readFileSync(path.resolve('dist-editor', 'manifest.json'), 'utf8'))
  expect(ready.version).toBe(manifest.version)
  const readyAt = await page.evaluate(() => performance.now())

  await page.evaluate((text) => (window as unknown as { nexloreEditor: { load: (o: unknown) => void } }).nexloreEditor.load({ text, theme: { mode: 'light', accent: '#0f766e' }, fontSize: 17 }), NOTE)
  const asset = await waitFor(page, 'asset')
  expect(asset.path).toBe('Bilder/Beet 1.png')
  await waitFor(page, 'state')
  const shownAt = await page.evaluate(() => performance.now())
  await page.evaluate(([id, url]) => (window as unknown as { nexloreEditor: { answer: (i: unknown, p: unknown) => void } }).nexloreEditor.answer(id, { url }), [asset.id, DOT])

  await expect(page.locator('.ProseMirror h1')).toHaveText('Beet')
  await expect(page.locator('.ProseMirror img[data-nx-src="Bilder/Beet%201.png"]')).toHaveAttribute('src', DOT)
  await expect(page.locator('.nx-properties')).toContainText('#garten')
  await expect.poll(() => page.locator('.nx-properties input').evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value))).toContain('entwurf')
  await expect(page.locator('.nx-wiki')).toContainText('Kompost')
  await expect(page.locator('.nx-tag')).toContainText('#pflanzen/tomate')
  await expect(page.locator('.nn-math-preview[data-state="shown"] .katex')).toBeVisible()
  await expect(page.locator('.nn-mermaid-preview[data-state="shown"] svg')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  // The fonts come from the bundle: Inter for the text, KaTeX's own for the formula.
  expect(await page.evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check('16px "Inter Variable"') && document.fonts.check('16px KaTeX_Main')
  })).toBe(true)

  // Typing: the whole note, front matter included, goes to the app.
  await page.locator('.ProseMirror h1').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' im Sommer')
  // Gathered while typing: the last one has it all.
  const change = await waitFor(page, 'change', (message) => String(message.text).includes('im Sommer'))
  expect(change.text).toBe(NOTE.replace('# Beet', '# Beet im Sommer'))

  // Only its own files, nothing from a server.
  const elsewhere = requests.filter((url) => !/^(file|data|blob):/.test(url))
  expect(elsewhere).toEqual([])
  expect(problems).toEqual([])

  const assets = fs.readdirSync(path.resolve('dist-editor', 'assets'))
  const bytes = (name: string) => fs.statSync(path.resolve('dist-editor', 'assets', name)).size
  const script = assets.filter((name) => name.endsWith('.js')).reduce((sum, name) => sum + bytes(name), 0)
  info.annotations.push({ type: 'measure', description: `ready after ${Math.round(readyAt)} ms, note shown ${Math.round(shownAt - readyAt)} ms later, script ${(script / 1024 / 1024).toFixed(2)} MB` })
  console.log(`[${info.project.name}] ready after ${Math.round(readyAt)} ms, note shown ${Math.round(shownAt - readyAt)} ms later, script ${(script / 1024 / 1024).toFixed(2)} MB`)
})

test('the slash menu offers no files: the app uploads nothing through the editor', async ({ page }) => {
  await open(page)
  await waitFor(page, 'ready')
  await page.evaluate(() => (window as unknown as { nexloreEditor: { load: (o: unknown) => void } }).nexloreEditor.load({ text: 'Text.\n' }))
  await waitFor(page, 'state')
  await page.locator('.ProseMirror p').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const menu = page.locator('.milkdown-slash-menu')
  await expect(menu.getByText('Überschrift 4', { exact: true })).toBeVisible()
  await expect(menu.getByText('Hinweiskasten', { exact: true })).toBeVisible()
  await expect(menu.getByText('Bild', { exact: true })).toHaveCount(0)
  await expect(menu.getByText('Bild oder Datei', { exact: true })).toHaveCount(0)
})
