/**
 * The editor through the interface, against the real backend: a changed word changes only its block on disk, a
 * note changed elsewhere is loaded quietly, properties write only their line, `[[` suggests notes, the Markdown
 * view, and the comparison with a conflict copy.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import fs from 'node:fs'
import path from 'node:path'

const DATA = process.env.NEXLORE_E2E_DATA ?? ''
const file = (rel: string) => path.join(DATA, 'vault', ...rel.split('/'))
const onDisk = (rel: string) => fs.readFileSync(file(rel), 'utf-8')

test.skip(!!process.env.E2E_BASE_URL, 'needs the prepared vault')

async function edit(page: Page, note: string) {
  await page.goto(`/note/${note}`)
  // exact: a space or note whose name contains "Edit" would match too.
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toBeVisible()
}

/** Selects a piece of text in the editor, as a person would with the mouse. */
async function select(page: Page, text: string) {
  await page.locator('.ProseMirror').evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(wanted)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + wanted.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`not found: ${wanted}`)
  }, text)
}

async function saved(page: Page) {
  await expect(page.getByRole('status')).toHaveText('Saved', { timeout: 10_000 })
}

test('a word changed in one paragraph changes only that paragraph on disk', async ({ page }) => {
  // The editor runs under the real Content Security Policy: no refused style, font or script.
  const problems: string[] = []
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
  page.on('pageerror', (error) => problems.push(error.message))
  const before = onDisk('Writing/Obsidian.md')
  await edit(page, 'Writing/Obsidian.md')
  // The wiki link shows as a link, its brackets hidden.
  await expect(page.locator('.ProseMirror .nx-wiki', { hasText: 'Garden' })).toBeVisible()
  await page.locator('.ProseMirror').focus()
  await select(page, 'First')
  await page.keyboard.type('Opening')
  await saved(page)
  expect(onDisk('Writing/Obsidian.md')).toBe(before.replace('First paragraph', 'Opening paragraph'))
  expect(problems).toEqual([])
})

