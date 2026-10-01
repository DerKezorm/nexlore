/**
 * The about page (block X2): version, licence, links, and the update check against a stand-in for GitHub
 * (e2e/fake-ai.mjs answers v9.0.0). The operator switches the daily check and asks now; the switch is set back.
 */
import { expect, test } from './fixtures'

test.skip(!!process.env.E2E_BASE_URL, 'changes a server setting')

const TAB = { 'X-Nexlore-Client': 'tab-e2e-about000' }

test('the about page names the version and says when a newer one is out', async ({ page }) => {
  try {
    await page.goto('/')
    await page.getByRole('banner').getByRole('button', { name: /^Account of / }).click()
    await page.getByRole('link', { name: 'About nexlore' }).click()
    await expect(page).toHaveURL(/\/about$/)
    const version = (await (await page.request.get('/api/about')).json()).version as string
    await expect(page.getByTestId('about-version')).toHaveText(version)
    await expect(page.getByRole('link', { name: 'AGPL-3.0' })).toHaveAttribute('href', 'https://www.gnu.org/licenses/agpl-3.0.html')
    // On by default: the stand-in says 9.0.0 is out, with the way to its release page.
    const state = page.getByTestId('about-update-state')
    await expect(state).toContainText('Version 9.0.0 is out')
    await expect(state.getByRole('link', { name: 'What is new' })).toHaveAttribute('href', /\/releases\/tag\/v9\.0\.0$/)

    // Off: nothing by itself, the button still asks.
    await page.getByRole('checkbox', { name: 'Check once a day' }).uncheck()
    await expect(state).toHaveText('The daily check is off.')
    await page.reload()
    await expect(page.getByRole('checkbox', { name: 'Check once a day' })).not.toBeChecked()
    await expect(state).toHaveText('The daily check is off.')
    await page.getByRole('button', { name: 'Check now' }).click()
    await expect(state).toContainText('Version 9.0.0 is out')

    // An older release out there: no hint, neither beside the version nor below.
    await page.request.post('http://127.0.0.1:8478/releases/latest', { data: { tag_name: 'v0.0.1' } })
    await page.getByRole('button', { name: 'Check now' }).click()
    await expect(state).toHaveText('This is the newest version.')
    await expect(page.getByText(/is out$/)).toHaveCount(0)
  } finally {
    await page.request.post('http://127.0.0.1:8478/releases/latest', { data: { tag_name: 'v9.0.0' } })
    await page.request.put('/api/about/updates', { data: { update_check: true }, headers: TAB })
  }
})
