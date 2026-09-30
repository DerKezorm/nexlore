/**
 * The operator's switch for the titles of pasted links (`services/linktitle`): open, the server asks the pages whose
 * addresses are pasted into notes for their titles, which tells those pages that someone here pasted them.
 */
import { useTranslation } from 'react-i18next'

import { adminApi, type ServerSettings } from '../../api/client'
import { Card, Feedback, Toggle } from './ui'
import { useAction } from './useAction'

export function LinkTitleSwitch({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { problem, run } = useAction()
  const save = (value: boolean) => {
    onChange({ ...settings, link_titles_allowed: value })
    void run(async () => onChange(await adminApi.saveSettings({ link_titles_allowed: value }))).then((ok) => ok || onChange(settings))
  }
  return (
    <Card id="link-titles" symbol="link" title={t('linkTitles.title')} text={t('linkTitles.text')}>
      <Toggle label={t('linkTitles.allow')} hint={t('linkTitles.hint')} checked={settings.link_titles_allowed} onChange={save} />
      <Feedback problem={problem} />
    </Card>
  )
}