test('a note changed elsewhere while open without own changes is loaded quietly', async ({ page }) => {
  await edit(page, 'Writing/Quiet.md')
  fs.writeFileSync(file('Writing/Quiet.md'), '# Quiet\n\nFrom outside.\n')
  await expect(page.locator('.ProseMirror')).toContainText('From outside.', { timeout: 12_000 })
  await expect(page.getByRole('status')).toHaveText('Updated from elsewhere')
  // Typing now saves against the new state: no conflict copy.
  await page.locator('.ProseMirror p', { hasText: 'From outside.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' And mine.')
  await saved(page)
  expect(onDisk('Writing/Quiet.md')).toBe('# Quiet\n\nFrom outside. And mine.\n')
  expect(fs.readdirSync(path.join(DATA, 'vault', 'Writing')).filter((name) => name.startsWith('Quiet (conflict'))).toEqual([])
})

test('a change elsewhere is never loaded over words still being typed: they end in a conflict copy', async ({ page }) => {
  await edit(page, 'Writing/Typing.md')
  await page.locator('.ProseMirror p', { hasText: 'Old text.' }).click()
  await page.keyboard.press('End')
  fs.writeFileSync(file('Writing/Typing.md'), '# Typing\n\nChanged elsewhere.\n')
  // Typing without a pause long enough to save, for longer than the page waits between two looks at the disk.
  const typed = ' ' + 'word '.repeat(14).trim()
  await page.keyboard.type(typed, { delay: 110 })
  const banner = page.getByRole('alert').filter({ hasText: 'changed elsewhere' })
  await expect(banner).toBeVisible({ timeout: 10_000 })
  expect(onDisk('Writing/Typing.md')).toBe('# Typing\n\nChanged elsewhere.\n')
  const copies = fs.readdirSync(path.join(DATA, 'vault', 'Writing')).filter((name) => name.startsWith('Typing (conflict'))
  expect(copies).toHaveLength(1)
  expect(onDisk(`Writing/${copies[0]}`)).toBe(`# Typing\n\nOld text.${typed}\n`)
})

test('starting to edit reads the note afresh, not what the page showed', async ({ page }) => {
  await page.goto('/note/Writing/Fresh.md')
  await expect(page.getByText('Before.')).toBeVisible()
  fs.writeFileSync(file('Writing/Fresh.md'), '# Fresh\n\nAfter.\n')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.ProseMirror')).toContainText('After.')
  await expect(page.locator('.ProseMirror')).not.toContainText('Before.')
})

test('a property changed in the table rewrites only its line', async ({ page }) => {
  await edit(page, 'Writing/Props.md')
  const properties = page.getByRole('region', { name: 'Properties' })
  await expect(properties.getByText('#one')).toBeVisible()
  const status = properties.getByRole('textbox', { name: 'status' })
  await status.fill('done')
  await saved(page)
  expect(onDisk('Writing/Props.md')).toBe('---\ntags: [one, two]\nstatus: done\n---\nBody of the note.\n')
})

test('a property name used twice is flagged and not written until it has a name of its own', async ({ page }) => {
  await edit(page, 'Writing/Twice.md')
  const properties = page.getByRole('region', { name: 'Properties' })
  await properties.getByRole('button', { name: /Add a property/ }).click()
  const name = properties.getByRole('textbox', { name: 'Name' }).last()
  await name.fill('status')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(properties.getByText('This name exists already')).toBeVisible()
  await properties.getByRole('textbox', { name: 'status' }).last().fill('other')
  // Given time to save: the first "status" keeps its value.
  await page.waitForTimeout(2_000)
  expect(onDisk('Writing/Twice.md')).toBe('---\nstatus: draft\n---\nBody.\n')
  await name.fill('owner')
  await expect(name).not.toHaveAttribute('aria-invalid')
  await saved(page)
  expect(onDisk('Writing/Twice.md')).toBe('---\nstatus: draft\nowner: other\n---\nBody.\n')
})

test('properties changed elsewhere are not overwritten by the next change in the table', async ({ page }) => {
  await edit(page, 'Writing/Outside props.md')
  const properties = page.getByRole('region', { name: 'Properties' })
  await properties.getByRole('textbox', { name: 'status' }).fill('review')
  await saved(page)
  fs.writeFileSync(file('Writing/Outside props.md'), '---\nstatus: review\nowner: team\n---\nBody.\n')
  await expect(page.getByRole('status')).toHaveText('Updated from elsewhere', { timeout: 12_000 })
  await expect(properties.getByRole('textbox', { name: 'owner' })).toHaveValue('team')
  await properties.getByRole('textbox', { name: 'status' }).fill('done')
  await saved(page)
  expect(onDisk('Writing/Outside props.md')).toBe('---\nstatus: done\nowner: team\n---\nBody.\n')
})

test('[[ suggests notes, and Enter writes the link', async ({ page }) => {
  await edit(page, 'Writing/Linking.md')
  await page.locator('.ProseMirror p', { hasText: 'Start.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' See [[Targ')
  const list = page.getByRole('listbox', { name: 'Notes to link' })
  await expect(list.getByRole('option', { name: /Target note/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(list).toBeHidden()
  await saved(page)
  expect(onDisk('Writing/Linking.md')).toBe('# Linking\n\nStart. See [[Target note]]\n')
})

test('the Markdown view edits the text itself', async ({ page }) => {
  await edit(page, 'Writing/Source.md')
  await page.getByLabel('More').click()
  // The note's menu (the toolbar has a button of the same name).
  await page.locator('details[open]').getByRole('button', { name: 'Markdown source' }).click()
  const source = page.getByRole('textbox', { name: 'Markdown source of the note' })
  await expect(source).toHaveValue('# Source\n\nPlain text.\n')
  await source.fill('# Source\n\nPlain **text**.\n')
  await saved(page)
  expect(onDisk('Writing/Source.md')).toBe('# Source\n\nPlain **text**.\n')
  // Back in the visual editor, the text is there as written.
  await page.getByLabel('More').click()
  await page.getByRole('button', { name: 'Visual editor' }).click()
  await expect(page.locator('.ProseMirror strong')).toHaveText('text')
})

test('the Markdown view stands on the page with the whole toolbar, writes the signs, and goes back with the switch', async ({ page }) => {
  await edit(page, 'Zyx/Source view.md')
  const bar = page.getByTestId('editor-toolbar')
  await bar.getByRole('button', { name: 'Markdown', exact: true }).click()
  const source = page.getByRole('textbox', { name: 'Markdown source of the note' })
  await expect(source).toHaveValue('# Source view\n\nOne line.\n')
  await expect(bar.getByRole('button', { name: 'Markdown', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // No frame of its own: it grows with the text instead of scrolling inside.
  expect(await source.evaluate((field) => getComputedStyle(field).borderTopWidth)).toBe('0px')
  await source.fill('# Source view\n\n' + Array.from({ length: 60 }, (_, n) => 'Line ' + n).join('\n') + '\n')
  expect(await source.evaluate((field) => field.scrollHeight <= field.clientHeight + 1)).toBe(true)
  await source.fill('# Source view\n\nOne line.\n')
  // The toolbar writes the Markdown signs around the words chosen; undo takes them back.
  await source.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(15, 18))
  await bar.getByRole('button', { name: 'Bold' }).click()
  await expect(source).toHaveValue('# Source view\n\n**One** line.\n')
  await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
  await bar.getByRole('button', { name: 'Undo' }).click()
  await expect(source).toHaveValue('# Source view\n\nOne line.\n')
  await bar.getByRole('button', { name: 'Bullet list' }).click()
  await expect(source).toHaveValue('# Source view\n\n- One line.\n')
  await saved(page)
  expect(onDisk('Zyx/Source view.md')).toBe('# Source view\n\n- One line.\n')
  // Back with one click, the list is a list.
  await bar.getByRole('button', { name: 'Visual', exact: true }).click()
  await expect(page.locator('.ProseMirror li')).toHaveText('One line.')
})

test('an account that writes Markdown opens its notes in the Markdown view', async ({ page }) => {
  await page.goto('/settings?tab=general')
  const card = page.locator('#editor')
  await card.getByRole('radio', { name: /^Markdown/ }).check()
  await expect.poll(async () => (await (await page.request.get('/api/auth/me')).json()).appearance.editor).toBe('source')
  try {
    // A note of its own: the test before keeps the lock of Writing/Source.md for a moment, Edit would wait for it.
    await page.goto('/note/Zyx/Opens%20as%20text.md')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown source of the note' })).toBeVisible()
    await expect(page.locator('.ProseMirror')).toHaveCount(0)
  } finally {
    await page.request.put('/api/me/appearance', { headers: { 'X-Nexlore-Client': 'tab-e2e-editorview' }, data: { editor: 'visual' } })
  }
})

test('a conflict copy is compared, a part taken over, and the copy goes to the trash', async ({ page }) => {
  await edit(page, 'Writing/Compare.md')
  fs.writeFileSync(file('Writing/Compare.md'), '# Compare\n\nKept line.\n\nChanged in Obsidian.\n')
  // Typed before the page noticed: the save cannot overwrite, the words go into a copy.
  await page.locator('.ProseMirror p', { hasText: 'Old ending.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Mine too.')
  const banner = page.getByRole('alert').filter({ hasText: 'changed elsewhere' })
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Compare', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare the note with the conflict copy' })
  await expect(dialog).toContainText('1 difference')
  await dialog.getByRole('radio', { name: "Take the copy's" }).click()
  await dialog.getByRole('button', { name: 'Save and remove the copy' }).click()
  await expect(dialog).toBeHidden()
  expect(onDisk('Writing/Compare.md')).toBe('# Compare\n\nKept line.\n\nOld ending. Mine too.\n')
  await expect.poll(() => fs.readdirSync(path.join(DATA, 'vault', 'Writing')).filter((name) => name.startsWith('Compare (conflict'))).toEqual([])
  await page.goto('/files')
  await expect(page.getByRole('listitem').filter({ hasText: /Writing\/Compare \(conflict/ })).toBeVisible()
})

test('the properties of a note without any fold shut and open again', async ({ page }) => {
  await edit(page, 'Heath/Counted.md')
  const properties = page.getByRole('region', { name: 'Properties' })
  const toggle = properties.getByRole('button', { name: /^.?\s*Properties/ })
  await expect(properties.getByRole('button', { name: /Add a property/ })).toBeVisible()
  await toggle.click()
  // Folded, the row stays: its arrow is the way back (it vanished once, with nothing to open it again).
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(properties.getByRole('button', { name: /Add a property/ })).toHaveCount(0)
  await toggle.click()
  await expect(properties.getByRole('button', { name: /Add a property/ })).toBeVisible()
})
