/**
 * Backups in the settings, laid out as in nexcanvas: a backup is carried away only against the operator's password
 * once more (a wrong one gives nothing), and a downloaded one goes up again and joins the list, to be checked there.
 */
import { expect, test } from './fixtures'
import fs from 'node:fs'

import { OPERATOR } from './global-setup'

test.skip(!!process.env.E2E_BASE_URL, 'makes a backup; not against a running instance')

test('a backup is downloaded only with the password once more, and uploaded again it joins the list', async ({ page }) => {
  await page.goto('/settings?tab=server&sub=backups')
  const card = page.locator('#backups')
  const rows = card.locator('li')
  await card.getByRole('button', { name: 'Back up now' }).click()
  // Late in a full run the vault holds some 750 files; making the backup took 7 to 8 s once (05.10.2026).
  await expect(card.getByText('Backup made.')).toBeVisible({ timeout: 30_000 })
  const row = rows.filter({ hasText: 'by hand' }).first()
  await expect(row).toBeVisible()

  // Download: a window of its own asks for the password; a wrong one gives nothing.
  await row.getByRole('button', { name: 'Download' }).click()
  const dialog = page.getByRole('dialog', { name: 'Download this backup?' })
  await expect(dialog.getByText('It is not encrypted.')).toBeVisible()
  await dialog.getByLabel('Your password').fill('not the password at all')
  await dialog.getByRole('button', { name: 'Download' }).click()
  await expect(dialog.getByText('The password is wrong.')).toBeVisible()
  await dialog.getByLabel('Your password').fill(OPERATOR.password)
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()])
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const saved = await download.path()
  expect(fs.readFileSync(saved).subarray(0, 2).toString()).toBe('PK')
  await expect(dialog).toBeHidden()

  // Upload: the same archive comes back in, against the password, and is listed as uploaded.
  await card.getByTestId('backup-upload').setInputFiles({ name: 'moved.zip', mimeType: 'application/zip', buffer: fs.readFileSync(saved) })
  const upload = page.getByRole('dialog', { name: 'Upload a backup?' })
  await upload.getByLabel('Your password').fill(OPERATOR.password)
  await upload.getByRole('button', { name: 'Upload' }).click()
  await expect(card.getByText('Uploaded. It is in the list now')).toBeVisible()
  const uploaded = rows.filter({ hasText: 'uploaded' }).first()
  await expect(uploaded).toBeVisible()
  await uploaded.getByRole('button', { name: 'Check' }).click()
  await expect(card.getByText('The archive is complete and readable.')).toBeVisible()
})
