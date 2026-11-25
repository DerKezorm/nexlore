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
import { Box, Button, Buttons, Card, Facts, Notice, Row, Rows } from '../vendor/nexui'

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
    <Card id="devices" icon="Smartphone" title={t('me.app.title')} subtitle={t('me.app.text')} testId="app-devices-card">
      {problem && <Notice tone="danger">{problem}</Notice>}
      {devices && devices.length > 0 && (
        <Rows testId="app-devices">
          {devices.map((device) => (
            <Row
              key={device.id}
              icon="Smartphone"
              name={<span data-testid="app-device-name">{device.name}</span>}
              detail={device.last_seen_at ? t('me.app.seen', { when: formatDate(device.last_seen_at) }) : t('me.app.never')}
              testId="app-device"
              action={
                <Button kind="danger" size="sm" icon="Unlink" disabled={busy} aria-label={t('me.app.disconnectNamed', { name: device.name })} onClick={() => void disconnect(device)}>
                  {t('me.app.disconnect')}
                </Button>
              }
            />
          ))}
        </Rows>
      )}
      {!pairing && (
        <Buttons>
          <Button kind="primary" icon="Smartphone" disabled={busy} onClick={() => void start()} testId="app-connect">
            {t('me.app.connect')}
          </Button>
        </Buttons>
      )}
      {pairing && state && (
        <Box title={t('me.app.connect')} testId="app-pairing-box">
          <div data-testid="app-pairing" data-state={state.state}>
            {state.state === 'connected' ? (
              <p className="m-0 text-sm text-[var(--nexui-ok)]" role="status">
                {t('me.app.connected', { name: state.device })}
              </p>
            ) : state.state === 'expired' ? (
              <p className="m-0 text-sm" role="status">
                {t('me.app.expired')}
              </p>
            ) : (
              <div className="flex flex-wrap items-start gap-5">
                <div
                  className="w-44 shrink-0 overflow-hidden rounded-lg bg-white p-1"
                  role="img"
                  aria-label={t('me.app.qr')}
                  // Drawn by the server from the pairing's link, nothing else in it.
                  dangerouslySetInnerHTML={{ __html: pairing.qr_svg }}
                />
                <div className="min-w-0 flex-1 space-y-2 text-sm">
                  <p className="m-0">{t('me.app.scan')}</p>
                  <p className="m-0 text-[var(--nexui-text-muted)]">{t('me.app.orType')}</p>
                  <Facts
                    items={[
                      { label: t('me.app.address'), value: <span className="font-mono text-xs break-all" data-testid="app-pairing-address">{pairing.address}</span> },
                      { label: t('me.app.code'), value: <span className="font-mono text-lg tracking-widest" data-testid="app-pairing-code">{pairing.code}</span> },
                    ]}
                  />
                  <p className="m-0 text-xs text-[var(--nexui-text-muted)]">{t('me.app.left', { count: minutesLeft(pairing.expires_at, now) })}</p>
                </div>
              </div>
            )}
          </div>
          <Buttons>
            {state.state === 'expired' && (
              <Button
                kind="primary"
                icon="RefreshCw"
                disabled={busy}
                onClick={() => {
                  close()
                  void start()
                }}
              >
                {t('me.app.again')}
              </Button>
            )}
            <Button kind="secondary" icon="X" onClick={close}>
              {state.state === 'waiting' ? t('me.app.cancel') : t('me.app.close')}
            </Button>
          </Buttons>
        </Box>
      )}
    </Card>
  )
}
