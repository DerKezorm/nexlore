/**
 * Settings → General: the own keys of the account (`lib/shortcuts.ts`), each with the command's name and a way to
 * remove it. They are set in the command palette, where the commands are.
 */
import { useTranslation } from 'react-i18next'

import { DEFAULT_APPEARANCE } from '../../lib/appearance'
import { askPalette } from '../../lib/commands'
import { shownCombo, withKey } from '../../lib/shortcuts'
import { useAuth } from '../../state/auth'
import { Symbol } from '../Symbol'
import { Card } from './ui'

export function KeysCard() {
  const { t, i18n } = useTranslation()
  const { me, setAppearance } = useAuth()
  const own = (me?.appearance ?? DEFAULT_APPEARANCE).keys ?? {}
  const rows = Object.entries(own).sort(([, a], [, b]) => a.label.localeCompare(b.label))

  return (
    <Card symbol="keyboard" title={t('shortcuts.title')} text={t('shortcuts.text')} id="keys">
      {rows.length ? (
        <ul className="grid gap-2" data-testid="own-keys">
          {rows.map(([id, key]) => (
            <li key={id} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2 text-sm" data-command={id}>
              <span className="min-w-0 flex-1 truncate">{key.label}</span>
              <kbd className="shrink-0 rounded border border-ink-700 px-1.5 text-[11px] text-mist-400">{shownCombo(key.combo, undefined, i18n.language)}</kbd>
              <button
                type="button"
                onClick={() => void setAppearance({ keys: withKey(own, id, key.label, null) })}
                aria-label={t('shortcuts.remove', { name: key.label })}
                title={t('shortcuts.remove', { name: key.label })}
                className="rounded-lg p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100"
              >
                <Symbol name="close" className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-mist-500">{t('shortcuts.none')}</p>
      )}
      <button type="button" onClick={askPalette} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-mist-300 hover:bg-ink-850">
        <Symbol name="command" className="h-4 w-4" />
        {t('palette.title')}
      </button>
    </Card>
  )
}
