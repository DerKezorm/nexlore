/**
 * A backup can be carried away from the settings, against the operator's password once more; a wrong one gives
 * nothing.
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'

import { OPERATOR } from './global-setup'

test.skip(!!process.env.E2E_BASE_URL, 'makes a backup; not against a running instance')

test('a backup is downloaded only with the password once more', async ({ page }) => {
  await page.goto('/settings')
  const card = page.locator('#backups')
  await card.getByLabel('Note for this backup').fill('to carry away')
  await card.getByRole('button', { name: 'Back up now' }).click()
  const row = card.locator('li', { hasText: 'to carry away' })
  await expect(row).toBeVisible()

  await row.getByRole('button', { name: 'Download' }).click()
  await expect(row.getByText('The archive is not encrypted')).toBeVisible()
  await row.getByLabel('Your password').fill('not the password at all')
  await row.getByRole('button', { name: 'Download' }).last().click()
  await expect(card.getByText('The password is wrong.')).toBeVisible()

  await row.getByLabel('Your password').fill(OPERATOR.password)
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Download' }).last().click()])
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const saved = await download.path()
  expect(fs.readFileSync(saved).subarray(0, 2).toString()).toBe('PK')
  // Done: the password field is gone again.
  await expect(row.getByLabel('Your password')).toHaveCount(0)
})
