/**
 * Languages. English and German ship with the app; the operator can add more as JSON files in `data/locales`,
 * which the server offers under `/api/locales`.
 *
 * English is always loaded and is the fallback: an added language may be incomplete, and whatever it leaves out
 * appears in English instead of as a raw key. For the two shipped languages `complete.test.ts` makes sure they have
 * exactly the same keys, so the fallback never shows there.
 *
 * An added file for `en` or `de` is laid over the shipped texts, so a wording can be changed without a release.
 *
 * Texts are rendered as text by React. No translation is ever put into the page as HTML, because an added file
 * comes from outside the code.
 *
 * The texts of sign-in through providers (`oidc.…`) come with the shared module `vendor/nexoidc`, the same words in
 * every nex app; they are merged in here, `{{app}}` says "nexlore". So are those of accounts (`account.…`, the shared
 * module `vendor/nexkonten`, whose namespace nexlore leaves alone: its own account texts are under `me.…`) and of
 * system mail (`mail.…`, `vendor/nexpost`).
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { kontenVariables } from '../vendor/nexkonten/konten'
import kontenEn from '../vendor/nexkonten/konten.en.json'
import { postVariables } from '../vendor/nexpost/post'
import postEn from '../vendor/nexpost/post.en.json'
import oidcEn from '../vendor/nexoidc/oidc.en.json'
import { oidcVariables, oidcWording } from '../vendor/nexoidc/oidc'
import ownEn from './en.json'
import { ownLanguages, type LanguageOption } from '../vendor/nexsprachen/languages'

/** nexlore's own English texts with the shared texts of sign-in, accounts and system mail. */
export const en: Texts = { ...ownEn, ...oidcWording(oidcEn, { singleAccount: false, invitations: true }), ...kontenEn, ...postEn }
/** What `{{app}}` stands for in the shared texts. */
export const APP_NAME = 'nexlore'

async function german(): Promise<{ default: Texts }> {
  const [own, oidc, konten, post] = await Promise.all([
    import('./de.json'),
    import('../vendor/nexoidc/oidc.de.json'),
    import('../vendor/nexkonten/konten.de.json'),
    import('../vendor/nexpost/post.de.json'),
  ])
  return {
    default: {
      ...own.default,
      ...oidcWording(oidc.default, { singleAccount: false, invitations: true }),
      ...konten.default,
      ...post.default,
    },
  }
}

type Texts = Record<string, unknown>

interface Shipped {
  /** The name in the language itself. */
  name: string
  load: () => Promise<{ default: Texts }>
}

export const SHIPPED = {
  en: { name: 'English', load: () => Promise.resolve({ default: en }) },
  de: { name: 'Deutsch', load: german },
} as const satisfies Record<string, Shipped>

export type { LanguageOption } from '../vendor/nexsprachen/languages'
export { byName } from '../vendor/nexsprachen/languages'

const FALLBACK = 'en'
const STORAGE_KEY = 'nexlore.language'
const CODE = /^[a-z]{2,3}(?:-(?:[A-Z]{2}|[A-Z][a-z]{3}))?$/

function isShipped(code: string): code is keyof typeof SHIPPED {
  return code in SHIPPED
}

/** The operator's own languages through the shared module sprachen 1.0.0 (`/api/locales`, as before). */
export const own = ownLanguages({ base: '/api/locales' })
/** The languages nexlore ships, each named in itself. */
export const BUILT_IN = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
] as const

/** Forget what the server said (after the card added or removed a language; and for tests). */
export function resetAddedLanguages(): void {
  own.forget()
}

/** Shipped texts first, the operator's file on top. False when there is nothing for this code at all. */
async function loadTexts(code: string): Promise<boolean> {
  let found = false
  if (isShipped(code)) {
    if (!i18n.hasResourceBundle(code, 'translation')) {
      const { default: texts } = await SHIPPED[code].load()
      i18n.addResourceBundle(code, 'translation', texts)
    }
    found = true
  }
  if (CODE.test(code) && (await own.knows(code, []))) {
    const texts = await own.texts(code)
    if (texts) {
      i18n.addResourceBundle(code, 'translation', texts, true, true)
      found = true
    }
  }
  return found
}

/** Deutsch, English and every added one in its place among them by name, never simply at the end. */
export function languageOptions(): Promise<LanguageOption[]> {
  return own.options(BUILT_IN)
}

function storedLanguage(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored && CODE.test(stored) ? stored : null
  } catch {
    return null
  }
}

/** The first browser language nexlore ships (only the language part counts: `de-AT` is `de`). */
function browserLanguage(): string {
  for (const wanted of navigator.languages ?? [navigator.language]) {
    const primary = wanted.toLowerCase().split(/[-_]/)[0]
    if (isShipped(primary)) return primary
  }
  return FALLBACK
}

export async function startI18n(): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en } },
    lng: FALLBACK,
    fallbackLng: FALLBACK,
    interpolation: {
      escapeValue: false,
      defaultVariables: { ...oidcVariables(APP_NAME), ...postVariables(APP_NAME), ...kontenVariables(APP_NAME) },
    },
    returnNull: false,
  })
  const wanted = storedLanguage() ?? browserLanguage()
  const language = (await loadTexts(wanted)) ? wanted : FALLBACK
  if (language === FALLBACK) await loadTexts(FALLBACK)
  await i18n.changeLanguage(language)
  document.documentElement.lang = language
}

export async function changeLanguage(code: string): Promise<void> {
  if (!(await loadTexts(code))) return
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    // Then the choice only holds until the next reload.
  }
  document.documentElement.lang = code
  await i18n.changeLanguage(code)
}

/** The locale for dates and numbers: the chosen language, as the browser understands it. */
export function locale(): string {
  return i18n.language || FALLBACK
}

export default i18n
