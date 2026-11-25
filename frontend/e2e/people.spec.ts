/**
 * Display names (block X1): set in the own profile, shown in the account menu, on comments and in the @ list, with the
 * name one signs in with beside it where that matters.
 */
import { accountLink } from './account'
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'changes the account')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-people00' }

test('a display name set in the profile shows at the foot of the sidebar, on comments and in the @ list', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  try {
    await page.goto('/account')
    // The profile of the shared account module: one "Save" for display name, username and address.
    const field = page.getByLabel('Display name')
    await field.fill('Tess Ter')
    await page.getByTestId('profile-save').click()
    await expect(page.getByText('Profile saved.')).toBeVisible()
    // The way to the settings shows it; the name to sign in with stays in the profile.
    await expect(accountLink(page, 'Tess Ter')).toBeVisible()
    await expect(page.getByTestId('settings-nav')).toContainText('Tess Ter')

    // A comment written as tester carries the display name.
    const made = await page.request.post('/api/notes', {
      data: { folder: 'Heath', title: `People ${testInfo.retry}${testInfo.repeatEachIndex}`, content: 'The fern needs water.\n' },
      headers: TAB,
    })
    const path = (await made.json()).path as string
    expect((await page.request.post('/api/comments', { data: { path, quote: 'fern', before: 'The ', after: ' needs', body: 'Twice a week.' }, headers: TAB })).status()).toBe(201)
    await page.goto('/note/' + path.split('/').map(encodeURIComponent).join('/'))
    const panel = page.getByTestId('note-panel')
    await panel.getByRole('tab', { name: /Comments/ }).click()
    const author = panel.locator('[data-person="tester"]').first()
    await expect(author).toHaveText('Tess Ter')

    // Changed again while the app stays open: the comment shows the new name without loading the page again.
    await accountLink(page, 'Tess Ter').click()
    await page.getByLabel('Display name').fill('Tessa Ter')
    await page.getByTestId('profile-save').click()
    await expect(page.getByText('Profile saved.')).toBeVisible()
    await page.goBack()
    await panel.getByRole('tab', { name: /Comments/ }).click()
    await expect(author).toHaveText('Tessa Ter')
    await expect(author).toHaveAttribute('title', '@tester')
    // The @ list finds the person by the display name, and says the name that goes into the text.
    await panel.getByRole('button', { name: 'Reply', exact: true }).click()
    await panel.getByRole('textbox', { name: 'Reply' }).fill('@te')
    await expect(panel.getByRole('option', { name: 'Tessa Ter @tester' })).toBeVisible()
  } finally {
    await page.request.put('/api/me/profile', { data: { display_name: '' }, headers: TAB })
  }
})
