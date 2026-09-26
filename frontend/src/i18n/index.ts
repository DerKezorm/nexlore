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
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './en.json'

type Texts = Record<string, unknown>

interface Shipped {
  /** The name in the language itself. */
  name: string
  load: () => Promise<{ default: Texts }>
}

export const SHIPPED = {
  en: { name: 'English', load: () => Promise.resolve({ default: en }) },
  de: { name: 'Deutsch', load: () => import('./de.json') },
} as const satisfies Record<string, Shipped>

export type LanguageOption = { code: string; name: string; added: boolean }

const FALLBACK = 'en'
const STORAGE_KEY = 'nexlore.language'
const CODE = /^[a-z]{2,3}(?:-(?:[A-Z]{2}|[A-Z][a-z]{3}))?$/

function isShipped(code: string): code is keyof typeof SHIPPED {
  return code in SHIPPED
}

type AddedEntry = { code: string; name: string; keys: number }

let addedList: Promise<AddedEntry[]> | null = null

/** The languages the operator added. An empty list when the server is not reachable: the app still works. */
export function addedLanguages(): Promise<AddedEntry[]> {
  addedList ??= fetch('/api/locales', { headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : []))
    .then((list: unknown) =>
      Array.isArray(list)
        ? list.filter((entry): entry is AddedEntry => !!entry && typeof entry.code === 'string' && CODE.test(entry.code))
        : [],
    )
    .catch(() => [])
  return addedList
}

/** Only for tests: forget what the server said. */
export function resetAddedLanguages(): void {
  addedList = null
}

async function fetchAdded(code: string): Promise<Texts | null> {
  if (!CODE.test(code)) return null
  try {
    const response = await fetch(`/api/locales/${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const texts: unknown = await response.json()
    return texts && typeof texts === 'object' && !Array.isArray(texts) ? (texts as Texts) : null
  } catch {
    return null
  }
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
  const added = await addedLanguages()
  if (added.some((entry) => entry.code === code)) {
    const texts = await fetchAdded(code)
    if (texts) {
      i18n.addResourceBundle(code, 'translation', texts, true, true)
      found = true
    }
  }
  return found
}

export async function languageOptions(): Promise<LanguageOption[]> {
  const options: LanguageOption[] = Object.entries(SHIPPED).map(([code, entry]) => ({ code, name: entry.name, added: false }))
  for (const entry of await addedLanguages()) {
    if (!isShipped(entry.code)) options.push({ code: entry.code, name: entry.name || entry.code, added: true })
  }
  return options
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
    interpolation: { escapeValue: false },
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

/** The English texts as a file to translate, with the `_meta` entry the server reads the name from. */
export function templateFile(): Blob {
  const template = { _meta: { name: 'Name of the language in itself, for example Español' }, ...en }
  return new Blob([JSON.stringify(template, null, 2) + '\n'], { type: 'application/json' })
}

export function downloadTemplate(): void {
  const url = URL.createObjectURL(templateFile())
  const link = document.createElement('a')
  link.href = url
  link.download = 'nexlore-language-template.json'
  link.click()
  URL.revokeObjectURL(url)
}

/** The locale for dates and numbers: the chosen language, as the browser understands it. */
export function locale(): string {
  return i18n.language || FALLBACK
}

export default i18n
