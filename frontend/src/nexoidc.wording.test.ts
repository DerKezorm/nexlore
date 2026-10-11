/**
 * Pflichttest 35 (Bauplan 05): every text of the oidc module is in the app, in German and English, through the app's
 * own i18n. Copied once by `bauplaene/oidc/tools/sync.py` to `frontend/src/nexoidc.wording.test.ts`; then nexlore's
 * file.
 *
 * The module's own tests already check the wording files against Bauplan 04 word for word; this test checks that the
 * app really loads them (merged into its resources, `{{app}}` filled in) and that nothing in the app overrides them.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { oidcVariables, oidcWording, type OidcWording } from './vendor/nexoidc/oidc'
import de from './vendor/nexoidc/oidc.de.json'
import en from './vendor/nexoidc/oidc.en.json'
// nexlore's i18n after its set-up: the module's files merged into the resources, `{{app}}` set (src/i18n/index.ts).
import i18n, { changeLanguage, startI18n } from './i18n'

const APP_NAME = 'nexlore'
// nexlore has accounts: the sentences for the apps with one account (nexcrate, nexsift) are not merged in.
const SINGLE_ACCOUNT = false
// The slug the authentik button gives the app (the server's app_name); the app sets the same through oidcVariables.
const APP_SLUG = oidcVariables(APP_NAME).slug
// nexlore has invitations.
const INVITATIONS = true
const WORDING = { singleAccount: SINGLE_ACCOUNT, invitations: INVITATIONS }

beforeAll(async () => {
  // No server in a unit test: no languages added by an operator.
  vi.stubGlobal('fetch', async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  await startI18n()
})

type Tree = OidcWording

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name
    return typeof value === 'string' ? [[key, value] as [string, string]] : leaves(value, key)
  })
}

// Every placeholder of the texts but `{{app}}` and `{{slug}}`, which the app's i18n fills in itself.
const values = { name: 'N', count: 2, only: 1, status: 403, address: 'https://app.example.com' }

describe('the oidc texts', () => {
  for (const [language, tree] of [['de', de], ['en', en]] as const) {
    it(`are all in the app in ${language}, word for word, with the app's name`, async () => {
      await changeLanguage(language)
      expect(i18n.language).toBe(language)
      for (const [key, text] of leaves(oidcWording(tree, WORDING))) {
        // Plural forms are asked for without their suffix, with a count that picks them (since 1.0.9).
        const plural = /_(one|other)$/.exec(key)
        const given = plural ? { ...values, count: plural[1] === 'one' ? 1 : 2 } : values
        const asked = plural ? key.slice(0, plural.index) : key
        const expected = text.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
          name === 'app' ? APP_NAME : name === 'slug' ? APP_SLUG : String(given[name as keyof typeof given]),
        )
        expect(i18n.t(asked, given), key).toBe(expected)
      }
      // The sentences of the apps with one account are in the app only where it has one (`oidc.single` is never handed on).
      expect(i18n.exists('oidc.single.admin.passwordHint'), 'oidc.single').toBe(SINGLE_ACCOUNT)
    })
  }
})
