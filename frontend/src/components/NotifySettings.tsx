/**
 * The own notifications (block Z2): where they go (a webhook, always possible; mail, when the operator set up a mail
 * server and the account has an address) and which occasions. Saved at once; the test goes out at once.
 * The webhook address is shown once while typing and afterwards only by its host: it may carry a token.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, notifyApi, type NotifyChoices, type NotifyView } from '../api/client'
import { errorText } from '../lib/errors'
import { Button, Card, Feedback, Toggle } from './settings/ui'

const OCCASIONS = ['mention', 'invite', 'approval', 'tasks'] as const

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function NotifySettings() {
  const { t } = useTranslation()
  const [view, setView] = useState<NotifyView | null>(null)
  const [address, setAddress] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void notifyApi.get().then(setView, (error) => setProblem(errorText(code(error))))
  }, [])

  const save = async (change: { choices?: Partial<NotifyChoices>; webhook?: string }, said: string | null = null) => {
    setProblem(null)
    setDone(null)
    try {
      setView(await notifyApi.save(change))
      setDone(said)
      return true
    } catch (error) {
      setProblem(errorText(code(error)))
      return false
    }
  }

  if (!view) return <Feedback problem={problem} />
  const choose = (key: keyof NotifyChoices, value: boolean | string) => {
    setView({ ...view, choices: { ...view.choices, [key]: value } })
    void save({ choices: { [key]: value } })
  }

  return (
    <>
      <Card id="notify-ways" symbol="globe" title={t('notify.ways')} text={t('notify.waysText')}>
        <div className="space-y-3 text-sm">
          {view.webhook.set ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3" data-testid="notify-webhook">
              <span className="flex-1">{t('notify.webhookTo', { host: view.webhook.host })}</span>
              <Button small danger onClick={() => void save({ webhook: '' }, t('notify.webhookRemoved'))}>
                {t('notify.webhookRemove')}
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void save({ webhook: address }, t('notify.webhookSaved')).then((ok) => ok && setAddress(''))
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="text-xs font-medium text-mist-400">{t('notify.webhook')}</span>
                <input
                  type="url"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="https://example.com/hook"
                  autoComplete="off"
                  className="mt-1 h-9 w-full rounded-lg border border-ink-700 bg-ink-850 px-2"
                />
              </label>
              <Button type="submit" primary>
                {t('notify.webhookSave')}
              </Button>
            </form>
          )}
          <p className="text-xs text-mist-500">{t('notify.webhookHint')}</p>
          <Toggle
            label={t('notify.email')}
            hint={view.email.possible ? t('notify.emailTo', { address: view.email.address }) : view.email.server ? t('notify.emailNoAddress') : t('notify.emailNoServer')}
            checked={view.choices.email && view.email.possible}
            disabled={!view.email.possible}
            onChange={(on) => choose('email', on)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              busy={busy}
              onClick={() => {
                setBusy(true)
                setProblem(null)
                setDone(null)
                void notifyApi
                  .test()
                  .then(
                    (outcome) =>
                      setDone(
                        Object.entries(outcome)
                          .map(([way, how]) => t(`notify.way.${way}`) + ': ' + (how === 'ok' ? t('notify.arrived') : how))
                          .join(' · '),
                      ),
                    (error) => setProblem(errorText(code(error))),
                  )
                  .finally(() => setBusy(false))
              }}
            >
              {t('notify.test')}
            </Button>
          </div>
          <Feedback problem={problem} done={done} />
        </div>
      </Card>
      <Card id="notify-occasions" symbol="info" title={t('notify.occasions')} text={t('notify.occasionsText')}>
        <div className="space-y-2">
          {OCCASIONS.map((occasion) => (
            <Toggle key={occasion} label={t(`notify.occasion.${occasion}`)} hint={t(`notify.occasionHint.${occasion}`)} checked={view.choices[occasion]} onChange={(on) => choose(occasion, on)} />
          ))}
          {view.choices.tasks && (
            <label className="flex items-center justify-between gap-4 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-sm">
              <span className="font-medium">{t('notify.tasksTime')}</span>
              <input
                type="time"
                value={view.choices.tasks_time}
                onChange={(event) => event.target.value && choose('tasks_time', event.target.value)}
                className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1"
              />
            </label>
          )}
          {view.operator && (
            <Toggle label={t('notify.occasion.operator')} hint={t('notify.occasionHint.operator')} checked={view.choices.operator} onChange={(on) => choose('operator', on)} />
          )}
        </div>
      </Card>
    </>
  )
}
