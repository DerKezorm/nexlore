/**
 * The calendar subscription: the own open tasks with a date, as an address a calendar app subscribes to. The address
 * holds a key of its own and is shown once, right after it was made; a new one ends the old, "Stop" ends both. On the
 * account page for everyone; the switch for it on the server (`CalendarFeedSwitch`), closed until the operator
 * opens it.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, feedApi, type ServerSettings } from '../../api/client'
import { useAuth } from '../../state/auth'
import { Button, Card, CopyLink, Feedback, Toggle } from './ui'
import { useAction } from './useAction'

export function CalendarFeed() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [state, setState] = useState<{ allowed: boolean; active: boolean } | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const { busy, problem, done, run } = useAction()

  useEffect(() => {
    feedApi.state().then(setState, () => setState({ allowed: false, active: false }))
  }, [])

  const make = () =>
    void run(async () => {
      const made = await feedApi.make()
      setAddress(window.location.origin + made.path)
      setState({ allowed: true, active: true })
    })

  const stop = () =>
    void run(async () => {
      await feedApi.stop()
      setAddress(null)
      setState({ allowed: true, active: false })
    }, t('feed.stopped'))

  return (
    <Card id="calendar" symbol="calendar" title={t('feed.title')} text={t('feed.text')}>
      <div data-testid="calendar-feed">
        {state && !state.allowed && (
          <p className="text-sm text-mist-400">
            {t('feed.closed')} {me?.role === 'operator' && t('feed.closedOperator')}
          </p>
        )}
        {state?.allowed && (
          <>
            {address && (
              <div className="mb-3 space-y-2">
                <CopyLink link={address} label={t('feed.copy')} />
                <p className="text-xs text-mist-400">{t('feed.shownOnce')}</p>
              </div>
            )}
            {!address && <p className="mb-3 text-sm text-mist-400">{state.active ? t('feed.active') : t('feed.none')}</p>}
            <div className="flex flex-wrap gap-2">
              <Button primary={!state.active} busy={busy} onClick={make}>
                {state.active ? t('feed.renew') : t('feed.make')}
              </Button>
              {state.active && (
                <Button danger busy={busy} onClick={stop}>
                  {t('feed.stop')}
                </Button>
              )}
            </div>
          </>
        )}
        <Feedback problem={problem} done={done} />
      </div>
    </Card>
  )
}

/** The operator's switch for the calendar subscriptions of all accounts. */
export function CalendarFeedSwitch({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, calendar_feed_allowed: value })
    void run(async () => onChange(await adminApi.saveSettings({ calendar_feed_allowed: value }))).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="calendar-feed" symbol="calendar" title={t('feed.adminTitle')} text={t('feed.adminText')}>
      <Toggle label={t('feed.allow')} hint={t('feed.allowHint')} checked={settings.calendar_feed_allowed} onChange={save} />
      <Feedback problem={problem} />
    </Card>
  )
}
