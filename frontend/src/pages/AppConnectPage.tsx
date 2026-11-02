/**
 * The iPhone app connects by address (`/app-connect?device=<name>`): it opens this page in the system's secure browser
 * window. The account signs in as always first (second factor, passkey, provider; the sign-in leads back here), then
 * confirms "Connect iPhone". The page makes a pairing like the profile does and hands its link
 * (`nexlore://connect?…`) to the app, which picks the key up at once. Nothing happens without the click.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { ApiError, appApi } from '../api/client'
import { AuthFrame } from '../components/AuthFrame'
import { deviceName } from '../lib/appPairing'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'

export function AppConnectPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params] = useSearchParams()
  const device = deviceName(params.get('device'))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const connect = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const made = await appApi.pair(window.location.origin)
      setDone(true)
      window.location.assign(made.link)
    } catch (error) {
      setProblem(errorText(error instanceof ApiError ? error.code : 'internal_error'))
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthFrame title={t('appConnect.doneTitle')}>
        <p className="text-sm text-mist-300" role="status">
          {t('appConnect.done')}
        </p>
      </AuthFrame>
    )
  }
  return (
    <AuthFrame title={t('appConnect.title')} text={t('appConnect.text', { account: me?.display_name || me?.name || '', device })}>
      <p className="mb-4 text-sm text-mist-400">{t('appConnect.rights')}</p>
      {problem && (
        <p role="alert" className="mb-3 text-sm text-bad-500">
          {problem}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void connect()}
        className="w-full rounded-full bg-accent-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
      >
        {t('appConnect.confirm')}
      </button>
      <a href="/" className="mt-4 block text-center text-xs text-mist-500 hover:text-mist-300">
        {t('appConnect.cancel')}
      </a>
    </AuthFrame>
  )
}
