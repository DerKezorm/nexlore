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

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1'
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

  return (
    <div className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-accent-500/40 bg-ink-900 p-4 shadow-2xl" role="dialog" aria-labelledby="install-title" data-testid="install-prompt">
      <div className="flex gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-500/15 text-accent-400">
          <Symbol name="phone" className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p id="install-title" className="text-sm font-semibold text-mist-100">
            {t('install.title')}
          </p>
          <p className="mt-1 text-xs text-mist-400">{can === 'ios' ? t('install.ios') : t('install.text')}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={dismiss} className="rounded-full px-3 py-1.5 text-xs text-mist-400 hover:bg-ink-850">
          {t('install.later')}
        </button>
        {can === 'prompt' && (
          <button
            type="button"
            onClick={() => void install().then(dismiss)}
            className="rounded-full bg-accent-500 px-4 py-1.5 text-xs font-semibold text-on-accent"
          >
            {t('install.install')}
          </button>
        )}
      </div>
    </div>
  )
}
