/**
 * Settings → General: the view a note opens in for editing, for the own account (design answer 05.10.2026: some write
 * Markdown directly, others want the visual editor). The switch in the toolbar still changes it for the note at hand.
 */
import { useTranslation } from 'react-i18next'

import { DEFAULT_APPEARANCE } from '../../lib/appearance'
import { useAuth } from '../../state/auth'
import { Card } from './ui'

export function EditorCard() {
  const { t } = useTranslation()
  const { me, setAppearance } = useAuth()
  const chosen = (me?.appearance ?? DEFAULT_APPEARANCE).editor ?? 'visual'
  return (
    <Card symbol="pencil" title={t('editorView.title')} text={t('editorView.text')} id="editor">
      <div className="grid gap-2" role="radiogroup" aria-label={t('editorView.title')}>
        {(['visual', 'source'] as const).map((view) => (
          <label key={view} className="flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm">
            <input type="radio" name="editor-view" checked={chosen === view} onChange={() => void setAppearance({ editor: view })} className="mt-1 accent-accent-500" />
            <span className="flex-1">
              <span className="block">{t(`editorView.${view}`)}</span>
              <span className="block text-xs text-mist-500">{t(`editorView.${view}Hint`)}</span>
            </span>
          </label>
        ))}
      </div>
    </Card>
  )
}
