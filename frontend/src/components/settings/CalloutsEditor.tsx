/**
 * The callouts of a theme in its editor (`lib/callouts.ts`): a kind of Obsidian's gets other colours or another
 * symbol, a kind of the theme's own is added by its name. Each row shows the callout as it will look (the page shows
 * the draft while it is edited).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CALLOUT_ICONS, CALLOUT_SYMBOLS, KIND, MAX_KINDS, type CalloutLook, type Callouts } from '../../lib/callouts'
import { Symbol, type SymbolName } from '../Symbol'

type Props = { callouts: Callouts; mode: 'dark' | 'light'; onChange: (callouts: Callouts) => void }

export function CalloutsEditor({ callouts, mode, onChange }: Props) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState('')
  const kinds = Object.keys(callouts)
  const wanted = adding.trim().toLowerCase()
  const addable = KIND.test(wanted) && !kinds.includes(wanted) && kinds.length < MAX_KINDS
  const change = (kind: string, look: CalloutLook) => onChange({ ...callouts, [kind]: look })

  return (
    <div data-testid="theme-callouts">
      <div className="mb-1 text-[11px] font-semibold tracking-wider text-mist-600 uppercase">{t('themes.callouts.title')}</div>
      <p className="mb-2 text-xs text-mist-500">{t('themes.callouts.text')}</p>
      {kinds.length > 0 && (
        <ul className="nn-prose mb-2 space-y-2">
          {kinds.map((kind) => {
            const look = callouts[kind]
            const icon = look.icon ?? CALLOUT_ICONS[kind] ?? 'pencil'
            return (
              <li key={kind} className="flex flex-wrap items-center gap-2" data-kind={kind}>
                <div className={`nn-callout nn-callout-${kind} !my-0 min-w-40 flex-1`}>
                  <div className="nn-callout-title">{kind}</div>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-mist-400">
                  <input
                    type="color"
                    value={look[mode] ?? '#888888'}
                    onChange={(event) => change(kind, { ...look, [mode]: event.target.value })}
                    aria-label={t('themes.callouts.colour', { kind, mode: t(`looks2.modes.${mode}`) })}
                    className="h-6 w-8 cursor-pointer rounded border border-ink-600 bg-transparent p-0"
                  />
                  {!look[mode] && <span>{t('themes.callouts.asUsual')}</span>}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-mist-400">
                  <Symbol name={icon as SymbolName} className="h-4 w-4" />
                  <select
                    value={look.icon ?? ''}
                    onChange={(event) => change(kind, { ...look, icon: event.target.value || undefined })}
                    aria-label={t('themes.callouts.symbol', { kind })}
                    className="h-7 rounded-lg border border-ink-700 bg-ink-950 px-1.5 text-xs"
                  >
                    <option value="">{t('themes.callouts.asUsual')}</option>
                    {CALLOUT_SYMBOLS.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const rest = { ...callouts }
                    delete rest[kind]
                    onChange(rest)
                  }}
                  aria-label={t('themes.callouts.remove', { kind })}
                  className="rounded p-1 text-mist-500 hover:bg-ink-800 hover:text-mist-100"
                >
                  <Symbol name="close" className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!addable) return
          onChange({ ...callouts, [wanted]: {} })
          setAdding('')
        }}
      >
        <input
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          placeholder={t('themes.callouts.placeholder')}
          aria-label={t('themes.callouts.kind')}
          maxLength={40}
          className="h-8 w-44 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-sm"
        />
        <button type="submit" disabled={!addable} className="rounded-full border border-ink-700 px-3 py-1 text-sm text-mist-300 hover:bg-ink-800 disabled:opacity-40">
          {t('themes.callouts.add')}
        </button>
      </form>
    </div>
  )
}
