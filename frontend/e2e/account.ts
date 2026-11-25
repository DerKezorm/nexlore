/**
 * The way to the own account, as in nexnotes: there is no account menu any more. At the foot of every sidebar (in
 * the header on a phone) the own picture and name lead to the settings, and signing out is a card of the profile.
 */
import { type Page } from '@playwright/test'

/** The link to the settings with the own picture: by the name it shows, or the one in sight. */
export function accountLink(page: Page, name?: string) {
  return name ? page.getByRole('link', { name: `${name} · Settings` }) : page.getByTestId('settings-link').filter({ visible: true }).first()
}

/** Signs out the way a person does: to the settings, and "Sign out" in the profile. */
export async function signOut(page: Page) {
  await accountLink(page).click()
  await page.getByTestId('sign-out').click()
}
