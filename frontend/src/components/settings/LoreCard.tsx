/**
 * nexlore's own card under Server › KI-Anbieter, below the shared module ki 0.1.0 (`AiProviderArea`): "Frag Lore"
 * for every account, and the model that reads notes in by meaning (vectors; the module asks only for text). The
 * service, the way, the main switch, the hosts in the own network and the brakes are the module's cards above.
 */
import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, aiApi, type AiShared, type ServerSettings } from '../../api/client'
import { AI_PROVIDERS } from '../../lib/aiProviders'
import { useAuth } from '../../state/auth'
import { Button, Card, Feedback, Input, Toggle } from './ui'
import { useAction } from './useAction'

export function LoreCard({ settings, onChange }: { settings: ServerSettings; onChange: (next: ServerSettings) => void }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const { busy, problem, done, run } = useAction()
  const [saved, setSaved] = useState<AiShared | null>(null)
  const [embed, setEmbed] = useState('')
  useEffect(() => {
    aiApi.shared().then((found) => {
      setSaved(found)
      setEmbed(found.embed_model)
    }, () => setSaved(null))
  }, [])
  const saveLore = (value: boolean) => {
    onChange({ ...settings, lore_allowed: value })
    void run(async () => {
      onChange(await adminApi.saveSettings({ lore_allowed: value }))
      await refresh()
    })
  }
  return (
    <Card id="lore" symbol="sparkle" title={t('admin.ai.loreTitle')} text={t('admin.ai.loreText')}>
      <Toggle label={t('admin.ai.loreAllow')} hint={t('admin.ai.loreAllowHint')} checked={settings.lore_allowed} onChange={saveLore} />
      {saved && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          data-testid="ai-embed"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const found = await aiApi.saveShared({ embed_model: embed.trim() })
              setSaved(found)
              setEmbed(found.embed_model)
            }, t('common.saved'))
          }}
        >
          <Input label={t('admin.ai.embedModel')} value={embed} onChange={setEmbed} placeholder={t('admin.ai.embedNone')} hint={t('admin.ai.embedHint')} className="min-w-60 flex-1" />
          <Button busy={busy} type="submit" icon={Save}>
            {t('common.save')}
          </Button>
          {AI_PROVIDERS.some((provider) => provider.url === saved.url && !provider.embeddings) && (
            <p className="m-0 w-full text-xs text-warn-500" data-testid="ai-embed-none">{t('admin.ai.embedNotHere')}</p>
          )}
          {saved.meaning_on && (
            <p className="m-0 w-full text-xs text-accent-400" data-testid="ai-meaning-progress">
              {t('admin.ai.embedProgress', { done: saved.meaning.done, total: saved.meaning.total })}
            </p>
          )}
        </form>
      )}
      <Feedback problem={problem} done={done} />
    </Card>
  )
}
