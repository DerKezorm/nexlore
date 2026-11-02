/**
 * The editor's words for the app: English and German as they ship with nexlore, in the language of the phone.
 * Nothing is fetched; the operator's added languages live on a server the editor never asks.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { en, SHIPPED } from '../i18n'

export async function startEditorI18n(language: string): Promise<void> {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: { en: { translation: en } },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      returnNull: false,
    })
  }
  const code = language.toLowerCase().split(/[-_]/)[0] === 'de' ? 'de' : 'en'
  if (code === 'de' && !i18n.hasResourceBundle('de', 'translation')) {
    i18n.addResourceBundle('de', 'translation', (await SHIPPED.de.load()).default)
  }
  await i18n.changeLanguage(code)
  document.documentElement.lang = code
}
