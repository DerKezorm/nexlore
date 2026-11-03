/**
 * The own iPhones on the account page, beside the signed-in browsers: the paired devices with when they were last seen
 * and a way to disconnect each, and "Connect the iPhone app", which shows a QR code and a short code for ten minutes
 * (`/api/app-pairing`). The page asks every two seconds whether the app picked the key up, and says so when it did.
 *
 * The QR code is drawn by the server (segno) and carries the address, the pairing and its secret; the secret is shown
 * nowhere else and forgotten when the card closes. A pairing closed before the app came is withdrawn.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, appApi, type AppDevice, type AppPairing, type AppPairingState } from '../api/client'
import { minutesLeft } from '../lib/appPairing'
import { errorText } from '../lib/errors'
import { formatDate } from '../lib/markdown'
import { Symbol } from './Symbol'

/** How often the open card asks whether the app has come. */
export const POLL_MS = 2000

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

/** Where this browser sees nexlore; the server takes the public address instead when the operator set one. */
function here(): string {
  return window.location.origin
}

export function AppDevices() {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<AppDevice[] | null>(null)
  const [pairing, setPairing] = useState<AppPairing | null>(null)
  const [state, setState] = useState<AppPairingState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const open = useRef<string | null>(null)

  const load = useCallback(() => appApi.devices().then(setDevices, () => setDevices([])), [])
  useEffect(() => {
    void load()
  }, [load])

  // While a pairing waits: ask whether the app came, and count the minutes down.
  useEffect(() => {
    if (!pairing || state?.state === 'connected' || state?.state === 'expired') return
    const timer = window.setInterval(() => {
      setNow(Date.now())
      appApi.state(pairing.id).then(
        (found) => {
          setState(found)
          if (found.state === 'connected') {
            open.current = null
            void load()
          }
        },
        () => undefined,
      )
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pairing, state?.state, load])

  // A pairing still waiting when the page goes is withdrawn: nobody is there to show its code any more.
  useEffect(
    () => () => {
      if (open.current) void appApi.withdraw(open.current).catch(() => undefined)
    },
    [],
  )

  const start = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const made = await appApi.pair(here())
      open.current = made.id
      setPairing(made)
      setState({ state: 'waiting', device: '' })
      setNow(Date.now())
    } catch (error) {
      setProblem(errorText(code(error)))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (open.current) void appApi.withdraw(open.current).catch(() => undefined)
    open.current = null
    setPairing(null)
    setState(null)
  }

  const disconnect = async (device: AppDevice) => {
    setBusy(true)
    setProblem(null)
    try {
      await appApi.disconnect(device.id)
      await load()
    } catch (error) {
      setProblem(errorText(code(error)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="app-devices" className="rounded-2xl border border-ink-700 bg-ink-900 p-5">
      <h2 className="mb-4 flex items-center gap-2 font-semibold">
        <Symbol name="phone" className="h-4 w-4 text-accent-400" /> {t('account.app.title')}
      </h2>
      <p className="mb-3 text-sm text-mist-400">{t('account.app.text')}</p>
      {problem && (
        <p role="alert" className="mb-3 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
          {problem}
        </p>
      )}
      {devices && devices.length > 0 && (
        <ul className="mb-3 divide-y divide-ink-800 rounded-xl border border-ink-800" data-testid="app-devices">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm" data-testid="app-device">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{device.name}</span>
                <span className="block text-xs text-mist-500">
                  {device.last_seen_at ? t('account.app.seen', { when: formatDate(device.last_seen_at) }) : t('account.app.never')}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void disconnect(device)}
                aria-label={t('account.app.disconnectNamed', { name: device.name })}
                className="rounded-full border border-ink-700 px-3 py-1 text-xs hover:bg-ink-850 disabled:opacity-50"
              >
                {t('account.app.disconnect')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!pairing && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void start()}
          className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
        >
          {t('account.app.connect')}
        </button>
      )}
      {pairing && state && (
        <div className="rounded-xl border border-ink-700 bg-ink-850 p-4" data-testid="app-pairing" data-state={state.state}>
          {state.state === 'connected' ? (
            <p className="text-sm text-ok-500" role="status">
              {t('account.app.connected', { name: state.device })}
            </p>
          ) : state.state === 'expired' ? (
            <p className="text-sm text-mist-300" role="status">
              {t('account.app.expired')}
            </p>
          ) : (
            <div className="flex flex-wrap items-start gap-5">
              <div
                className="w-44 shrink-0 overflow-hidden rounded-lg bg-white p-1"
                role="img"
                aria-label={t('account.app.qr')}
                // Drawn by the server from the pairing's link, nothing else in it.
                dangerouslySetInnerHTML={{ __html: pairing.qr_svg }}
              />
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p className="text-mist-300">{t('account.app.scan')}</p>
                <p className="text-mist-400">{t('account.app.orType')}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="text-mist-500">{t('account.app.address')}</dt>
                  <dd className="break-all font-mono text-xs text-mist-100" data-testid="app-pairing-address">
                    {pairing.address}
                  </dd>
                  <dt className="text-mist-500">{t('account.app.code')}</dt>
                  <dd className="font-mono text-lg tracking-widest text-mist-100" data-testid="app-pairing-code">
                    {pairing.code}
                  </dd>
                </dl>
                <p className="text-xs text-mist-500">{t('account.app.left', { count: minutesLeft(pairing.expires_at, now) })}</p>
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {state.state === 'expired' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  close()
                  void start()
                }}
                className="rounded-full bg-accent-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-400 disabled:opacity-50"
              >
                {t('account.app.again')}
              </button>
            )}
            <button type="button" onClick={close} className="rounded-full border border-ink-700 px-4 py-1.5 text-sm hover:bg-ink-850">
              {state.state === 'waiting' ? t('account.app.cancel') : t('account.app.close')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
