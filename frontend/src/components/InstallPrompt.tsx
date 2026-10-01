/**
 * nexlore as an app on the phone's home screen (M6). Once, on a narrow screen that is not the app already, a card
 * offers it: Android and Chrome give their own install dialog (`beforeinstallprompt`), Safari on iPhone and iPad has
 * none, so the card says how. "Don't ask again" is remembered per browser. The account menu offers it too.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useInstall } from '../lib/install'
import { Symbol } from './Symbol'

const DISMISSED_KEY = 'nexlore.install.dismissed'
const LATER_KEY = 'nexlore.install.later'

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1' || sessionStorage.getItem(LATER_KEY) === '1'
  } catch {
    return false
  }
}

export function InstallPrompt() {
  const { t } = useTranslation()
  const { can, install } = useInstall()
  const [hidden, setHidden] = useState(dismissed)
  const narrow = window.matchMedia?.('(max-width: 767px)').matches ?? false
  if (!can || hidden || !narrow) return null

  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Asked again next visit, nothing worse.
    }
  }

  // For now only: asked again in the next session.
  const later = () => {
    setHidden(true)
    try {
      sessionStorage.setItem(LATER_KEY, '1')
    } catch {
      // Then only until the page is loaded again.
    }
  }

  return (
    <div className="fixed inset-x-2 bottom-2 z-40 flex items-center gap-2 rounded-xl border border-accent-500/40 bg-ink-900 py-1.5 pr-1.5 pl-3 shadow-2xl" role="dialog" aria-labelledby="install-title" data-testid="install-prompt">
      <Symbol name="phone" className="h-4 w-4 shrink-0 text-accent-400" />
      <p id="install-title" className="min-w-0 flex-1 text-xs text-mist-200" title={can === 'ios' ? t('install.ios') : t('install.text')}>
        {can === 'ios' ? t('install.ios') : t('install.title')}
      </p>
      {can === 'prompt' && (
        <button type="button" onClick={() => void install().then(dismiss)} className="shrink-0 rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-on-accent">
          {t('install.install')}
        </button>
      )}
      <button type="button" onClick={dismiss} className="shrink-0 rounded-full px-2 py-1 text-xs text-mist-500 hover:bg-ink-850">
        {t('install.later')}
      </button>
      <button type="button" onClick={later} aria-label={t('install.notNow')} title={t('install.notNow')} className="shrink-0 rounded-full p-1.5 text-mist-500 hover:bg-ink-850 hover:text-mist-100">
        <Symbol name="close" className="h-4 w-4" />
      </button>
    </div>
  )
}
