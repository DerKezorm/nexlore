/**
 * The operator's latch for the own iPhone app (`app_pairing_allowed`, open from the start): closed, no device gets in
 * any more and no new one can be paired, at once. The paired devices stay and work again when it opens.
 */
import { useTranslation } from 'react-i18next'

import { adminApi, type ServerSettings } from '../../api/client'
import { Card, Feedback, Toggle } from './ui'
import { useAction } from './useAction'

export function AppPairingSwitch({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, app_pairing_allowed: value })
    void run(async () => onChange(await adminApi.saveSettings({ app_pairing_allowed: value }))).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="app-pairing" symbol="phone" title={t('admin.app.title')} text={t('admin.app.text')}>
      <Toggle label={t('admin.app.allow')} hint={t('admin.app.hint')} checked={settings.app_pairing_allowed} onChange={save} />
      <Feedback problem={problem} />
    </Card>
  )
}
