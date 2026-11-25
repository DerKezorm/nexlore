/**
 * My account › Notifications (block Z2, plan "Einstellungen"): first "Auf welchem Weg" of the ui kit (`NotifyWays`:
 * mail, when the operator set up a mail server and the account has an address, with its tick and the test), then
 * nexlore's own cards: "Worüber du hörst" (the occasions) and "Webhook" (always possible). Saved at once; the test goes
 * out at once. The webhook address is shown once while typing and afterwards only by its host: it may carry a token.
 */
import { Send, Trash2, Webhook } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, notifyApi, type NotifyChoices, type NotifyView } from '../api/client'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'
import { Box, Button as KitButton, NotifyWays } from '../vendor/nexui'
import { Button, Card, Feedback, Input, Toggle } from './settings/ui'

const OCCASIONS = ['mention', 'invite', 'approval', 'tokens', 'tasks'] as const

function code(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

export function NotifySettings() {
  const { t } = useTranslation()
  const { me } = useAuth()
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
  const test = () => {
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
  }

  return (
    <>
      <NotifyWays
        subtitle={t('notify.waysText')}
        mail={view.email.possible ? { address: view.email.address, confirmed: me?.email_proven !== false, href: '/settings/profile#mail' } : undefined}
      >
        <Toggle
          label={t('notify.email')}
          hint={view.email.possible ? t('notify.emailTo', { address: view.email.address }) : view.email.server ? t('notify.emailNoAddress') : t('notify.emailNoServer')}
          checked={view.choices.email && view.email.possible}
          disabled={!view.email.possible}
          onChange={(on) => choose('email', on)}
        />
        {/* Locked, it says where that is changed: the address in the profile, the server with the operator. */}
        {!view.email.possible && (view.email.server || me?.role === 'operator') && (
          <div>
            <KitButton kind="secondary" size="sm" icon="UserPen" href={view.email.server ? '/settings/profile#mail' : '/settings/mail'} testId="notify-mail-fix">
              {t(view.email.server ? 'notify.emailNoAddressLink' : 'notify.emailNoServerLink')}
            </KitButton>
          </div>
        )}
        <div>
          <Button icon={Send} busy={busy} onClick={test} testId="notify-test">
            {t('notify.test')}
          </Button>
        </div>
        <Feedback problem={problem} done={done} />
      </NotifyWays>
      <Card id="notify-occasions" icon="Bell" title={t('notify.occasions')} text={t('notify.occasionsText')}>
        {OCCASIONS.map((occasion) => (
          <Toggle key={occasion} label={t(`notify.occasion.${occasion}`)} hint={t(`notify.occasionHint.${occasion}`)} checked={view.choices[occasion]} onChange={(on) => choose(occasion, on)} />
        ))}
        {view.choices.tasks && (
          <Input label={t('notify.tasksTime')} type="time" value={view.choices.tasks_time} onChange={(value) => value && choose('tasks_time', value)} className="max-w-48" />
        )}
        {view.operator && (
          <Toggle label={t('notify.occasion.operator')} hint={t('notify.occasionHint.operator')} checked={view.choices.operator} onChange={(on) => choose('operator', on)} />
        )}
      </Card>
      <Card id="notify-webhook" icon={Webhook} title={t('notify.webhook')} text={t('notify.webhookHint')}>
        {view.webhook.set ? (
          <Box
            title={t('notify.webhookTo', { host: view.webhook.host })}
            testId="notify-webhook"
            actions={
              <Button small danger icon={Trash2} onClick={() => void save({ webhook: '' }, t('notify.webhookRemoved'))}>
                {t('notify.webhookRemove')}
              </Button>
            }
          />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save({ webhook: address }, t('notify.webhookSaved')).then((ok) => ok && setAddress(''))
            }}
          >
            <Input
              label={t('notify.webhook')}
              type="url"
              value={address}
              onChange={setAddress}
              placeholder="https://example.com/hook"
              action={
                <Button type="submit" primary icon={Webhook}>
                  {t('notify.webhookSave')}
                </Button>
              }
            />
          </form>
        )}
      </Card>
    </>
  )
}
